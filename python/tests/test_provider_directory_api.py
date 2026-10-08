"""Synthetic API regressions for the migrated multi-contact prescriber directory."""
from __future__ import annotations

from fastapi.testclient import TestClient

from pharmacy1os.api import create_app
from pharmacy1os.service import PharmacyService


def test_directory_api_is_site_scoped_and_pharmacist_controls_identifiers(tmp_path):
    service = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'directory-api.db'}")
    service.create_schema()
    actors = service.bootstrap_demo()["actors"]
    prescriber = service.add_prescriber(actors["TECHNICIAN"], "Nia", "Jordan", "MD")
    client = TestClient(create_app(service, synthetic_enabled=True))
    pharmacist = {"x-demo-staff-id": actors["PHARMACIST"].id}
    technician = {"x-demo-staff-id": actors["TECHNICIAN"].id}
    cashier = {"x-demo-staff-id": actors["CASHIER"].id}
    url = f"/api/prescribers/{prescriber}"
    assert client.post(f"{url}/identifiers", headers=technician,
                       json={"type": "DEA", "number": "AB1234567"}).status_code == 403
    res = client.post(f"{url}/identifiers", headers=pharmacist,
                      json={"type": "DEA", "number": "AB1234567", "jurisdiction": "NC", "is_primary": True})
    assert res.status_code == 201, res.text
    identifier = res.json()["id"]
    assert client.post(f"{url}/contacts", headers=technician,
                       json={"kind": "FAX", "value": "919-555-0200", "is_primary": True}).status_code == 201
    assert client.post(f"{url}/addresses", headers=technician,
                       json={"line1": "22 Example Road", "city": "Durham", "state": "NC", "postal_code": "27701"}).status_code == 201
    result = client.get(f"{url}/directory", headers=technician)
    assert result.status_code == 200
    assert result.json()["identifiers"][0]["number"] == "AB1234567"
    assert len(result.json()["contacts"]) == 1
    assert client.get(f"{url}/directory", headers=cashier).status_code == 403
    assert client.get("/api/prescribers/search?q=5550200", headers=technician).json()["prescribers"][0]["id"] == prescriber
    assert client.post(f"/api/provider-identifiers/{identifier}/retire", headers=pharmacist,
                       json={"reason": "Synthetic replacement"}).status_code == 200
    assert client.get("/api/prescribers/search?q=AB1234567", headers=technician).json()["prescribers"] == []
    service.engine.dispose()
