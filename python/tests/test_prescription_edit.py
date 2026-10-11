"""Audited pharmacist Rx editing regression tests; synthetic data only."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from pharmacy1os.api import create_app
from pharmacy1os.models import Prescription
from pharmacy1os.prescription_edit import PrescriptionEditService
from pharmacy1os.scheduling import SchedulingService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def site():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "RxEdit")
    other_patient = svc.add_patient(tech, "Synthetic", "Patient2")
    doctor = svc.add_prescriber(tech, "Original", "Prescriber", "MD")
    other_doctor = svc.add_prescriber(tech, "New", "Prescriber", "MD")
    drug = svc.add_drug(pharmacist, "Test drug", "5mg", "tablet")
    other_drug = svc.add_drug(pharmacist, "Different drug", "5mg", "tablet")
    product = svc.add_product(pharmacist, drug, "00000-2211-01", "Demo", "Green tablet")
    other_product = svc.add_product(pharmacist, other_drug, "00000-2211-02", "Demo", "Yellow tablet")
    rx = svc.add_prescription(tech, patient, doctor, drug, "RX-EDIT-001",
        "one tablet daily", "30", refills=2, source_type="PAPER",
        written_date=date.today().isoformat())
    return svc, a, outside, rx, drug, product, other_drug, other_product, other_doctor


def update(edit, actor, rx, changes, *, version=0, note="Confirmed synthetic prescriber discussion"):
    return edit.update(actor, rx, changes, expected_version=version, attestation_note=note)


def test_pharmacist_multi_field_edit_is_versioned_and_resets_dur_review(site):
    svc, a, other, rx, drug, product, drug2, product2, doc2 = site
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    editor = PrescriptionEditService(svc)
    changed = update(editor, a["PHARMACIST"], rx,
        {"sig": "Take twice daily", "quantity": "60", "prescriber_id": doc2,
         "product_selection_directive": "DISPENSE_AS_WRITTEN",
         "prescribed_product_id": product})
    assert changed["version"] == 1
    assert changed["status"] == "DATA_ENTRY"
    assert changed["changed"]["quantity"]["before"] == "30.000"
    assert changed["changed"]["quantity"]["after"] == "60"
    assert editor.history(a["AUDITOR"], rx)[0]["actor_id"] == a["PHARMACIST"].id
    with svc.sessions() as s:
        obj = s.get(Prescription, rx)
        assert obj.version == 1
        assert obj.sig == "Take twice daily"
        assert obj.quantity == 60
        assert obj.source_type == "PAPER" and obj.electronic_raw_message is None
        assert obj.prescribed_product_id == product
        assert obj.product_selection_directive == "DISPENSE_AS_WRITTEN"
    with pytest.raises(WorkflowError, match="version changed"):
        update(editor, a["PHARMACIST"], rx, {"sig": "Outdated"}, version=0)
    assert len(editor.history(a["AUDITOR"], rx)) == 1
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    fid = svc.start_fill(a["TECHNICIAN"], rx)
    assert fid
    with pytest.raises(WorkflowError, match="unfilled|history"):
        update(editor, a["PHARMACIST"], rx, {"sig": "After start"}, version=1)


def test_technician_cannot_edit_or_view_out_of_site_and_source_immutable(site):
    svc, a, outsider, rx, drug, product, drug2, product2, doc2 = site
    editor = PrescriptionEditService(svc)
    with pytest.raises(AccessDenied):
        update(editor, a["TECHNICIAN"], rx, {"sig": "No permission"})
    with pytest.raises(WorkflowError, match="Unsupported"):
        update(editor, a["PHARMACIST"], rx, {"source_type": "FAX"})
    with pytest.raises(WorkflowError, match="Unsupported"):
        update(editor, a["PHARMACIST"], rx, {"electronic_raw_message": "NEVER"})
    with pytest.raises(WorkflowError, match="no changed values"):
        update(editor, a["PHARMACIST"], rx, {"sig": "one tablet daily"})
    with pytest.raises(WorkflowError, match="pharmacy site"):
        update(editor, outsider["PHARMACIST"], rx, {"sig": "Forbidden"})
    with pytest.raises(WorkflowError, match="pharmacy site"):
        editor.history(outsider["AUDITOR"], rx)


def test_daw_requires_selected_product_and_drug_association(site):
    svc, a, outsider, rx, drug, product, drug2, product2, doc2 = site
    editor = PrescriptionEditService(svc)
    with pytest.raises(WorkflowError, match="exact product"):
        update(editor, a["PHARMACIST"], rx,
               {"product_selection_directive": "DISPENSE_AS_WRITTEN"})
    with pytest.raises(WorkflowError, match="under the selected drug"):
        update(editor, a["PHARMACIST"], rx, {"prescribed_product_id": product2})
    changed = update(editor, a["PHARMACIST"], rx,
        {"product_selection_directive": "DISPENSE_AS_WRITTEN",
         "prescribed_product_id": product})
    assert changed["version"] == 1
    with pytest.raises(WorkflowError, match="under the selected drug"):
        update(editor, a["PHARMACIST"], rx,
               {"drug_id": drug2}, version=1)
    changed2 = update(editor, a["PHARMACIST"], rx,
        {"drug_id": drug2, "prescribed_product_id": product2}, version=1)
    assert changed2["version"] == 2


def test_date_validation_and_scheduled_fill_guard(site):
    svc, a, outsider, rx, drug, product, drug2, product2, doc2 = site
    editor = PrescriptionEditService(svc)
    with pytest.raises(WorkflowError, match="Invalid written_date"):
        update(editor, a["PHARMACIST"], rx, {"written_date": "2026-02-30"})
    with pytest.raises(WorkflowError, match="Written date cannot be in the future"):
        update(editor, a["PHARMACIST"], rx, {"written_date": "2999-01-01"})
    with pytest.raises(WorkflowError, match="predates"):
        update(editor, a["PHARMACIST"], rx, {
            "written_date": "2026-01-05", "expiration_date": "2026-01-04"})
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    due = (date.today() + timedelta(days=7)).isoformat()
    schedule = SchedulingService(svc).schedule(
        a["TECHNICIAN"], rx, due, "SYNTH-EDIT-SCHED")
    with pytest.raises(WorkflowError, match="pending future fills"):
        update(editor, a["PHARMACIST"], rx, {"sig": "Reviewed"})
    SchedulingService(svc).cancel(a["TECHNICIAN"], schedule, "Edit needed")
    changed = update(editor, a["PHARMACIST"], rx, {"sig": "Reviewed"})
    assert changed["status"] == "DATA_ENTRY"


def test_api_requires_real_role_checks_and_returns_history(site):
    svc, a, outsider, rx, drug, product, drug2, product2, doc2 = site
    client = TestClient(create_app(svc, synthetic_enabled=True))
    route = f"/api/prescriptions/{rx}"
    payload = {
        "changes": {"sig": "Take at bedtime"},
        "expected_version": 0,
        "attestation_note": "Synthetic clinical authorization reviewed",
    }
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    pharm = {"x-demo-staff-id": a["PHARMACIST"].id}
    assert client.patch(route, headers=tech, json=payload).status_code == 403
    assert client.patch(route, json=payload).status_code == 403
    response = client.patch(route, headers=pharm, json=payload)
    assert response.status_code == 200
    assert response.json()["version"] == 1
    assert client.patch(route, headers=pharm, json=payload).status_code == 409
    events = client.get(f"{route}/edits", headers=tech)
    assert events.status_code == 200
    assert len(events.json()["edits"]) == 1
    assert client.get(f"{route}/edits",
        headers={"x-demo-staff-id": outsider["AUDITOR"].id}).status_code == 409
    assert client.get(route, headers=tech).json()["sig"] == "Take at bedtime"
