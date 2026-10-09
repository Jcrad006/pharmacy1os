"""Original-container packaging metadata and synthetic patient discard date."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.models import Audit, Fill, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    drug = svc.add_drug(actors["PHARMACIST"], "Synthetic packaging", "10 mg", "tablet")
    product = svc.add_product(actors["PHARMACIST"], drug,
                              "40000-0808-01", "Demo", "Synthetic white tablet")
    svc.register_barcode(actors["TECHNICIAN"], product, "PKG-BC-1")
    expiry = (date.today() + timedelta(days=200)).isoformat()
    svc.receive(actors["TECHNICIAN"], "PKG-BC-1", "LOT-PKG", expiry, "100")
    patient = svc.add_patient(actors["TECHNICIAN"], "Synthetic", "Packaging")
    prescriber = svc.add_prescriber(actors["TECHNICIAN"], "Synthetic", "Doctor", "MD")
    rx = svc.add_prescription(actors["TECHNICIAN"], patient, prescriber,
                              drug, "RX-PKG-1", "One tablet daily", "30")
    svc.advance_to_dur(actors["TECHNICIAN"], rx)
    fill = svc.start_fill(actors["TECHNICIAN"], rx)
    return svc, actors, other, fill, expiry


def test_repackaged_dispense_uses_earliest_manufacturer_expiry(env):
    svc, a, other, fill, expiry = env
    tech = a["TECHNICIAN"]
    result = svc.set_fill_packaging(tech, fill,
        dispensed_in_original_container=False,
        note="Pharmacy will dispense in child-resistant prescription vial")
    assert result["patient_discard_date"] is None
    svc.scan_source(tech, fill, "PKG-BC-1", "LOT-PKG", expiry, "30")
    svc.prepare_for_review(tech, fill, [])
    svc.verify(a["PHARMACIST"], fill)
    with svc.sessions() as s:
        row = s.get(Fill, fill)
        assert row.patient_discard_date == expiry
        assert row.dispensed_in_original_container is False
        assert row.packaging_reviewed_by_id == tech.id
        assert s.scalar(select(Audit.id).where(Audit.kind == "FILL_PACKAGING_STATUS_UPDATED")) is not None
    with pytest.raises(WorkflowError, match="Product Fill"):
        svc.set_fill_packaging(tech, fill, dispensed_in_original_container=True,
            note="This decision cannot be changed after verification")


def test_original_container_has_no_synthetic_patient_discard(env):
    svc, a, other, fill, expiry = env
    tech = a["TECHNICIAN"]
    svc.set_fill_packaging(tech, fill, dispensed_in_original_container=True,
        note="Bottle remains sealed in the original manufacturer packaging")
    svc.scan_source(tech, fill, "PKG-BC-1", "LOT-PKG", expiry, "30")
    svc.prepare_for_review(tech, fill, [])
    svc.verify(a["PHARMACIST"], fill)
    with svc.sessions() as s:
        f = s.get(Fill, fill)
        assert f.dispensed_in_original_container is True
        assert f.patient_discard_date is None


def test_packaging_site_permission_and_type_validation(env):
    svc, a, other, fill, expiry = env
    with pytest.raises(AccessDenied):
        svc.set_fill_packaging(a["AUDITOR"], fill, dispensed_in_original_container=False,
            note="Auditor cannot alter pharmacy packaging status")
    with pytest.raises(WorkflowError, match="site"):
        svc.set_fill_packaging(other["TECHNICIAN"], fill,
            dispensed_in_original_container=False,
            note="Cross-site packaging changes are prohibited")
    with pytest.raises(WorkflowError, match="true or false"):
        svc.set_fill_packaging(a["TECHNICIAN"], fill,
            dispensed_in_original_container="false",
            note="Boolean string cannot be accepted as a verified declaration")


def test_packaging_api_optin_and_authenticated_actor(env):
    svc, a, other, fill, expiry = env
    path = f"/api/fills/{fill}/packaging"
    payload = {"dispensed_in_original_container": True,
               "note": "Verified sealed manufacturer bottle used for dispensing"}
    header = {"x-demo-staff-id": a["TECHNICIAN"].id}
    assert TestClient(create_app(svc, synthetic_enabled=False)).put(
        path, json=payload, headers=header).status_code == 503
    api = TestClient(create_app(svc, synthetic_enabled=True))
    assert api.put(path, json=payload,
        headers={"x-demo-staff-id": other["TECHNICIAN"].id}).status_code == 409
    ok = api.put(path, json=payload, headers=header)
    assert ok.status_code == 200 and ok.json()["dispensed_in_original_container"] is True
    assert api.put(path, json={**payload, "dispensed_in_original_container": "not-bool"},
        headers=header).status_code == 422
