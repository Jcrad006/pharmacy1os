"""Parity tests for original Fastify prescriber GET/POST on synthetic Python API."""
from datetime import date
from fastapi.testclient import TestClient
from sqlalchemy import select, func
import pytest

from pharmacy1os.api import create_app
from pharmacy1os.models import Audit, Prescriber
from pharmacy1os.provider_directory import ProviderIdentifier
from pharmacy1os.service import PharmacyService


@pytest.fixture
def env(tmp_path):
    service = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'prescriber-contract.sqlite3'}")
    service.create_schema()
    a = service.bootstrap_demo()["actors"]
    b = service.bootstrap_demo()["actors"]
    client = TestClient(create_app(service, synthetic_enabled=True))
    yield service, a, b, client
    service.engine.dispose()


def auth(actor):
    return {"x-demo-staff-id": actor.id}


def count_providers(service):
    with service.sessions() as session:
        return session.scalar(select(func.count()).select_from(Prescriber))


def test_original_atomic_create_with_nested_records_and_aliases(env):
    svc, actors, others, client = env
    payload = {
        "firstName": "  Sana  ", "lastName": "  Cruz ",
        "practiceLevel": "np", "dateOfBirth": "01/30/1975",
        "identifiers": [
            {"type": "NPI", "number": "12345 67893", "isPrimary": True},
            {"type": "DEA", "number": "AB 1234567", "jurisdiction": "NC"},
            {"type": "STATE_ID", "number": "NC-900", "jurisdiction": "NC"},
        ],
        "contacts": [
            {"type": "PHONE", "value": "(919) 555-0100", "label": "Office"},
            {"type": "FAX", "value": "919-555-0199", "isPrimary": True}
        ],
        "addresses": [
            {"addressLine1": "100 Main St", "city": "Durham",
             "state": "nc", "postalCode": "27701"},
            {"addressLine1": "200 Lake Rd", "city": "Raleigh",
             "state": "NC", "postalCode": "27601"}
        ],
    }
    created = client.post("/api/prescribers", headers=auth(actors["TECHNICIAN"]), json=payload)
    assert created.status_code == 201, created.text
    provider = created.json()["prescriber"]
    assert created.json()["id"] == provider["id"]
    assert provider["firstName"] == "Sana"
    assert provider["dateOfBirth"] == "1975-01-30"
    assert provider["practiceLevel"] == "NP"
    assert len(provider["identifiers"]) == 3
    assert len(provider["contacts"]) == 2
    assert len(provider["addresses"]) == 2
    assert provider["identifiers"][0]["numberSearch"]
    assert any(x["type"] == "NPI" and x["isPrimary"] for x in provider["identifiers"])
    assert sum(x["isPrimary"] for x in provider["addresses"]) == 1
    assert next(x for x in provider["addresses"] if x["isPrimary"])["postalCode"] == "27701"
    with svc.sessions() as session:
        row = session.get(Prescriber, provider["id"])
        assert row.date_of_birth == "1975-01-30"
        assert row.npi == "12345 67893"
        assert row.dea == "AB 1234567"
        assert row.phone == "(919) 555-0100"
        assert row.fax == "919-555-0199"
        audit = session.scalars(select(Audit).where(
            Audit.kind == "PRESCRIBER_CREATED", Audit.subject_id == row.id)).all()
        assert len(audit) == 1
        assert "AB 1234567" not in audit[0].detail


def test_filtered_query_name_phone_identifier_practice_dob_and_site(env):
    svc, actors, others, client = env
    create = client.post("/api/prescribers", headers=auth(actors["TECHNICIAN"]), json={
        "firstName": "Jenna", "lastName": "Wilson", "practiceLevel": "PA",
        "dateOfBirth": "1973-02-01",
        "npi": "1234567893",
        "contacts": [{"type": "PHONE", "value": "(919) 555-0199"}]})
    assert create.status_code == 201, create.text
    rx_id = create.json()["id"]
    for query in [
        {"query": "wilson, jen"}, {"firstName": "jen", "lastName": "wil"},
        {"query": "123-456-7893"}, {"query": "9195550199"},
        {"query": "pa"}, {"dateOfBirth": "02/01/1973", "phone": "5550199"}
    ]:
        response = client.get("/api/prescribers", headers=auth(actors["AUDITOR"]), params=query)
        assert response.status_code == 200, response.text
        assert [p["id"] for p in response.json()["prescribers"]] == [rx_id]
    assert client.get("/api/prescribers", headers=auth(others["AUDITOR"])).json()["prescribers"] == []
    assert client.get("/api/prescribers", headers=auth(actors["AUDITOR"]),
                      params={"dateOfBirth": "1973-02-02"}).json()["prescribers"] == []


def test_atomic_failure_prevents_partial_provider_creation(env):
    svc, actors, _, client = env
    baseline = count_providers(svc)
    good_prefix = {"firstName": "Wrong", "lastName": "Partial"}
    for bad in [
        {"identifiers": [{"type": "STATE_ID", "number": "NC-1"}]},
        {"identifiers": [{"type": "NPI", "number": "123"}, {"type": "NPI", "number": "456"}]},
        {"contacts": [{"type": "PHONE", "value": "not a phone"}]},
        {"addresses": [{"addressLine1": "Street", "city": "Raleigh",
                         "state": "NC", "postalCode": ""}]},
        {"addresses": [{"addressLine1": "Street", "city": "Raleigh",
                         "state": "NC", "postalCode": "27601", "isPrimary": True},
                        {"addressLine1": "Street 2", "city": "Raleigh",
                         "state": "NC", "postalCode": "27602", "isPrimary": True}]},
    ]:
        response = client.post("/api/prescribers", headers=auth(actors["TECHNICIAN"]),
                               json={**good_prefix, **bad})
        assert response.status_code in {409, 422}, response.text
        assert count_providers(svc) == baseline
    denied = client.post("/api/prescribers", headers=auth(actors["AUDITOR"]), json=good_prefix)
    assert denied.status_code == 403
    assert count_providers(svc) == baseline
    assert client.get("/api/prescribers").status_code == 403


def test_legacy_python_body_and_synthetic_gate(env):
    svc, actors, _, client = env
    old = client.post("/api/prescribers", headers=auth(actors["TECHNICIAN"]), json={
        "first": "Amina", "last": "Lopez", "level": "MD", "npi": "9876543210"})
    assert old.status_code == 201, old.text
    assert old.json()["prescriber"]["practiceLevel"] == "MD"
    assert old.json()["prescriber"]["identifiers"][0]["number"] == "9876543210"
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    assert disabled.get("/api/prescribers",
        headers=auth(actors["TECHNICIAN"])).status_code == 503


def test_nullable_historical_prescriber_date_of_birth(env):
    svc, actors, _, client = env
    rx = svc.add_prescriber(actors["TECHNICIAN"], "Older", "Record", "MD")
    details = client.get("/api/prescribers", headers=auth(actors["TECHNICIAN"]),
                         params={"query": "older"})
    assert details.status_code == 200
    assert details.json()["prescribers"][0]["dateOfBirth"] is None
