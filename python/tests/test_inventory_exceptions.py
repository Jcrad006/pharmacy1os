"""Persistent advisory stock-exception lifecycle and site/role boundaries."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_exceptions import InventoryExceptionRegistry
from pharmacy1os.inventory_exception_models import InventoryExceptionEvent
from pharmacy1os.inventory_planning import InventoryPlanningService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    service = PharmacyService()
    service.create_schema()
    actors = service.bootstrap_demo()["actors"]
    foreign = service.bootstrap_demo()["actors"]
    drug = service.add_drug(actors["PHARMACIST"], "Synthetic exception medication", "10mg", "tablet")
    product = service.add_product(actors["PHARMACIST"], drug, "40000-0606-01", "Demo", "White")
    service.register_barcode(actors["TECHNICIAN"], product, "EXC-BARCODE-1")
    InventoryPlanningService(service).configure(
        actors["PHARMACIST"], product, "10", "20", "Set demonstration reorder threshold")
    return service, actors, foreign, product, InventoryExceptionRegistry(service)


def test_reorder_detection_dedup_acknowledgement_and_auto_resolution(env):
    service, a, foreign, product, registry = env
    with pytest.raises(AccessDenied):
        registry.refresh(a["AUDITOR"])
    assert registry.list(a["AUDITOR"]) == []
    assert registry.refresh(a["TECHNICIAN"])["created"] == 1
    rows = registry.list(a["AUDITOR"])
    assert len(rows) == 1 and rows[0]["type"] == "BELOW_REORDER_POINT"
    case_id = rows[0]["id"]
    assert registry.refresh(a["TECHNICIAN"])["created"] == 0
    registry.acknowledge(a["TECHNICIAN"], case_id, "Supplier has been contacted about the shortage.")
    assert registry.refresh(a["TECHNICIAN"])["reopened"] == 0
    assert registry.list(a["AUDITOR"])[0]["status"] == "ACKNOWLEDGED"
    svc_stock = service.receive(a["TECHNICIAN"], "EXC-BARCODE-1", "CASE-LOT-A",
            (date.today() + timedelta(days=180)).isoformat(), "20")
    assert registry.refresh(a["TECHNICIAN"])["auto_resolved"] == 1
    assert registry.list(a["AUDITOR"])[0]["status"] == "RESOLVED"
    with service.sessions() as s:
        assert s.query(InventoryExceptionEvent).count() == 3
    assert [x["operation"] for x in registry.history(a["AUDITOR"], case_id)] == [
        "DETECTED", "ACKNOWLEDGED", "AUTO_RESOLVED"]


def test_reopening_after_pharmacist_resolution_requires_explicit_refresh(env):
    service, a, foreign, product, registry = env
    registry.refresh(a["TECHNICIAN"])
    row = registry.list(a["AUDITOR"])[0]
    with pytest.raises(AccessDenied):
        registry.resolve(a["TECHNICIAN"], row["id"], "Cannot sign off with technician role.")
    resolved = registry.resolve(a["PHARMACIST"], row["id"],
        "Supplier replenishment planned; no inventory adjustment performed.")
    assert resolved["status"] == "RESOLVED"
    assert registry.list(a["AUDITOR"])[0]["status"] == "RESOLVED"
    assert registry.refresh(a["TECHNICIAN"])["reopened"] == 1
    assert registry.list(a["AUDITOR"])[0]["status"] == "OPEN"
    assert [x["operation"] for x in registry.history(a["AUDITOR"], row["id"])] == [
        "DETECTED", "RESOLVED", "REOPENED"]
    registry.acknowledge(a["TECHNICIAN"], row["id"], "Initial review completed by technician.")
    with pytest.raises(WorkflowError, match="Only open"):
        registry.acknowledge(a["TECHNICIAN"], row["id"], "Cannot acknowledge the same alert twice.")


def test_cross_site_and_invalid_state(env):
    service, a, foreign, product, registry = env
    registry.refresh(a["TECHNICIAN"])
    row = registry.list(a["AUDITOR"])[0]
    assert registry.list(foreign["AUDITOR"]) == []
    with pytest.raises(WorkflowError, match="site"):
        registry.history(foreign["AUDITOR"], row["id"])
    with pytest.raises(WorkflowError, match="site"):
        registry.acknowledge(foreign["TECHNICIAN"], row["id"],
                             "Cannot act on another pharmacy's alert.")
    with pytest.raises(WorkflowError, match="status"):
        registry.list(a["AUDITOR"], "UNSAFE")


def test_api_gated_and_reports_review_event_history(env):
    service, a, foreign, product, registry = env
    disabled = TestClient(create_app(service, synthetic_enabled=False))
    hdr = {"x-demo-staff-id": a["TECHNICIAN"].id}
    assert disabled.post("/api/inventory/exceptions/refresh", headers=hdr).status_code == 503
    client = TestClient(create_app(service, synthetic_enabled=True))
    assert client.post("/api/inventory/exceptions/refresh", headers=hdr).status_code == 200
    listed = client.get("/api/inventory/exceptions",
                        headers={"x-demo-staff-id": a["AUDITOR"].id})
    assert listed.status_code == 200 and len(listed.json()["exceptions"]) == 1
    row_id = listed.json()["exceptions"][0]["id"]
    ack = client.post(f"/api/inventory/exceptions/{row_id}/acknowledge",
         json={"note": "Receiving technician reviewed the reorder warning."}, headers=hdr)
    assert ack.status_code == 200 and ack.json()["exception"]["status"] == "ACKNOWLEDGED"
    hist = client.get(f"/api/inventory/exceptions/{row_id}/events",
           headers={"x-demo-staff-id": a["AUDITOR"].id})
    assert hist.status_code == 200 and len(hist.json()["events"]) == 2
