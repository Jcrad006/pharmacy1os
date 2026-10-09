"""Exact inventory movement chain and historical quantity reconstruction."""
import json
from datetime import date, timedelta, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_asof import HistoricalInventoryService
from pharmacy1os.inventory_ops import InventoryService
from pharmacy1os.models import InventoryMovement, Stock
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def env():
    service = PharmacyService()
    service.create_schema()
    actors = service.bootstrap_demo()["actors"]
    foreign = service.bootstrap_demo()["actors"]
    product_drug = service.add_drug(actors["PHARMACIST"], "Synthetic as-of", "15mg", "tablet")
    product = service.add_product(actors["PHARMACIST"], product_drug,
                                  "40000-0505-01", "Demo", "Synthetic white tablets")
    service.register_barcode(actors["TECHNICIAN"], product, "ASOF-BARCODE-1")
    stock_id = service.receive(actors["TECHNICIAN"], "ASOF-BARCODE-1", "LOT-HISTORY",
             (date.today() + timedelta(days=365)).isoformat(), "20")
    return service, actors, foreign, stock_id, HistoricalInventoryService(service)


def test_asof_onhand_quarantine_and_adjustment(env):
    service, actors, foreign, stock, history = env
    with service.sessions() as s:
        first = s.scalar(select(InventoryMovement).where(
            InventoryMovement.stock_id == stock).order_by(
            InventoryMovement.created_at)).created_at
    inventory = InventoryService(service)
    inventory.create_hold(actors["TECHNICIAN"], stock, "5", "Synthetic manufacturer hold")
    with service.sessions() as s:
        rows = s.scalars(select(InventoryMovement).where(
            InventoryMovement.stock_id == stock).order_by(
            InventoryMovement.created_at, InventoryMovement.id)).all()
        held = rows[-1].created_at
    inventory.adjust(actors["PHARMACIST"], stock, "-3", "Damaged items removed from usable stock")
    at_first = history.as_of(actors["AUDITOR"], stock, first.replace(tzinfo=timezone.utc).isoformat())
    assert at_first["on_hand_quantity"] == "20.000"
    assert at_first["available_quantity"] == "20.000"
    at_held = history.as_of(actors["AUDITOR"], stock, held.replace(tzinfo=timezone.utc).isoformat())
    assert at_held["quarantined_quantity"] == "5.000"
    assert at_held["available_quantity"] == "15.000"
    current = history.as_of(actors["AUDITOR"], stock)
    assert current["on_hand_quantity"] == "17.000"
    assert current["available_quantity"] == "12.000"
    assert current["recorded_acquisition_cost"] is None
    before = history.as_of(actors["AUDITOR"], stock, "2020-01-01T00:00:00Z")
    assert before["on_hand_quantity"] == "0"


def test_asof_rejects_timezone_naive_and_cross_site(env):
    service, actors, foreign, stock, history = env
    with pytest.raises(WorkflowError, match="timezone"):
        history.as_of(actors["AUDITOR"], stock, "2026-01-01T00:00:00")
    with pytest.raises(WorkflowError, match="timestamp"):
        history.as_of(actors["AUDITOR"], stock, "yesterday")
    with pytest.raises(WorkflowError, match="site"):
        history.as_of(foreign["AUDITOR"], stock)


def test_missing_or_tampered_ledger_fails_closed(env):
    service, actors, foreign, stock_id, history = env
    with service.sessions.begin() as s:
        row = s.scalar(select(InventoryMovement).where(InventoryMovement.stock_id == stock_id))
        row.after_snapshot = json.dumps({"on_hand": "10", "reserved": "0", "quarantined": "0"})
    with pytest.raises(WorkflowError, match="incomplete or inconsistent"):
        history.as_of(actors["AUDITOR"], stock_id)
    with service.sessions.begin() as s:
        row = s.scalar(select(InventoryMovement).where(InventoryMovement.stock_id == stock_id))
        row.after_snapshot = json.dumps({"on_hand": "20", "reserved": "0", "quarantined": "0"})
        s.get(Stock, stock_id).on_hand += 1
    with pytest.raises(WorkflowError, match="reconcile"):
        history.as_of(actors["AUDITOR"], stock_id)


def test_api_history_uses_optin_and_site_actor(env):
    service, actors, foreign, stock, history = env
    url = f"/api/inventory/balances/{stock}/as-of"
    disabled = TestClient(create_app(service, synthetic_enabled=False))
    assert disabled.get(url, headers={"x-demo-staff-id": actors["AUDITOR"].id}).status_code == 503
    api = TestClient(create_app(service, synthetic_enabled=True))
    response = api.get(url, headers={"x-demo-staff-id": actors["AUDITOR"].id})
    assert response.status_code == 200 and response.json()["on_hand_quantity"] == "20.000"
    assert api.get(url, headers={"x-demo-staff-id": foreign["AUDITOR"].id}).status_code == 409
    assert api.get(url, params={"at": "2026-01-01T00:00:00"},
                   headers={"x-demo-staff-id": actors["AUDITOR"].id}).status_code == 409
