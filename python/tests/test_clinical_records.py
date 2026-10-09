"""Pharmacist intervention ledger and original-inspired clinical record API."""
from datetime import date
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.clinical_records import ClinicalRecordService, InterventionNote
from pharmacy1os.models import Audit
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    foreign = svc.bootstrap_demo()["actors"]
    patient = svc.add_patient(a["TECHNICIAN"], "Synthetic", "ClinicalNote")
    doctor = svc.add_prescriber(a["TECHNICIAN"], "Synthetic", "Doctor", "MD")
    drug = svc.add_drug(a["PHARMACIST"], "Demo clinical drug", "10 mg", "tablet")
    rx = svc.add_prescription(a["TECHNICIAN"], patient, doctor, drug,
        "RX-CLIN-NOTE-1", "one daily", "30")
    return svc, a, foreign, rx, ClinicalRecordService(svc)


def test_intervention_note_immutable_from_service_and_distinct_from_dur(env):
    svc, a, foreign, rx, clinical = env
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    issue = svc.add_dur_issue(a["PHARMACIST"], rx, "HIGH", "TEST_INTERACTION")
    note = "Prescriber contacted about a possible interaction; follow-up documented."
    entry = clinical.record_intervention(a["PHARMACIST"], rx, note)
    assert entry["note"] == note
    assert entry["author"]["role"] == "PHARMACIST"
    record = clinical.clinical_record(a["AUDITOR"], rx)
    assert len(record["interventions"]) == 1
    assert record["interventions"][0]["id"] == entry["id"]
    assert len(record["issues"]) == 1
    assert record["issues"][0]["status"] == "OPEN"
    # Free text alone cannot resolve a DUR issue.
    with svc.sessions() as s:
        event = s.scalar(select(Audit).where(
            Audit.kind == "PHARMACIST_INTERVENTION_RECORDED"))
        assert event is not None
        assert note not in event.detail
        assert s.query(InterventionNote).count() == 1
    svc.resolve_dur(a["PHARMACIST"], issue,
        "Manually confirmed in independent DUR process")
    assert clinical.clinical_record(a["AUDITOR"], rx)["issues"][0]["status"] == "RESOLVED"
    assert clinical.clinical_record(a["AUDITOR"], rx)["interventions"][0]["note"] == note


def test_role_site_and_note_validation(env):
    svc, a, foreign, rx, clinical = env
    with pytest.raises(AccessDenied):
        clinical.record_intervention(a["TECHNICIAN"], rx,
                                     "Technicians cannot make pharmacist intervention attestations")
    with pytest.raises(AccessDenied):
        clinical.record_intervention(a["AUDITOR"], rx, "Read only role cannot create notes")
    with pytest.raises(WorkflowError, match="pharmacy site"):
        clinical.record_intervention(foreign["PHARMACIST"], rx,
            "A separate pharmacy may not write clinical documentation")
    with pytest.raises(WorkflowError, match="pharmacy site"):
        clinical.clinical_record(foreign["AUDITOR"], rx)
    with pytest.raises(WorkflowError, match="1–4000"):
        clinical.record_intervention(a["PHARMACIST"], rx, "   ")
    with pytest.raises(WorkflowError, match="1–4000"):
        clinical.record_intervention(a["PHARMACIST"], rx, "x" * 4001)


def test_multiple_notes_preserve_authorship_and_original_content(env):
    svc, a, foreign, rx, clinical = env
    first = clinical.record_intervention(a["PHARMACIST"], rx,
        "Clinical assessment discussed with prescriber in synthetic example")
    second = clinical.record_intervention(a["PHARMACIST"], rx,
        "Additional documented clarification from prescriber in synthetic example")
    assert first["id"] != second["id"]
    history = clinical.clinical_record(a["PHARMACIST"], rx)["interventions"]
    assert {row["note"] for row in history} == {
        first["note"], second["note"],
    }
    assert all(row["author_id"] == a["PHARMACIST"].id for row in history)
    with svc.sessions() as s:
        assert len(s.scalars(select(InterventionNote)).all()) == 2


def test_clinical_api_original_paths_and_demo_only_gate(env):
    svc, a, foreign, rx, clinical = env
    api = TestClient(create_app(svc, synthetic_enabled=True))
    route = f"/api/prescriptions/{rx}"
    payload = {"note": "Documented pharmacist consultation on synthetic prescription"}
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    pharm = {"x-demo-staff-id": a["PHARMACIST"].id}
    assert api.get(route + "/clinical", headers=tech).status_code == 200
    assert api.post(route + "/interventions", json=payload, headers=tech).status_code == 403
    assert api.post(route + "/interventions", json=payload,
        headers={"x-demo-staff-id": foreign["PHARMACIST"].id}).status_code == 409
    assert api.post(route + "/interventions",
        json={"note": " "}, headers=pharm).status_code == 409
    created = api.post(route + "/interventions", json=payload, headers=pharm)
    assert created.status_code == 201
    assert created.json()["intervention"]["note"] == payload["note"]
    record = api.get(route + "/clinical", headers=tech)
    assert record.status_code == 200
    assert record.json()["interventions"][0]["id"] == created.json()["intervention"]["id"]
    assert api.get(route + "/clinical",
        headers={"x-demo-staff-id": foreign["AUDITOR"].id}).status_code == 409
    assert TestClient(create_app(svc, synthetic_enabled=False)).post(
        route + "/interventions", headers=pharm, json=payload).status_code == 503
