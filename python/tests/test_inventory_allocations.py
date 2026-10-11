"""Physical fill allocation lifecycle tests — synthetic, site-scoped only."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_allocations import InventoryAllocationService
from pharmacy1os.inventory_location_models import (
    InventoryAllocation, InventoryAllocationEvent, InventoryStockPosition,
)
from pharmacy1os.inventory_locations import InventoryLocationService
from pharmacy1os.lifecycle import LifecycleService
from pharmacy1os.fill_completion import FillCompletionService
from pharmacy1os.models import FillSource, Stock
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    users = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    pharmacist = users["PHARMACIST"]
    technician = users["TECHNICIAN"]
    patient = svc.add_patient(technician, "Synthetic", "AllocationPatient")
    prescriber = svc.add_prescriber(technician, "Synthetic", "AllocationPrescriber", "MD")
    drug = svc.add_drug(pharmacist, "AllocationDrug", "5 mg", "tablet")
    product = svc.add_product(pharmacist, drug, "19191-0022-33", "TestLab", "Synthetic white tablet")
    svc.register_barcode(technician, product, "ALLOC-BARCODE")
    expires = (date.today() + timedelta(days=200)).isoformat()
    stock = svc.receive(technician, "ALLOC-BARCODE", "LOT-ALLOCATION", expires, "100")
    locations = InventoryLocationService(svc)
    a = locations.create(pharmacist, "A", "Reconciled receiving shelf", "SHELF",
        is_default_receiving=True, is_default_dispensing=True)
    b = locations.create(pharmacist, "B", "Alternate pick bin", "BIN")
    locations.activate_stock(pharmacist, stock, a,
        "Independent count of one hundred synthetic units on main shelf.")
    locations.move(technician, stock, a, b, "40",
        "Move forty units to alternate synthetic pick bin")
    rx = svc.add_prescription(technician, patient, prescriber, drug,
        "RX-PHYSICAL-ALLOC", "one tablet daily", "30", refills=1)
    svc.advance_to_dur(technician, rx)
    fill = svc.start_fill(technician, rx)
    return svc, users, other, stock, a, b, rx, fill, expires, locations


def _pick(env, quantity="30"):
    svc, users, _, stock, a, b, rx, fill, expiry, locations = env
    svc.scan_source(users["TECHNICIAN"], fill,
        "ALLOC-BARCODE", "LOT-ALLOCATION", expiry,
        quantity, location_id=b)


def test_tracked_stock_scan_requires_location_and_is_rolled_back(env):
    svc, users, _, stock, a, b, rx, fill, expiry, locations = env
    with pytest.raises(WorkflowError, match="explicitly confirmed"):
        svc.scan_source(users["TECHNICIAN"], fill,
            "ALLOC-BARCODE", "LOT-ALLOCATION", expiry, "30")
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == Decimal("0")
        assert s.query(FillSource).count() == 0
        assert s.query(InventoryAllocation).count() == 0
    _pick(env)
    rows = InventoryAllocationService(svc).for_fill(users["AUDITOR"], fill)
    assert len(rows) == 1
    assert rows[0]["status"] == "ACTIVE"
    assert rows[0]["location_code"] == "B"
    assert rows[0]["quantity"] == "30.000"
    assert [e["to"] for e in rows[0]["events"]] == ["ACTIVE"]
    p = {pos["code"]: pos for pos in locations.positions(users["AUDITOR"], stock)}
    assert p["A"]["available"] == "60.000"
    assert p["B"]["available"] == "10.000"
    assert p["B"]["reserved"] == "30.000"


def test_pharmacist_consumes_allocated_exact_bin_and_keeps_history(env):
    svc, users, other, stock, a, b, rx, fill, expiry, locations = env
    _pick(env)
    svc.prepare_for_review(users["TECHNICIAN"], fill, [])
    svc.verify(users["PHARMACIST"], fill)
    history = InventoryAllocationService(svc).for_fill(users["AUDITOR"], fill)
    assert len(history) == 1
    assert history[0]["status"] == "CONSUMED"
    assert [x["to"] for x in history[0]["events"]] == ["ACTIVE", "CONSUMED"]
    assert history[0]["resolved_at"] is not None
    positions = {pos["code"]: pos for pos in locations.positions(users["AUDITOR"], stock)}
    assert positions["B"]["available"] == "10.000"
    assert positions["B"]["reserved"] == "0.000"
    assert positions["A"]["available"] == "60.000"
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == 70
        assert s.query(InventoryAllocationEvent).count() == 2
    with pytest.raises(WorkflowError, match="Fill not awaiting pharmacist"):
        svc.verify(users["PHARMACIST"], fill)
    with pytest.raises(WorkflowError):
        InventoryAllocationService(svc).for_fill(other["AUDITOR"], fill)


def test_unverified_cancel_releases_exact_reserved_bin_and_retains_allocations(env):
    svc, users, other, stock, a, b, rx, fill, expiry, locations = env
    _pick(env)
    LifecycleService(svc).cancel(users["TECHNICIAN"], rx, "Synthetic patient declined fill")
    hist = InventoryAllocationService(svc).for_fill(users["AUDITOR"], fill)
    assert hist[0]["status"] == "RELEASED"
    assert [e["to"] for e in hist[0]["events"]] == ["ACTIVE", "RELEASED"]
    positions = {pos["code"]: pos for pos in locations.positions(users["AUDITOR"], stock)}
    assert positions["A"]["available"] == "60.000"
    assert positions["B"]["available"] == "40.000"
    assert positions["B"]["reserved"] == "0.000"
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == 100
        assert s.get(Stock, stock).reserved == 0


def test_partial_interrupt_retains_deleted_source_lineage_and_fresh_repick(env):
    svc, users, _, stock, a, b, rx, fill, expiry, locations = env
    _pick(env)
    FillCompletionService(svc).interrupt_as_partial(users["TECHNICIAN"], fill, "10",
        "Product fill found a shortage; original source invalidated for rescanning")
    hist = InventoryAllocationService(svc).for_fill(users["AUDITOR"], fill)
    assert len(hist) == 1
    assert hist[0]["status"] == "RELEASED"
    assert hist[0]["source_id"] is None
    with svc.sessions() as s:
        assert s.query(FillSource).count() == 0
        assert s.get(Stock, stock).reserved == 0
    svc.scan_source(users["TECHNICIAN"], fill,
        "ALLOC-BARCODE", "LOT-ALLOCATION", expiry, "10", location_id=b)
    hist = InventoryAllocationService(svc).for_fill(users["AUDITOR"], fill)
    assert len(hist) == 2
    assert sorted(x["status"] for x in hist) == ["ACTIVE", "RELEASED"]
    svc.prepare_for_review(users["TECHNICIAN"], fill, [])
    svc.verify(users["PHARMACIST"], fill)
    hist = InventoryAllocationService(svc).for_fill(users["AUDITOR"], fill)
    assert sorted(x["status"] for x in hist) == ["CONSUMED", "RELEASED"]


def test_scanned_allocation_cannot_consume_another_location_reservation(env):
    svc, users, _, stock, a, b, rx, fill, expiry, locations = env
    _pick(env)
    with svc.sessions.begin() as s:
        allocation = s.scalar(select(InventoryAllocation))
        wrong_position = s.scalar(select(InventoryStockPosition).where(
            InventoryStockPosition.stock_id == stock,
            InventoryStockPosition.location_id == a))
        allocation.position_id = wrong_position.id
    svc.prepare_for_review(users["TECHNICIAN"], fill, [])
    with pytest.raises(WorkflowError, match="reserved units"):
        svc.verify(users["PHARMACIST"], fill)
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == 30
        assert s.scalar(select(InventoryAllocation)).status == "ACTIVE"


def test_fill_allocation_api_and_untracked_legacy_compatibility(env):
    svc, users, outside, stock, a, b, rx, fill, expiry, locations = env
    _pick(env)
    api = TestClient(create_app(svc, synthetic_enabled=True))
    url = f"/api/inventory/fills/{fill}/allocations"
    auditor = {"x-demo-staff-id": users["AUDITOR"].id}
    assert api.get(url, headers=auditor).status_code == 200
    assert len(api.get(url, headers=auditor).json()["allocations"]) == 1
    assert api.get(url, headers={
        "x-demo-staff-id": outside["AUDITOR"].id}).status_code == 409
    off = TestClient(create_app(svc, synthetic_enabled=False))
    assert off.get(url, headers=auditor).status_code == 503
    # Previous untracked lots still lack fabricated allocations.
    second_drug = svc.add_drug(users["PHARMACIST"], "Untracked Drug", "1mg", "tablet")
    other_product = svc.add_product(users["PHARMACIST"], second_drug,
        "19191-0022-34", "TestLab", "Synthetic yellow tablet")
    svc.register_barcode(users["TECHNICIAN"], other_product, "NO-LOC-BC")
    svc.receive(users["TECHNICIAN"], "NO-LOC-BC", "OLD-LOT", expiry, "20")
    patient = svc.add_patient(users["TECHNICIAN"], "Synthetic", "Legacy")
    provider = svc.add_prescriber(users["TECHNICIAN"], "Synthetic", "OtherDoctor", "MD")
    second_rx = svc.add_prescription(users["TECHNICIAN"], patient, provider, second_drug,
        "RX-UNTRACKED-ALLOC", "one daily", "10")
    svc.advance_to_dur(users["TECHNICIAN"], second_rx)
    second_fill = svc.start_fill(users["TECHNICIAN"], second_rx)
    svc.scan_source(users["TECHNICIAN"], second_fill, "NO-LOC-BC", "OLD-LOT",
                    expiry, "10")
    assert InventoryAllocationService(svc).for_fill(users["AUDITOR"], second_fill) == []
