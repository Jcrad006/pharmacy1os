"""Original-style manual DUR issues and pharmacist resolution provenance."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.clinical_records import ClinicalRecordService
from pharmacy1os.models import Audit, DUR
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    service = PharmacyService()
    service.create_schema()
    a = service.bootstrap_demo()["actors"]
    foreign = service.bootstrap_demo()["actors"]
    patient = service.add_patient(a["TECHNICIAN"], "Synthetic", "DURClinical")
    provider = service.add_prescriber(a["TECHNICIAN"], "Demo", "Prescriber", "MD")
    drug = service.add_drug(a["PHARMACIST"], "DUR training drug", "5 mg", "tablet")
    rx = service.add_prescription(a["TECHNICIAN"], patient, provider, drug,
        "RX-DUR-PARITY-01", "one tablet daily", "30")
    service.advance_to_dur(a["TECHNICIAN"], rx)
    return service, a, foreign, rx, ClinicalRecordService(service)


def test_original_severity_source_and_resolution_author(env):
    svc, a, foreign, rx, clinical = env
    entry = clinical.create_issue(a["PHARMACIST"], rx,
        " warn-1 ", "Potential drug interaction",
        "Prescriber contact and independent verification needed",
        severity="WARNING")
    assert entry["code"] == "WARN-1"
    assert entry["source"] == "SYNTHETIC_MANUAL"
    assert entry["title"] == "Potential drug interaction"
    assert entry["status"] == "OPEN"
    assert entry["created_at"] is not None
    with pytest.raises(AccessDenied):
        clinical.resolve_issue(a["TECHNICIAN"], entry["id"],
            "Technician cannot authorize a clinical resolution")
    with pytest.raises(WorkflowError, match="1–4000"):
        clinical.resolve_issue(a["PHARMACIST"], entry["id"], "   ")
    closed = clinical.resolve_issue(a["PHARMACIST"], entry["id"],
        "Prescriber contacted; pharmacist reviewed the synthetic interaction")
    assert closed["status"] == "RESOLVED"
    assert closed["resolved_at"] is not None
    assert closed["resolved_by_id"] == a["PHARMACIST"].id
    assert closed["resolved_by"]["role"] == "PHARMACIST"
    with pytest.raises(WorkflowError, match="already resolved"):
        clinical.resolve_issue(a["PHARMACIST"], entry["id"],
            "Repeated resolution is not permitted")
    with svc.sessions() as s:
        row = s.get(DUR, entry["id"])
        assert row.resolved and row.resolved_by_id == a["PHARMACIST"].id
        assert row.resolved_automatically is False


def test_high_issue_blocks_fill_until_explicit_resolution(env):
    svc, a, foreign, rx, clinical = env
    issue = clinical.create_issue(a["PHARMACIST"], rx,
        "TEST_HIGH", "High-severity test interaction", severity="HIGH")
    with pytest.raises(WorkflowError, match="DUR"):
        svc.start_fill(a["TECHNICIAN"], rx)
    clinical.record_intervention(a["PHARMACIST"], rx,
        "Clinical intervention note by itself does not resolve this DUR")
    with pytest.raises(WorkflowError, match="DUR"):
        svc.start_fill(a["TECHNICIAN"], rx)
    clinical.resolve_issue(a["PHARMACIST"], issue["id"],
        "Independent clinical resolution and prescriber discussion recorded")
    assert svc.start_fill(a["TECHNICIAN"], rx)


def test_original_clinical_dur_routes_and_permissions(env):
    svc, a, foreign, rx, clinical = env
    api = TestClient(create_app(svc, synthetic_enabled=True))
    path = f"/api/prescriptions/{rx}/dur/issues"
    payload = {"code": "DEMO_W", "title": "Potential synthetic warning",
               "description": "Requires further pharmacist evaluation",
               "severity": "WARNING"}
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    pharm = {"x-demo-staff-id": a["PHARMACIST"].id}
    assert api.post(path, headers=tech, json=payload).status_code == 403
    assert api.post(path, headers=pharm,
        json={**payload, "severity": "NOT_REAL"}).status_code == 409
    response = api.post(path, headers=pharm, json=payload)
    assert response.status_code == 201
    issue_id = response.json()["issue"]["id"]
    assert api.get(f"/api/prescriptions/{rx}/clinical", headers=tech).json()["issues"][0]["title"] == payload["title"]
    resolve = f"/api/dur/issues/{issue_id}/resolve"
    assert api.patch(resolve, headers=tech, json={"note": "Technician not authorized"}).status_code == 403
    done = api.patch(resolve, headers=pharm,
        json={"note": "Pharmacist reviewed and documented resolution"})
    assert done.status_code == 200
    assert done.json()["issue"]["status"] == "RESOLVED"
    assert api.patch(resolve, headers=pharm,
        json={"note": "Duplicate resolution is prohibited"}).status_code == 409
    assert api.patch(resolve, headers={
        "x-demo-staff-id": foreign["PHARMACIST"].id},
        json={"note": "Other site must not resolve DUR"}).status_code == 409
