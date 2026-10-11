"""Synthetic-only per-fill billing parity and guard tests."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.billing import BillingService
from pharmacy1os.fill_billing_details import FillBillingDetailService
from pharmacy1os.models import Audit, Fill
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "Billing")
    doctor = svc.add_prescriber(tech, "Fictional", "Doctor", "MD")
    drug = svc.add_drug(pharm, "Demo billing drug", "1mg", "tablet")
    products = []
    expiry = (date.today() + timedelta(days=210)).isoformat()
    for n in (1, 2):
        pid = svc.add_product(pharm, drug, f"12345-1111-0{n}", f"Manufacturer {n}", f"Tablet {n}")
        products.append(pid)
        svc.register_barcode(tech, pid, f"FB-TEST-{n}")
        svc.receive(tech, f"FB-TEST-{n}", f"LOT-{n}", expiry, "100")
    other_drug = svc.add_drug(pharm, "Unrelated med", "2mg", "tablet")
    wrong = svc.add_product(pharm, other_drug, "12345-1111-03", "Other", "Other tablet")
    unscanned = svc.add_product(pharm, drug, "12345-1111-04", "Other", "Unscanned tablet")
    rx = svc.add_prescription(tech, patient, doctor, drug, "SYN-BILL-40", "once daily", "90")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, "30", days_supply=30)
    svc.scan_source(tech, fill, "FB-TEST-1", "LOT-1", expiry, "20")
    svc.scan_source(tech, fill, "FB-TEST-2", "LOT-2", expiry, "10")
    return svc, a, other, rx, fill, products, wrong, unscanned


def test_selected_minority_ndc_is_used_in_sandbox_claim_snapshot(case):
    svc, a, other, rx, fill, products, wrong, unscanned = case
    billing = FillBillingDetailService(svc)
    result = billing.update(a["TECHNICIAN"], fill, {"days_supply": 15, "billing_product_id": products[1]})
    assert (result["days_supply"], result["physical_quantity"], result["billed_quantity"]) == (15, "30.000", "90.000")
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Sandbox Payer"])
    operation = BillingService(svc).history(a["TECHNICIAN"], fill)[0]
    assert operation["selected_ndc"] == "12345-1111-02"
    assert operation["source_snapshot"]["days_supply"] == 15
    assert operation["source_snapshot"]["selected_billing_product_id"] == products[1]
    with pytest.raises(WorkflowError, match="after Product Fill"):
        billing.update(a["TECHNICIAN"], fill, {"days_supply": 20})
    with svc.sessions() as s:
        assert s.get(Fill, fill).days_supply == 15
        assert len(s.scalars(select(Audit).where(Audit.kind == "FILL_BILLING_DETAILS_UPDATED")).all()) == 1


def test_validation_role_and_site_guards(case):
    svc, a, other, rx, fill, products, wrong, unscanned = case
    billing = FillBillingDetailService(svc)
    for value in (0, True, None, "30", -2):
        with pytest.raises(WorkflowError, match="positive whole"):
            billing.update(a["TECHNICIAN"], fill, {"days_supply": value})
    with pytest.raises(WorkflowError, match="does not match"):
        billing.update(a["TECHNICIAN"], fill, {"billing_product_id": wrong})
    with pytest.raises(WorkflowError, match="scanned physical"):
        billing.update(a["TECHNICIAN"], fill, {"billing_product_id": unscanned})
    with pytest.raises(WorkflowError, match="Provide"):
        billing.update(a["TECHNICIAN"], fill, {"other": "invalid"})
    with pytest.raises(WorkflowError, match="no changed values"):
        billing.update(a["TECHNICIAN"], fill, {"days_supply": 30})
    with pytest.raises(AccessDenied):
        billing.update(a["AUDITOR"], fill, {"days_supply": 14})
    with pytest.raises(WorkflowError, match="pharmacy site"):
        billing.update(other["TECHNICIAN"], fill, {"days_supply": 14})
    assert billing.update(a["INTERN"], fill, {"days_supply": 14})["days_supply"] == 14


def test_source_change_rechecks_explicit_billing_product(case):
    svc, a, other, rx, fill, products, wrong, unscanned = case
    billing = FillBillingDetailService(svc)
    billing.update(a["TECHNICIAN"], fill, {"billing_product_id": products[1]})
    source = next(x for x in svc.scanned_sources(a["TECHNICIAN"], fill)
                  if x["product_id"] == products[1])
    with pytest.raises(WorkflowError, match="Clear the selected"):
        svc.remove_scanned_source(a["TECHNICIAN"], fill, source["id"],
                                  "Correct synthetic scanned source inventory")
    billing.update(a["TECHNICIAN"], fill, {"billing_product_id": None})
    svc.remove_scanned_source(a["TECHNICIAN"], fill, source["id"],
                              "Correct synthetic scanned source inventory")


def test_api_and_detail_contract(case):
    svc, a, other, rx, fill, products, wrong, unscanned = case
    client = TestClient(create_app(svc, synthetic_enabled=True))
    path = f"/api/fills/{fill}/billing-details"
    headers = {"x-demo-staff-id": a["TECHNICIAN"].id}
    assert client.put(path, json={"days_supply": 12}).status_code == 403
    assert client.put(path, headers=headers, json={}).status_code == 409
    response = client.put(path, headers=headers, json={"days_supply": 12, "billing_product_id": products[0]})
    assert response.status_code == 200, response.text
    detail = client.get(f"/api/prescriptions/{rx}", headers=headers)
    assert detail.status_code == 200
    fill_detail = detail.json()["prescription"]["fills"][0]
    assert fill_detail["daysSupply"] == 12
    assert fill_detail["billingProductId"] == products[0]


def test_start_rejects_invalid_days_supply():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Start", "Demo")
    doctor = svc.add_prescriber(tech, "Start", "Doctor", "MD")
    drug = svc.add_drug(pharm, "Start Demo", "1 mg", "tablet")
    rx = svc.add_prescription(tech, patient, doctor, drug, "SYN-START-40", "one daily", "30")
    svc.advance_to_dur(tech, rx)
    for value in (0, True, "30", -3):
        with pytest.raises(WorkflowError, match="positive whole"):
            svc.start_fill(tech, rx, days_supply=value)
    assert svc.start_fill(tech, rx, days_supply=30)
