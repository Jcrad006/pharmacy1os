"""Location-aware Python inventory regression tests, using synthetic products only."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_locations import InventoryLocationService
from pharmacy1os.inventory_location_models import (
    InventoryPositionEvent, InventoryStockPosition,
)
from pharmacy1os.inventory_ops import InventoryService
from pharmacy1os.models import Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    med = svc.add_drug(a["PHARMACIST"], "Synthetic Location Med", "10 mg", "tablet")
    product = svc.add_product(a["PHARMACIST"], med, "44444-5555-66",
                              "Demo Labeler", "White round synthetic tablet")
    svc.register_barcode(a["TECHNICIAN"], product, "LOCATION-TEST-BC")
    expiry = (date.today() + timedelta(days=200)).isoformat()
    stock_id = svc.receive(a["TECHNICIAN"], "LOCATION-TEST-BC", "LOT-MAIN",
                           expiry, "100")
    directory = InventoryLocationService(svc)
    receiving = directory.create(a["PHARMACIST"], "A-1", "Main Receiving Shelf", "SHELF",
        barcode="LOC-A1", is_default_receiving=True, is_default_dispensing=True)
    bin_two = directory.create(a["PHARMACIST"], "B-1", "Second Dispensary Bin", "BIN",
                               barcode="LOC-B1")
    return svc, a, other, med, product, stock_id, expiry, receiving, bin_two, directory


def test_reconcile_stock_and_move_physical_quantity_without_changing_site_aggregate(env):
    svc, a, other, med, product, stock, exp, a_id, b_id, locations = env
    with pytest.raises(AccessDenied):
        locations.activate_stock(a["TECHNICIAN"], stock, a_id,
            "Technician must not initialize a synthetic lot location")
    with pytest.raises(WorkflowError, match="site"):
        locations.activate_stock(other["PHARMACIST"], stock, a_id,
            "The initial physical stock location has been verified")
    assert locations.positions(a["AUDITOR"], stock) == []
    locations.activate_stock(a["PHARMACIST"], stock, a_id,
        "The pharmacist independently verified all one hundred units at shelf A-1.")
    assert locations.positions(a["AUDITOR"], stock)[0]["available"] == "100.000"
    with pytest.raises(WorkflowError, match="already enabled"):
        locations.activate_stock(a["PHARMACIST"], stock, a_id,
            "The initial physical stock location has been verified")
    with pytest.raises(WorkflowError, match="reserved, quarantined, or absent"):
        locations.move(a["TECHNICIAN"], stock, a_id, b_id, "101", "Impossible move")
    locations.move(a["TECHNICIAN"], stock, a_id, b_id, "40", "Move to alternate dispensary bin")
    positions = {item["code"]: item for item in locations.positions(a["AUDITOR"], stock)}
    assert positions["A-1"]["available"] == "60.000"
    assert positions["B-1"]["available"] == "40.000"
    with svc.sessions() as s:
        obj = s.get(Stock, stock)
        assert obj.on_hand == Decimal("100")
        assert obj.location_tracking_enabled is True
        moves = s.scalars(select(InventoryPositionEvent).where(
            InventoryPositionEvent.stock_id == stock)).all()
        assert [event.event_type for event in moves] == [
            "INITIAL_RECONCILIATION", "LOCATION_MOVE"
        ]
        assert moves[-1].from_location_id == a_id
        assert moves[-1].to_location_id == b_id
    with pytest.raises(WorkflowError, match="site|location"):
        locations.move(other["TECHNICIAN"], stock, a_id, b_id, "1", "No cross-site move")


def test_stock_receiving_reservation_release_and_pharmacist_dispense_mirror_positions(env):
    svc, a, _, med, product, stock, exp, a_id, b_id, locations = env
    locations.activate_stock(a["PHARMACIST"], stock, a_id,
        "The pharmacist confirmed the counted lot at the receiving shelf.")
    locations.move(a["TECHNICIAN"], stock, a_id, b_id, "40", "Supply secondary bin")
    patient = svc.add_patient(a["TECHNICIAN"], "Synthetic", "FEFOPatient")
    provider = svc.add_prescriber(a["TECHNICIAN"], "Sample", "Doctor", "MD")
    rx = svc.add_prescription(a["TECHNICIAN"], patient, provider, med,
                              "LOC-RX-01", "Take once daily", "30")
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    fill = svc.start_fill(a["TECHNICIAN"], rx)
    with pytest.raises(WorkflowError, match="Insufficient stock in the selected physical location"):
        svc.scan_source(a["TECHNICIAN"], fill, "LOCATION-TEST-BC", "LOT-MAIN",
                        exp, "45", location_id=b_id)
    with pytest.raises(WorkflowError, match="exceeds actual fill"):
        svc.scan_source(a["TECHNICIAN"], fill, "LOCATION-TEST-BC", "LOT-MAIN",
                        exp, "31", location_id=b_id)
    svc.scan_source(a["TECHNICIAN"], fill, "LOCATION-TEST-BC", "LOT-MAIN",
                    exp, "30", location_id=b_id)
    p = {x["code"]: x for x in locations.positions(a["AUDITOR"], stock)}
    assert p["B-1"]["available"] == "10.000"
    assert p["B-1"]["reserved"] == "30.000"
    assert p["A-1"]["available"] == "60.000"
    with pytest.raises(WorkflowError, match="reserved, quarantined"):
        locations.move(a["TECHNICIAN"], stock, b_id, a_id, "15", "Reserved units cannot be moved")
    svc.prepare_for_review(a["TECHNICIAN"], fill, [])
    svc.verify(a["PHARMACIST"], fill)
    p = {x["code"]: x for x in locations.positions(a["AUDITOR"], stock)}
    assert p["B-1"]["reserved"] == "0.000"
    assert p["B-1"]["available"] == "10.000"
    with svc.sessions() as s:
        obj = s.get(Stock, stock)
        assert obj.on_hand == Decimal("70")
        assert obj.reserved == 0
    # A later physical receipt is placed at the default receiving location.
    svc.receive(a["TECHNICIAN"], "LOCATION-TEST-BC", "LOT-MAIN", exp, "10")
    p = {x["code"]: x for x in locations.positions(a["AUDITOR"], stock)}
    assert p["A-1"]["available"] == "70.000"
    assert p["B-1"]["available"] == "10.000"


def test_quarantine_release_adjustment_and_position_invariants(env):
    svc, a, _, med, product, stock, exp, a_id, b_id, locations = env
    locations.activate_stock(a["PHARMACIST"], stock, a_id,
        "The pharmacist verified the physical quantity on receiving.")
    inv = InventoryService(svc)
    hold = inv.create_hold(a["TECHNICIAN"], stock, "12", "Test damage quarantine")
    p = locations.positions(a["AUDITOR"], stock)[0]
    assert p["available"] == "88.000"
    assert p["quarantined"] == "12.000"
    with pytest.raises(WorkflowError, match="reserved, quarantined"):
        locations.move(a["TECHNICIAN"], stock, a_id, b_id, "90", "Cannot move held stock")
    inv.resolve_hold(a["PHARMACIST"], hold, "RELEASED", "Verified no damage")
    p = locations.positions(a["AUDITOR"], stock)[0]
    assert p["available"] == "100.000"
    assert p["quarantined"] == "0.000"
    hold2 = inv.create_hold(a["TECHNICIAN"], stock, "5", "Recalled demo stock")
    inv.resolve_hold(a["PHARMACIST"], hold2, "DISPOSED", "Destroyed demo damaged units")
    inv.adjust(a["PHARMACIST"], stock, "-5", "Physical count documented shortage")
    p = locations.positions(a["AUDITOR"], stock)[0]
    assert p["available"] == "90.000"
    with svc.sessions() as s:
        obj = s.get(Stock, stock)
        assert obj.on_hand == Decimal("90")


def test_advisory_fefo_order_and_no_cross_site_stock_leak(env):
    svc, a, other, med, product, stock, exp, a_id, b_id, locations = env
    locations.activate_stock(a["PHARMACIST"], stock, a_id,
        "The site receiving balance was physically reconciled.")
    early = (date.today() + timedelta(days=42)).isoformat()
    earlier_stock = svc.receive(a["TECHNICIAN"], "LOCATION-TEST-BC",
        "LOT-EARLY", early, "25")
    locations.activate_stock(a["PHARMACIST"], earlier_stock, a_id,
        "The earlier-expiring lot was physically reconciled.")
    rows = locations.fefo_recommendations(a["TECHNICIAN"], product)
    assert [x["stock_id"] for x in rows] == [earlier_stock, stock]
    assert rows[0]["warning"].startswith("FEFO_ADVISORY_ONLY")
    rows = locations.fefo_recommendations(a["TECHNICIAN"], product,
                                           minimum_shelf_life_days=60)
    assert len(rows) == 1 and rows[0]["stock_id"] == stock
    assert locations.fefo_recommendations(other["AUDITOR"], product) == []
    with pytest.raises(WorkflowError, match="shelf-life"):
        locations.fefo_recommendations(a["AUDITOR"], product,
                                       minimum_shelf_life_days=-1)


def test_not_tracking_prior_stock_without_attestation_and_legacy_receiving_works(env):
    svc, a, _, med, product, stock, exp, a_id, b_id, locations = env
    patient = svc.add_patient(a["TECHNICIAN"], "Synthetic", "Untouched")
    provider = svc.add_prescriber(a["TECHNICIAN"], "Synthetic", "Doctor", "MD")
    rx = svc.add_prescription(a["TECHNICIAN"], patient, provider, med,
                              "LOC-RX-02", "daily", "10")
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    fill = svc.start_fill(a["TECHNICIAN"], rx)
    with pytest.raises(WorkflowError, match="after position tracking"):
        svc.scan_source(a["TECHNICIAN"], fill, "LOCATION-TEST-BC", "LOT-MAIN",
                        exp, "10", location_id=a_id)
    svc.scan_source(a["TECHNICIAN"], fill, "LOCATION-TEST-BC", "LOT-MAIN", exp, "10")
    with pytest.raises(WorkflowError, match="reserved/quarantined"):
        locations.activate_stock(a["PHARMACIST"], stock, a_id,
            "This is not yet physically reconciled.")
    with svc.sessions() as s:
        assert s.get(Stock, stock).location_tracking_enabled is False


def test_inventory_location_api_permissions_and_synthetic_mode(env):
    svc, a, other, med, product, stock, exp, receiving, bin_two, directory = env
    api = TestClient(create_app(svc, synthetic_enabled=True))
    off = TestClient(create_app(svc, synthetic_enabled=False))
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    pharm = {"x-demo-staff-id": a["PHARMACIST"].id}
    auditor = {"x-demo-staff-id": a["AUDITOR"].id}
    assert off.get("/api/inventory/locations", headers=tech).status_code == 503
    assert api.post("/api/inventory/locations", headers=tech, json={
        "code": "C-1", "name": "Protected", "type": "SHELF"}).status_code == 403
    assert api.get("/api/inventory/locations", headers=auditor).status_code == 200
    response = api.post("/api/inventory/locations", headers=pharm, json={
        "code": "C-1", "name": "Overflow", "type": "SHELF"})
    assert response.status_code == 201
    assert api.get(f"/api/inventory/locations/stock/{stock}", headers=auditor
                   ).json()["positions"] == []
    start = api.post(f"/api/inventory/locations/activate/{stock}", headers=pharm,
        json={"location_id": receiving,
              "attestation": "Pharmacist verified initial stock in receiving shelf."})
    assert start.status_code == 200, start.text
    moved = api.post("/api/inventory/locations/move", headers=tech, json={
        "stock_id": stock, "from_location_id": receiving, "to_location_id": bin_two,
        "quantity": "15", "reason": "Test physical move"})
    assert moved.status_code == 200, moved.text
    result = api.get("/api/inventory/fefo",
        headers=auditor, params={"product_id": product})
    assert result.status_code == 200
    assert len(result.json()["recommendations"]) == 2
    assert api.get("/api/inventory/locations",
                   headers={"x-demo-staff-id": other["AUDITOR"].id}
                   ).json()["locations"] == []


def test_duplicate_barcode_and_invalid_quarantine_location_rejected(env):
    svc, a, other, med, product, stock, exp, a_id, b_id, directory = env
    with pytest.raises(WorkflowError, match="Duplicate location barcode"):
        directory.create(a["PHARMACIST"], "C-1", "Duplicate", "SHELF",
                         barcode="LOC-A1")
    with pytest.raises(WorkflowError, match="must have type QUARANTINE"):
        directory.create(a["PHARMACIST"], "Q-1", "Invalid", "SHELF",
                         is_quarantine=True)
    with pytest.raises(WorkflowError, match="cannot be a regular receiving"):
        directory.create(a["PHARMACIST"], "Q-1", "Invalid", "QUARANTINE",
                         is_quarantine=True, is_default_receiving=True)
