"""Correcting synthetic scans must restore stock and keep custody events."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_allocations import InventoryAllocationService
from pharmacy1os.inventory_locations import InventoryLocationService
from pharmacy1os.models import Audit, FillSource, InventoryMovement, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    users = svc.bootstrap_demo()["actors"]
    foreign = svc.bootstrap_demo()["actors"]
    drug = svc.add_drug(users["PHARMACIST"], "Synthetic source correction", "5mg", "tablet")
    product = svc.add_product(users["PHARMACIST"], drug, "40000-0707-01", "Demo", "Synthetic blue tablet")
    svc.register_barcode(users["TECHNICIAN"], product, "SRC-BC-1")
    expires = (date.today() + timedelta(days=200)).isoformat()
    stock_id = svc.receive(users["TECHNICIAN"], "SRC-BC-1", "LOT-SRC-1", expires, "50")
    patient = svc.add_patient(users["TECHNICIAN"], "Synthetic", "Correction")
    prescriber = svc.add_prescriber(users["TECHNICIAN"], "Synthetic", "Doctor", "MD")
    rx = svc.add_prescription(users["TECHNICIAN"], patient, prescriber,
                              drug, "SYNTH-SRC-RX-100", "Once daily", "20")
    svc.advance_to_dur(users["TECHNICIAN"], rx)
    fill = svc.start_fill(users["TECHNICIAN"], rx)
    return svc, users, foreign, fill, stock_id, expires


def test_correct_untracked_scan_and_rescan(env):
    svc, users, foreign, fill, stock, expiry = env
    tech = users["TECHNICIAN"]
    svc.scan_source(tech, fill, "SRC-BC-1", "LOT-SRC-1", expiry, "10")
    source = svc.scanned_sources(users["AUDITOR"], fill)[0]
    assert source["quantity"] == "10.000"
    with pytest.raises(AccessDenied):
        svc.remove_scanned_source(users["AUDITOR"], fill, source["id"],
                                   "Only an authorized dispenser may correct scans")
    with pytest.raises(WorkflowError, match="site"):
        svc.scanned_sources(foreign["AUDITOR"], fill)
    result = svc.remove_scanned_source(tech, fill, source["id"],
        "Incorrect container selected during the scan")
    assert result["remaining_sources"] == 0
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal("50")
        assert s.get(Stock, stock).reserved == Decimal("0")
        assert s.query(FillSource).count() == 0
        assert s.scalar(select(InventoryMovement.id).where(
            InventoryMovement.kind == "FILL_SOURCE_CORRECTION_RELEASE")) is not None
        assert s.scalar(select(Audit.id).where(
            Audit.kind == "FILL_PRODUCT_SOURCE_REMOVED")) is not None
    with pytest.raises(WorkflowError, match="not found"):
        svc.remove_scanned_source(tech, fill, source["id"],
            "Cannot repeat a completed source correction")
    svc.scan_source(tech, fill, "SRC-BC-1", "LOT-SRC-1", expiry, "20")
    svc.prepare_for_review(tech, fill, [])
    with pytest.raises(WorkflowError, match="Product Fill"):
        svc.remove_scanned_source(tech, fill, svc.scanned_sources(tech, fill)[0]["id"],
                                   "Cannot correct a source after label creation")
    svc.verify(users["PHARMACIST"], fill)
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal("30")


def test_tracked_source_exact_location_restored(env):
    svc, users, foreign, fill, stock, expiry = env
    locations = InventoryLocationService(svc)
    first = locations.create(users["PHARMACIST"], "SRC-A", "Receiving shelf", "SHELF")
    second = locations.create(users["PHARMACIST"], "SRC-B", "Dispensing shelf", "BIN")
    locations.activate_stock(users["PHARMACIST"], stock, first,
        "Confirmed fifty units at the initial stock location")
    locations.move(users["TECHNICIAN"], stock, first, second, "25",
        "Confirmed twenty-five units moved into the second shelf")
    svc.scan_source(users["TECHNICIAN"], fill, "SRC-BC-1", "LOT-SRC-1",
                    expiry, "15", location_id=second)
    source = svc.scanned_sources(users["AUDITOR"], fill)[0]
    assert source["location_id"] == second
    svc.remove_scanned_source(users["TECHNICIAN"], fill, source["id"],
        "Wrong source bottle scanned in the picking bin")
    positions = locations.positions(users["AUDITOR"], stock)
    assert sum(Decimal(p["reserved"]) for p in positions) == 0
    history = InventoryAllocationService(svc).for_fill(users["AUDITOR"], fill)
    assert len(history) == 1
    assert history[0]["status"] == "RELEASED" and history[0]["source_id"] is None
    assert [e["to"] for e in history[0]["events"]] == ["ACTIVE", "RELEASED"]


def test_source_correction_api_disabled_in_live_mode_and_cross_site(env):
    svc, users, foreign, fill, stock, expiry = env
    svc.scan_source(users["TECHNICIAN"], fill, "SRC-BC-1", "LOT-SRC-1", expiry, "5")
    path = f"/api/fills/{fill}/product-sources"
    user_headers = {"x-demo-staff-id": users["TECHNICIAN"].id}
    api = TestClient(create_app(svc, synthetic_enabled=True))
    listed = api.get(path, headers=user_headers)
    assert listed.status_code == 200 and len(listed.json()["sources"]) == 1
    source_id = listed.json()["sources"][0]["id"]
    payload = {"reason": "Incorrect package scanned during product filling"}
    assert TestClient(create_app(svc, synthetic_enabled=False)).request(
        "DELETE", path + "/" + source_id, headers=user_headers, json=payload).status_code == 503
    assert api.request("DELETE", path + "/" + source_id,
        headers={"x-demo-staff-id": foreign["TECHNICIAN"].id}, json=payload).status_code == 409
    removed = api.request("DELETE", path + "/" + source_id, headers=user_headers, json=payload)
    assert removed.status_code == 200 and removed.json()["remaining_sources"] == 0
