
"""Synthetic-only scan quantity corrections and inventory consistency checks."""
from datetime import date, timedelta
from decimal import Decimal
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_allocations import InventoryAllocationService
from pharmacy1os.inventory_locations import InventoryLocationService
from pharmacy1os.models import FillSource, Stock, Audit, InventoryMovement
from pharmacy1os.service import PharmacyService, WorkflowError, AccessDenied


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    foreign = svc.bootstrap_demo()["actors"]
    pharma, tech = a["PHARMACIST"], a["TECHNICIAN"]
    drug = svc.add_drug(pharma, "SYNTHETIC SOURCE QTY", "10mg", "tablet")
    product = svc.add_product(pharma, drug, "00000-7777-88", "Demo", "Demo pill")
    svc.register_barcode(tech, product, "SYN-QTY-BAR")
    expires = (date.today() + timedelta(days=260)).isoformat()
    stock = svc.receive(tech, "SYN-QTY-BAR", "SYN-QTY-LOT", expires, "50")
    patient = svc.add_patient(tech, "Synthetic", "Qty")
    doctor = svc.add_prescriber(tech, "Demo", "Doctor", "MD")
    rx = svc.add_prescription(tech, patient, doctor, drug, "SYN-RX-SOURCE-QTY", "once daily", "30")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx)
    return svc, a, foreign, fill, stock, expires


def test_untracked_correction_updates_exact_stock_reservation_and_audit(case):
    svc, a, foreign, fill, stock, exp = case
    tech = a["TECHNICIAN"]
    svc.scan_source(tech, fill, "SYN-QTY-BAR", "SYN-QTY-LOT", exp, "10")
    source = svc.scanned_sources(tech, fill)[0]
    raised = svc.correct_scanned_source_quantity(tech, fill, source["id"], "18",
        "Verified that the first scan was missing eight tablets")
    assert raised["delta"] == "8.000"
    assert raised["before"] == "10.000"
    assert raised["after"] == "18"
    assert raised["location_id"] is None
    reduced = svc.correct_scanned_source_quantity(tech, fill, source["id"], "8",
        "Recounted package and corrected total to eight tablets")
    assert reduced["delta"] == "-10.000"
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == Decimal("8")
        assert s.get(Stock, stock).on_hand == Decimal("50")
        assert s.get(FillSource, source["id"]).quantity == Decimal("8")
        assert len(s.scalars(select(InventoryMovement).where(
            InventoryMovement.kind == "FILL_SOURCE_QUANTITY_CORRECTION")).all()) == 2
        assert len(s.scalars(select(Audit).where(
            Audit.kind == "FILL_PRODUCT_SOURCE_QUANTITY_CORRECTED")).all()) == 2
    svc.correct_scanned_source_quantity(tech, fill, source["id"], "30",
        "Recounted all tablets and corrected to authorized physical quantity")
    svc.prepare_for_review(tech, fill, [])
    with pytest.raises(WorkflowError, match="Product Fill"):
        svc.correct_scanned_source_quantity(tech, fill, source["id"], "20",
            "Cannot change physical source after labels are created")


def test_invalid_correction_rolls_back_and_enforces_roles(case):
    svc, a, foreign, fill, stock, exp = case
    tech = a["TECHNICIAN"]
    svc.scan_source(tech, fill, "SYN-QTY-BAR", "SYN-QTY-LOT", exp, "10")
    source = svc.scanned_sources(tech, fill)[0]
    for new_qty, phrase in [
        ("0", "positive"), ("30.0001", "three decimals"),
        ("31", "exceed actual"), ("55", "exceed actual"),
        ("10", "unchanged"), ("invalid", "valid decimal"),
    ]:
        with pytest.raises(WorkflowError, match=phrase):
            svc.correct_scanned_source_quantity(tech, fill, source["id"], new_qty,
                "Test case should not adjust confirmed scanned stock")
    with pytest.raises(WorkflowError, match="12"):
        svc.correct_scanned_source_quantity(tech, fill, source["id"], "12", "short")
    with pytest.raises(WorkflowError, match="only applicable"):
        svc.correct_scanned_source_quantity(tech, fill, source["id"], "8",
            "FEFO override not needed for quantity reduction", fefo_override_note="Not needed")
    with pytest.raises(AccessDenied):
        svc.correct_scanned_source_quantity(a["AUDITOR"], fill, source["id"], "12",
            "Auditor is not allowed to change stock reservations")
    with pytest.raises(WorkflowError, match="site"):
        svc.correct_scanned_source_quantity(foreign["TECHNICIAN"], fill, source["id"], "12",
            "Cannot change a source from another pharmacy site")
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == Decimal("10")
        assert s.get(FillSource, source["id"]).quantity == Decimal("10")
        assert s.scalar(select(Audit.id).where(
            Audit.kind == "FILL_PRODUCT_SOURCE_QUANTITY_CORRECTED")) is None


