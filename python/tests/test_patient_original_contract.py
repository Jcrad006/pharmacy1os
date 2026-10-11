"""Original patients.ts parity regression for the Python synthetic directory.

This is not patient identification, deduplication, or production API compatibility.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.models import Audit, Patient
from pharmacy1os.patient_directory import PatientDirectory
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def environment():
    service = PharmacyService()
    service.create_schema()
    primary = service.bootstrap_demo()["actors"]
    secondary = service.bootstrap_demo()["actors"]
    return service, PatientDirectory(service), primary, secondary


def headers(actor):
    return {"x-demo-staff-id": actor.id}


def test_original_create_get_contract_and_backward_compatible_payload(environment):
    service, directory, actors, _ = environment
    client = TestClient(create_app(service, synthetic_enabled=True))
    pharmacist = headers(actors["PHARMACIST"])
    created = client.post("/api/patients", headers=pharmacist, json={
        "firstName": "  Casey  ", "lastName": "  Hart  ",
        "dateOfBirth": "02/29/2000", "phone": "(919) 555-0202",
        "email": "  casey@example.test  "})
    assert created.status_code == 201, created.text
    pid = created.json()["id"]
    patient = created.json()["patient"]
    assert patient["firstName"] == "Casey"
    assert patient["lastName"] == "Hart"
    assert patient["dateOfBirth"] == "2000-02-29"
    assert patient["email"] == "casey@example.test"
    found = client.get("/api/patients", params={"query": "hart, cas"},
                       headers=headers(actors["AUDITOR"]))
    assert found.status_code == 200, found.text
    assert found.json()["patients"][0]["id"] == pid
    assert found.json()["patients"][0]["siteId"] == actors["AUDITOR"].site_id
    assert found.json()["patients"][0]["email"] == "casey@example.test"
    # The first Python /api/patients payload remains supported.
    legacy = client.post("/api/patients", headers=pharmacist,
                         json={"first": "Taylor", "last": "Sato"})
    assert legacy.status_code == 201
    assert legacy.json()["patient"]["lastName"] == "Sato"
    with service.sessions() as session:
        logs = session.scalars(select(Audit).where(
            Audit.subject_id == pid, Audit.kind == "PATIENT_CREATED")).all()
        assert len(logs) == 1
        assert "casey@example.test" not in logs[0].detail


def test_original_query_filters_phone_dob_and_synthetic_alias(environment):
    service, directory, actors, _ = environment
    client = TestClient(create_app(service, synthetic_enabled=True))
    actor = headers(actors["TECHNICIAN"])
    for first, last, dob, phone in [
        ("Pat", "Harris", "1970-01-01", "(919) 555-1212"),
        ("Parker", "Harrison", "1970-01-02", "919-555-1313"),
        ("Lee", "Other", "1970-01-01", "919-555-1212"),
    ]:
        directory.create(actors["TECHNICIAN"], first, last, dob=dob, phone=phone)
    response = client.get("/api/patients", headers=actor, params={
        "firstName": "pa", "lastName": "har", "dateOfBirth": "01/01/1970",
        "phone": "55512"})
    assert response.status_code == 200
    assert [(p["lastName"], p["firstName"]) for p in response.json()["patients"]] == [
        ("Harris", "Pat")]
    by_phone = client.get("/api/patients", headers=actor, params={"query": "91955513"})
    assert [p["firstName"] for p in by_phone.json()["patients"]] == ["Parker"]
    normalized = client.post("/api/patients/normalized", headers=actor, json={
        "first_name": "Riley", "last_name": "Wong",
        "email": "riley@example.test"})
    assert normalized.status_code == 201
    match = client.get("/api/patients/search", headers=actor,
                       params={"last_name": "wong"}).json()["patients"][0]
    assert match["email"] == "riley@example.test"


def test_cross_site_roles_validation_and_disabled_api(environment):
    service, directory, primary, secondary = environment
    first = directory.create(primary["TECHNICIAN"], "Primary", "Site",
                             email="primary@example.test")
    client = TestClient(create_app(service, synthetic_enabled=True))
    assert client.get("/api/patients", headers=headers(secondary["AUDITOR"])).json()["patients"] == []
    assert client.get("/api/patients", headers=headers(primary["AUDITOR"])).json()["patients"][0]["id"] == first
    denied = client.post("/api/patients", headers=headers(primary["AUDITOR"]),
                         json={"firstName": "Cannot", "lastName": "Write"})
    assert denied.status_code == 403
    invalid = client.post("/api/patients", headers=headers(primary["TECHNICIAN"]),
                          json={"firstName": "Bad", "lastName": "Date",
                                "dateOfBirth": "02/29/2001"})
    assert invalid.status_code == 409
    invalid_email = client.post("/api/patients", headers=headers(primary["TECHNICIAN"]),
                                json={"firstName": "Bad", "lastName": "Email",
                                      "email": "invalid address"})
    assert invalid_email.status_code == 409
    missing = client.get("/api/patients")
    assert missing.status_code == 403
    disabled = TestClient(create_app(service, synthetic_enabled=False))
    assert disabled.get("/api/patients", headers=headers(primary["TECHNICIAN"])).status_code == 503
    with service.sessions() as session:
        patients = session.scalars(select(Patient).where(Patient.site_id == primary["TECHNICIAN"].site_id)).all()
        assert len(patients) == 1


def test_directory_email_limit_and_email_not_in_audit(environment):
    service, directory, primary, _ = environment
    with pytest.raises(WorkflowError, match="Invalid patient email"):
        directory.create(primary["TECHNICIAN"], "Long", "Email",
                         email="a" * 253 + "@test")
    with pytest.raises(AccessDenied):
        directory.create(primary["AUDITOR"], "Audit", "User")
