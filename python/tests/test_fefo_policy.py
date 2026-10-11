"""Opt-in FEFO policy and audited pharmacist override for synthetic stock."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_fefo import FefoPolicyService
from pharmacy1os.inventory_locations import InventoryLocationService
from pharmacy1os.inventory_ops import InventoryService
from pharmacy1os.models import Audit, FillSource, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    drug = svc.add_drug(a["PHARMACIST"], "Synthetic FEFO", "10 mg", "tablet")
    product = svc.add_product(a["PHARMACIST"], drug,
        "40000-0909-11", "Demo", "Synthetic white tablet")
    svc.register_barcode(a["TECHNICIAN"], product, "FEFO-BC-1")
    early_date = (date.today() + timedelta(days=35)).isoformat()
    late_date = (date.today() + timedelta(days=250)).isoformat()
    early = svc.receive(a["TECHNICIAN"], "FEFO-BC-1", "FEFO-EARLY", early_date, "40")
    late = svc.receive(a["TECHNICIAN"], "FEFO-BC-1", "FEFO-LATE", late_date, "60")
    patient = svc.add_patient(a["TECHNICIAN"], "Synthetic", "FEFO")
    doctor = svc.add_prescriber(a["TECHNICIAN"], "Synthetic", "FEFODoctor", "MD")
    rx = svc.add_prescription(a["TECHNICIAN"], patient, doctor, drug,
        "SYNTH-FEFO-01", "one daily", "20")
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    fill = svc.start_fill(a["TECHNICIAN"], rx)
    return svc, a, other, product, early, late, early_date, late_date, fill


def test_policy_enforcement_blocks_later_lot_and_technician_override(env):
    svc, a, foreign, product, early, late, early_date, late_date, fill = env
    policy = FefoPolicyService(svc)
    with pytest.raises(AccessDenied):
        policy.configure(a["TECHNICIAN"], product, "ENFORCE", 0,
            "Technician must not change pharmacist stock policy")
    policy_id = policy.configure(a["PHARMACIST"], product, "ENFORCE", 0,
        "Prefer earliest unexpired physical NDC lot for dispensing")
    assert policy.list(a["AUDITOR"])[0]["id"] == policy_id
    assert policy.list(foreign["AUDITOR"]) == []
    with pytest.raises(WorkflowError, match="FEFO policy requires earlier stock"):
        svc.scan_source(a["TECHNICIAN"], fill,
            "FEFO-BC-1", "FEFO-LATE", late_date, "20")
    with pytest.raises(AccessDenied):
        svc.scan_source(a["TECHNICIAN"], fill,
            "FEFO-BC-1", "FEFO-LATE", late_date, "20",
            fefo_override_note="Pharmacist instructed selection of this lot")
    with svc.sessions() as s:
        assert s.get(Stock, late).reserved == 0
        assert s.query(FillSource).count() == 0
        assert s.scalar(select(Audit.id).where(
            Audit.kind == "FEFO_PHARMACIST_OVERRIDE")) is None
    svc.scan_source(a["TECHNICIAN"], fill,
        "FEFO-BC-1", "FEFO-EARLY", early_date, "20")
    with svc.sessions() as s:
        assert s.get(Stock, early).reserved == Decimal("20")
        assert s.get(Stock, late).reserved == 0


def test_pharmacist_documented_override_atomic_reservation(env):
    svc, a, foreign, product, early, late, early_date, late_date, fill = env
    FefoPolicyService(svc).configure(a["PHARMACIST"], product, "ENFORCE", 0,
        "Use first-expiring physical stock unless pharmacist documents exception")
    with pytest.raises(WorkflowError, match="12–1000"):
        svc.scan_source(a["PHARMACIST"], fill,
            "FEFO-BC-1", "FEFO-LATE", late_date, "20",
            fefo_override_note="short")
    svc.scan_source(a["PHARMACIST"], fill,
        "FEFO-BC-1", "FEFO-LATE", late_date, "20",
        fefo_override_note="Earlier lot was set aside pending the product check")
    with svc.sessions() as s:
        assert s.get(Stock, late).reserved == Decimal("20")
        row = s.scalar(select(Audit).where(Audit.kind == "FEFO_PHARMACIST_OVERRIDE"))
        assert row is not None
        assert early in row.detail and late in row.detail
        assert s.query(FillSource).count() == 1


def test_minimum_shelf_life_ignores_too_short_earlier_alternative(env):
    svc, a, foreign, product, early, late, early_date, late_date, fill = env
    FefoPolicyService(svc).configure(a["PHARMACIST"], product,
        "ENFORCE", 90, "Require at least ninety remaining days for normal pick")
    svc.scan_source(a["TECHNICIAN"], fill,
        "FEFO-BC-1", "FEFO-LATE", late_date, "20")
    with svc.sessions() as s:
        assert s.get(Stock, late).reserved == Decimal("20")


def test_short_life_selected_rejected_and_audited_override(env):
    svc, a, foreign, product, early, late, early_date, late_date, fill = env
    FefoPolicyService(svc).configure(a["PHARMACIST"], product,
        "ENFORCE", 90, "Require three-month shelf life unless documented")
    with pytest.raises(WorkflowError, match="BELOW_MIN_SHELF_LIFE"):
        svc.scan_source(a["TECHNICIAN"], fill,
            "FEFO-BC-1", "FEFO-EARLY", early_date, "20")
    svc.scan_source(a["PHARMACIST"], fill,
        "FEFO-BC-1", "FEFO-EARLY", early_date, "20",
        fefo_override_note="Documented specific short-duration synthetic dispense")
    with svc.sessions() as s:
        assert s.get(Stock, early).reserved == Decimal("20")
        assert s.scalar(select(Audit.id).where(
            Audit.kind == "FEFO_PHARMACIST_OVERRIDE")) is not None


def test_advisory_only_does_not_block_and_disallows_fake_override(env):
    svc, a, foreign, product, early, late, early_date, late_date, fill = env
    policies = FefoPolicyService(svc)
    policies.configure(a["PHARMACIST"], product, "ADVISORY", 0,
        "Show FEFO warning but let the technician continue")
    with pytest.raises(WorkflowError, match="advisory-only"):
        svc.scan_source(a["TECHNICIAN"], fill,
            "FEFO-BC-1", "FEFO-LATE", late_date, "20",
            fefo_override_note="Fake pharmacist FEFO override is not allowed")
    svc.scan_source(a["TECHNICIAN"], fill,
        "FEFO-BC-1", "FEFO-LATE", late_date, "20")
    with svc.sessions() as s:
        assert s.scalar(select(Audit.id).where(Audit.kind == "FEFO_PICK_ADVISORY"))
    assert policies.configure(a["PHARMACIST"], product, "ENFORCE", 0,
        "Later date review by supervising pharmacist", enabled=False)
    assert policies.list(a["AUDITOR"])[0]["enabled"] is False


def test_quarantined_earlier_stock_not_a_fefo_alternative(env):
    svc, a, foreign, product, early, late, early_date, late_date, fill = env
    InventoryService(svc).create_hold(a["TECHNICIAN"], early, "40",
        "Quarantined early lot not available for physical fill")
    FefoPolicyService(svc).configure(a["PHARMACIST"], product, "ENFORCE", 0,
        "Use earliest available unexpired lot only")
    svc.scan_source(a["TECHNICIAN"], fill,
        "FEFO-BC-1", "FEFO-LATE", late_date, "20")
    with svc.sessions() as s:
        assert s.get(Stock, early).quarantined == Decimal("40")


def test_policy_api_permission_and_optin(env):
    svc, a, foreign, product, early, late, early_date, late_date, fill = env
    api = TestClient(create_app(svc, synthetic_enabled=True))
    path = "/api/inventory/fefo/policies"
    payload = {"product_id": product, "mode": "ENFORCE",
        "minimum_shelf_life_days": 12, "enabled": True,
        "reason": "New pharmacist standard for FEFO stock selection"}
    pharma = {"x-demo-staff-id": a["PHARMACIST"].id}
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    assert api.post(path, json=payload, headers=tech).status_code == 403
    assert api.post(path, json={**payload, "minimum_shelf_life_days": 4000},
        headers=pharma).status_code == 422
    created = api.post(path, json=payload, headers=pharma)
    assert created.status_code == 201
    assert api.get(path, headers=tech).json()["policies"][0]["id"] == created.json()["id"]
    assert TestClient(create_app(svc, synthetic_enabled=False)).get(
        path, headers=pharma).status_code == 503


def test_location_tracked_earlier_stock_enforces_only_usable_positions(env):
    svc, a, foreign, product, early, late, early_date, late_date, fill = env
    locations = InventoryLocationService(svc)
    shelf = locations.create(a["PHARMACIST"], "FEFO-01", "FEFO shelf", "SHELF")
    locations.activate_stock(a["PHARMACIST"], early, shelf,
        "Counted physical forty units in the FEFO shelf")
    FefoPolicyService(svc).configure(a["PHARMACIST"], product, "ENFORCE", 0,
        "Track first-expiring physical available stock in shelf")
    with pytest.raises(WorkflowError, match="EARLIER_USABLE_LOT"):
        svc.scan_source(a["TECHNICIAN"], fill,
            "FEFO-BC-1", "FEFO-LATE", late_date, "20")
