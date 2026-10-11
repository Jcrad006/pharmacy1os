"""Synthetic-only NTI manufacturer continuity and pharmacist consent regression."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.models import Audit, Fill, FillSource, Product, Stock
from pharmacy1os.nti_compliance import NtiComplianceService, NtiManufacturerConsent
from pharmacy1os.scheduling import SchedulingService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "NTISubject")
    prescriber = svc.add_prescriber(tech, "Demo", "Clinician", "MD")
    drug = svc.add_drug(pharmacist, "Synthetic narrow therapeutic index",
        "5 mg", "tablet", nc_narrow_therapeutic_index=True)
    products = []
    exp = (date.today() + timedelta(days=730)).isoformat()
    for index, manufacturer, te in (
            (1, "Maker A", "AB"), (2, "maker a", "AB"),
            (3, "Maker B", "AB"), (4, "Maker A", "BX")):
        ndc = f"12345-7810-0{index}"
        barcode = f"NTI-BAR-{index}"
        lot = f"LOT-NTI-{index}"
        product = svc.add_product(pharmacist, drug, ndc, manufacturer,
            f"Demo {manufacturer} 5 mg", therapeutic_equivalence_code=te)
        svc.register_barcode(tech, product, barcode)
        stock = svc.receive(tech, barcode, lot, exp, "120")
        products.append({"id": product, "barcode": barcode,
                         "lot": lot, "stock": stock, "manufacturer": manufacturer})
    rx = svc.add_prescription(tech, patient, prescriber, drug, "RX-NTI-001",
        "one tablet daily", "30", refills=3)
    svc.advance_to_dur(tech, rx)
    return svc, a, other, rx, products, exp, NtiComplianceService(svc)


def _source(env, fid, index, quantity="30"):
    svc, a, other, rx, products, exp, compliance = env
    p = products[index]
    return svc.scan_source(a["TECHNICIAN"], fid, p["barcode"], p["lot"], exp, quantity)


def _sell(env, fid):
    svc, a, other, rx, products, exp, compliance = env
    svc.prepare_for_review(a["TECHNICIAN"], fid, [])
    svc.verify(a["PHARMACIST"], fid)
    svc.sell(a["CASHIER"], fid, True, True, "0", "CASH")


def _consent_times():
    return datetime.now(timezone.utc).isoformat()


def test_initial_nti_and_same_manufacturer_lots_no_consent(env):
    svc, a, other, rx, products, exp, compliance = env
    fid = svc.start_fill(a["TECHNICIAN"], rx)
    _source(env, fid, 0, "12")
    _source(env, fid, 1, "18")
    assert compliance.preview(a["AUDITOR"], fid)["prior_manufacturer"] is None
    _sell(env, fid)
    with svc.sessions() as s:
        assert s.get(Fill, fid).status == "SOLD"
    assert len(compliance.preview(a["AUDITOR"], fid)["documented_changes"]) == 0


def test_split_manufacturer_and_therapeutic_equivalence_rejected_before_reservation(env):
    svc, a, other, rx, products, exp, compliance = env
    fid = svc.start_fill(a["TECHNICIAN"], rx)
    _source(env, fid, 0, "10")
    with pytest.raises(WorkflowError, match="split-manufacturer"):
        _source(env, fid, 2, "10")
    with pytest.raises(WorkflowError, match="therapeutic-equivalence"):
        _source(env, fid, 3, "10")
    with svc.sessions() as s:
        stock_b = s.get(Stock, products[2]["stock"])
        stock_bad = s.get(Stock, products[3]["stock"])
        assert stock_b.reserved == 0 and stock_bad.reserved == 0
        assert len(s.scalars(select(FillSource).where(FillSource.fill_id == fid)).all()) == 1


def test_nti_manufacturer_switch_requires_two_documented_consents(env):
    svc, a, other, rx, products, exp, compliance = env
    first = svc.start_fill(a["TECHNICIAN"], rx)
    _source(env, first, 0)
    _sell(env, first)
    SchedulingService(svc).begin_refill_review(a["TECHNICIAN"], rx,
        "Synthetic NTI refill review")
    second = svc.start_fill(a["TECHNICIAN"], rx)
    with pytest.raises(WorkflowError, match="documented prescriber and patient consent"):
        _source(env, second, 2)
    preview = compliance.preview(a["TECHNICIAN"], second)
    assert preview["prior_manufacturer"] == "maker a"
    assert "maker b" in preview["active_manufacturers"]
    with pytest.raises(AccessDenied):
        compliance.document(a["TECHNICIAN"], second, "maker a", "maker b",
            _consent_times(), _consent_times(), "Technician cannot attest this")
    with pytest.raises(WorkflowError, match="pharmacy site"):
        compliance.document(other["PHARMACIST"], second, "maker a", "maker b",
            _consent_times(), _consent_times(), "Another site cannot attest")
    timestamp = _consent_times()
    item = compliance.document(a["PHARMACIST"], second,
        "Maker A", "MAKER B", timestamp, timestamp,
        "Prescriber and patient both contacted; consent affirmatively documented")
    assert item["prior_manufacturer"] == "maker a"
    assert item["new_manufacturer"] == "maker b"
    assert len(compliance.preview(a["AUDITOR"], second)["documented_changes"]) == 1
    with pytest.raises(WorkflowError, match="already documented"):
        compliance.document(a["PHARMACIST"], second, "maker a", "maker b",
            timestamp, timestamp, "Duplicate documentation is not permitted")
    _source(env, second, 2)
    _sell(env, second)
    with svc.sessions() as s:
        row = s.scalar(select(NtiManufacturerConsent).where(
            NtiManufacturerConsent.fill_id == second))
        assert row.documented_by_id == a["PHARMACIST"].id
        event = s.scalar(select(Audit).where(
            Audit.kind == "NC_NTI_MANUFACTURER_CHANGE_CONSENT_DOCUMENTED"))
        assert event is not None
        assert item["note"] not in event.detail


def test_unverified_historical_sale_and_bad_timestamps_fail_closed(env):
    svc, a, other, rx, products, exp, compliance = env
    first = svc.start_fill(a["TECHNICIAN"], rx)
    _source(env, first, 0)
    _sell(env, first)
    SchedulingService(svc).begin_refill_review(a["TECHNICIAN"], rx, "Refill review")
    next_fill = svc.start_fill(a["TECHNICIAN"], rx)
    now = _consent_times()
    for bad in ("not-a-timestamp", "2026-01-01T10:00:00", "2999-01-01T00:00:00Z"):
        with pytest.raises(WorkflowError):
            compliance.document(a["PHARMACIST"], next_fill,
                "Maker A", "Maker B", bad, now, "Both consents confirmed verbally")
    prior_day = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    with pytest.raises(WorkflowError, match="most recent sold therapy"):
        compliance.document(a["PHARMACIST"], next_fill,
            "Maker A", "Maker B", prior_day, now,
            "Consent before prior sale cannot authorize this future refill")
    with pytest.raises(WorkflowError, match="prior manufacturer"):
        compliance.document(a["PHARMACIST"], next_fill,
            "Wrong", "Maker B", now, now, "Invented prior manufacturer not permitted")


def test_api_nti_site_role_and_disabled_gate(env):
    svc, a, other, rx, products, exp, compliance = env
    fid = svc.start_fill(a["TECHNICIAN"], rx)
    api = TestClient(create_app(svc, synthetic_enabled=True))
    path = f"/api/fills/{fid}"
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    pharmacist = {"x-demo-staff-id": a["PHARMACIST"].id}
    doc = {"prior_manufacturer": "Maker A", "new_manufacturer": "Maker B",
           "prescriber_consent_at": _consent_times(),
           "patient_consent_at": _consent_times(),
           "note": "Documented synthetic consents of both parties"}
    assert api.get(path + "/nti-compliance", headers=tech).status_code == 200
    assert api.post(path + "/nti-manufacturer-consent",
        json=doc, headers=tech).status_code == 403
    assert api.post(path + "/nti-manufacturer-consent",
        json=doc, headers=pharmacist).status_code == 409  # no prior SOLD therapy
    assert api.get(path + "/nti-compliance",
        headers={"x-demo-staff-id": other["AUDITOR"].id}).status_code == 409
    assert TestClient(create_app(svc, synthetic_enabled=False)).get(
        path + "/nti-compliance", headers=tech).status_code == 503


def test_biologic_cold_chain_controlled_remain_blocked():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Demo", "Specialized")
    doc = svc.add_prescriber(tech, "Demo", "Authorizer", "MD")
    for key, flags in (
            ("biologic", {"is_biological": True}),
            ("cold", {"requires_cold_chain": True}),
            ("controlled", {"controlled": True})):
        drug = svc.add_drug(pharm, key, "5 mg", "tablet", **flags)
        if key == "controlled":
            with pytest.raises(WorkflowError, match="Controlled"):
                svc.add_prescription(tech, patient, doc, drug, "RX-CTRL",
                    "daily", "30")
            continue
        rx = svc.add_prescription(tech, patient, doc, drug,
            f"RX-{key}", "daily", "30")
        svc.advance_to_dur(tech, rx)
        with pytest.raises(WorkflowError, match="Biologic|Cold-chain"):
            svc.start_fill(tech, rx)
