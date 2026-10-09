"""Adversarial coverage for advisory-only native Python replenishment."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_advanced import AdvancedInventoryService
from pharmacy1os.inventory_planning import InventoryPlanningService, ReorderPolicy
from pharmacy1os.models import Audit, PurchaseOrder, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    b = svc.bootstrap_demo()["actors"]
    pharmacist = a["PHARMACIST"]
    drug = svc.add_drug(pharmacist, "Synthetic planning agent", "5 mg", "tablet")
    product = svc.add_product(pharmacist, drug, "00000-5040-04", "Example", "Synthetic tablets")
    svc.register_barcode(a["TECHNICIAN"], product, "PLANNER-101")
    expiry = (date.today() + timedelta(days=180)).isoformat()
    stock = svc.receive(a["TECHNICIAN"], "PLANNER-101", "SITEA", expiry, "12")
    planning = InventoryPlanningService(svc)
    ops = AdvancedInventoryService(svc)
    return svc, planning, ops, a, b, drug, product, stock, expiry


def test_outstanding_orders_and_in_transit_reduce_advisory_quantity(env):
    svc, planner, ops, a, b, drug, product, stock, expiry = env
    planner.configure(a["PHARMACIST"], product, "20", "50", "Synthetic threshold")
    initial = planner.recommendations(a["TECHNICIAN"])[0]
    assert initial["status"] == "BELOW_MINIMUM"
    assert initial["available"] == "12.000"
    assert Decimal(initial["suggested_quantity"]) == 38

    po = ops.create_purchase_order(a["TECHNICIAN"], "Example", "PLANNER-PO",
                                   [{"product_id": product, "quantity": "10"}])
    row = planner.recommendations(a["TECHNICIAN"])[0]
    assert Decimal(row["open_orders"]) == 10
    assert Decimal(row["suggested_quantity"]) == 28

    inbound_stock = svc.receive(b["TECHNICIAN"], "PLANNER-101", "SITEB", expiry, "7")
    transfer = ops.ship_transfer(b["PHARMACIST"], inbound_stock, a["PHARMACIST"].site_id,
                                 "5", "Transfer")
    row = planner.recommendations(a["TECHNICIAN"])[0]
    assert Decimal(row["incoming_transfers"]) == 5
    assert Decimal(row["suggested_quantity"]) == 23

    ops.receive_transfer(a["TECHNICIAN"], transfer)
    updated = planner.recommendations(a["TECHNICIAN"])[0]
    assert Decimal(updated["incoming_transfers"]) == 0
    assert Decimal(updated["available"]) == 17
    assert Decimal(updated["suggested_quantity"]) == 23
    with svc.sessions() as s:
        assert s.get(PurchaseOrder, po).status == "OPEN"
        assert len(s.scalars(select(PurchaseOrder)).all()) == 1


def test_low_stock_uses_usable_not_reserved_or_quarantined(env):
    svc, planner, ops, a, b, drug, product, stock, expiry = env
    planner.configure(a["PHARMACIST"], product, "20", "40", "Threshold")
    with svc.sessions.begin() as s:
        line = s.get(Stock, stock)
        line.reserved = Decimal("4")
        line.quarantined = Decimal("3")
    row = planner.recommendations(a["AUDITOR"])[0]
    assert Decimal(row["available"]) == 5
    assert Decimal(row["suggested_quantity"]) == 35

    with svc.sessions.begin() as s:
        s.get(Stock, stock).expires = (date.today() - timedelta(days=1)).isoformat()
    row = planner.recommendations(a["TECHNICIAN"])[0]
    assert Decimal(row["available"]) == 0
    assert Decimal(row["suggested_quantity"]) == 40


def test_recall_and_controlled_blocks_and_no_order_auto_creation(env):
    svc, planner, ops, a, b, drug, product, stock, expiry = env
    planner.configure(a["PHARMACIST"], product, "20", "40", "Threshold")
    recall_id = ops.open_recall(a["PHARMACIST"], product, "RECALL-PLANNER",
                                "Synthetic recall", None)
    result = planner.recommendations(a["AUDITOR"])[0]
    assert result["status"] == "RECALL_REVIEW"
    assert Decimal(result["suggested_quantity"]) == 0
    ops.close_recall(a["PHARMACIST"], recall_id, "Closure documented")
    with svc.sessions.begin() as s:
        from pharmacy1os.models import Drug
        s.get(Drug, drug).controlled = True
    result = planner.recommendations(a["AUDITOR"])[0]
    assert result["status"] == "CONTROLLED_REVIEW"
    assert Decimal(result["suggested_quantity"]) == 0
    with svc.sessions() as s:
        assert s.scalars(select(PurchaseOrder)).all() == []


def test_policy_site_permissions_reasons_disable_and_validation(env):
    svc, planner, ops, a, b, drug, product, stock, expiry = env
    for low, target in [("-1", "30"), ("10", "10"), ("2.5555", "30"),
                        ("NaN", "30"), ("Infinity", "30"), ("0", "1000000000")]:
        with pytest.raises(WorkflowError):
            planner.configure(a["PHARMACIST"], product, low, target, "Reason")
    with pytest.raises(AccessDenied):
        planner.configure(a["TECHNICIAN"], product, "10", "20", "Reason")
    with pytest.raises(WorkflowError):
        planner.configure(a["PHARMACIST"], product, "10", "20", "")
    first = planner.configure(a["PHARMACIST"], product, "10", "20", "Initial setting")
    assert planner.recommendations(b["PHARMACIST"], include_all=True) == []
    second = planner.configure(a["PHARMACIST"], product, "20", "50", "Reviewed target")
    assert second == first
    with pytest.raises(AccessDenied):
        planner.disable(a["TECHNICIAN"], product, "Cannot")
    with pytest.raises(WorkflowError):
        planner.disable(b["PHARMACIST"], product, "Cannot cross sites")
    planner.disable(a["PHARMACIST"], product, "Temporary hold")
    assert planner.recommendations(a["PHARMACIST"]) == []
    assert planner.recommendations(a["PHARMACIST"], include_all=True)[0]["status"] == "DISABLED"
    with svc.sessions() as s:
        assert len(s.scalars(select(ReorderPolicy)).all()) == 1
        kinds = [x.kind for x in s.scalars(select(Audit)).all()]
        assert kinds.count("REORDER_POLICY_CONFIGURED") == 2
        assert "REORDER_POLICY_DISABLED" in kinds


def test_synthetic_api_guards_and_site_bound_results(env):
    svc, planner, ops, a, b, drug, product, stock, expiry = env
    client = TestClient(create_app(svc, synthetic_enabled=True))
    tech_headers = {"x-demo-staff-id": a["TECHNICIAN"].id}
    pharmacist_headers = {"x-demo-staff-id": a["PHARMACIST"].id}
    payload = {"product_id": product, "minimum": "15", "target": "35", "reason": "Review"}
    assert client.post("/api/inventory/replenishment/policies",
                       json=payload, headers=tech_headers).status_code == 403
    created = client.post("/api/inventory/replenishment/policies",
                          json=payload, headers=pharmacist_headers)
    assert created.status_code == 200
    rows = client.get("/api/inventory/replenishment", headers=tech_headers)
    assert rows.status_code == 200
    assert rows.json()["recommendations"][0]["suggested_quantity"] == "23.000"
    assert client.get("/api/inventory/replenishment",
                      headers={"x-demo-staff-id": b["TECHNICIAN"].id}).json() == {"recommendations": []}
    assert client.post(f"/api/inventory/replenishment/policies/{product}/disable",
                       json={"reason": "Pause"}, headers=pharmacist_headers).status_code == 200
    assert client.get("/api/inventory/replenishment", headers=tech_headers).json() == {"recommendations": []}
    assert TestClient(create_app(svc)).get("/api/inventory/replenishment",
                                          headers=tech_headers).status_code == 503