def test_tracked_correction_preserves_exact_bin_and_allocation(case):
    svc, a, foreign, fill, stock, exp = case
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    locations = InventoryLocationService(svc)
    loc_a = locations.create(pharm, "QTY-A", "Receiving", "BIN")
    loc_b = locations.create(pharm, "QTY-B", "Dispensing", "BIN")
    locations.activate_stock(pharm, stock, loc_a,
        "Counted fifty synthetic tablets at receiving location")
    locations.move(tech, stock, loc_a, loc_b, "20",
        "Moved twenty units to product-fill bin before scanning")
    svc.scan_source(tech, fill, "SYN-QTY-BAR", "SYN-QTY-LOT", exp, "10", location_id=loc_b)
    source = svc.scanned_sources(tech, fill)[0]
    updated = svc.correct_scanned_source_quantity(tech, fill, source["id"], "15",
        "Scanned source actually contains fifteen units on verified recount")
    assert updated["location_id"] == loc_b
    positions = locations.positions(tech, stock)
    at_bin = next(row for row in positions if row["location_id"] == loc_b)
    assert at_bin["reserved"] == "15.000"
    assert at_bin["available"] == "5.000"
    entries = InventoryAllocationService(svc).for_fill(tech, fill)
    assert len(entries) == 1
    assert entries[0]["quantity"] == "15.000"
    assert entries[0]["status"] == "ACTIVE"
    assert [row["to"] for row in entries[0]["events"]] == ["ACTIVE", "ACTIVE"]
    # Aggregate stock has headroom, but the specifically selected bin does not.
    with pytest.raises(WorkflowError, match="selected physical location"):
        svc.correct_scanned_source_quantity(tech, fill, source["id"], "25",
            "Bin only had five more tablets available after the first recount")
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == Decimal("15")
        assert s.get(FillSource, source["id"]).quantity == Decimal("15")
    svc.correct_scanned_source_quantity(tech, fill, source["id"], "6",
        "Pharmacist confirmed only six units in the scanned container")
    at_bin = next(row for row in locations.positions(tech, stock)
                  if row["location_id"] == loc_b)
    assert at_bin["reserved"] == "6.000"


def test_api_blocks_cross_site_and_disabled_live_mode(case):
    svc, a, foreign, fill, stock, exp = case
    tech = a["TECHNICIAN"]
    svc.scan_source(tech, fill, "SYN-QTY-BAR", "SYN-QTY-LOT", exp, "10")
    source = svc.scanned_sources(tech, fill)[0]
    path = f"/api/fills/{fill}/product-sources/{source['id']}/quantity"
    client = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    payload = {"quantity": "20", "reason": "Source quantity corrected after stock recount"}
    assert disabled.put(path, json=payload).status_code == 503
    assert client.put(path, json=payload).status_code == 403
    assert client.put(path, headers={"x-demo-staff-id": foreign["TECHNICIAN"].id},
                      json=payload).status_code == 409
    result = client.put(path, headers={"x-demo-staff-id": tech.id}, json=payload)
    assert result.status_code == 200, result.text
    assert result.json()["after"] == "20"
