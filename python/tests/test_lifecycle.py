from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from pharmacy1os.lifecycle import LifecycleService
from pharmacy1os.models import Claim, Fill, Prescription, Stock
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def context():
    service = PharmacyService()
    service.create_schema()
    actors = service.bootstrap_demo()["actors"]
    tech = actors["TECHNICIAN"]
    pharm = actors["PHARMACIST"]
    patient = service.add_patient(tech, "Synthetic", "Patient")
    prescriber = service.add_prescriber(tech, "Fake", "Doctor", "MD")
    drug = service.add_drug(pharm, "Demo", "25mg", "tablet")
    prod = service.add_product(pharm, drug, "00000-1234-04", "Demo", "White")
    service.register_barcode(tech, prod, "BAR-LIFE")
    exp = (date.today() + timedelta(days=180)).isoformat()
    stock = service.receive(tech, "BAR-LIFE", "SYNTHLOT", exp, "100")
    rx = service.add_prescription(tech, patient, prescriber, drug, "SYN-RX-LIFE", "Once daily", "90")
    service.advance_to_dur(tech, rx)
    return service, actors, rx, stock, exp


def test_hold_resume_rechecks_high_dur(context):
    service, actors, rx, stock, exp = context
    tech = actors["TECHNICIAN"]
    pharm = actors["PHARMACIST"]
    lifecycle = LifecycleService(service)
    fill = service.start_fill(tech, rx)
    service.scan_source(tech, fill, "BAR-LIFE", "SYNTHLOT", exp, "20")
    lifecycle.hold(tech, rx, "Ask patient")
    with pytest.raises(WorkflowError):
        service.scan_source(tech, fill, "BAR-LIFE", "SYNTHLOT", exp, "70")
    dur = service.add_dur_issue(pharm, rx, "HIGH", "SYNTH_TEST")
    with pytest.raises(WorkflowError):
        lifecycle.resume(tech, rx, "Ready")
    with service.sessions() as s:
        assert s.get(Prescription, rx).status == "ON_HOLD"
    service.resolve_dur(pharm, dur, "Fake warning resolved")
    lifecycle.resume(tech, rx, "Confirmed")
    with service.sessions() as s:
        assert s.get(Prescription, rx).status == "PRODUCT_FILL"


def test_cancel_releases_reservations_and_claims(context):
    service, actors, rx, stock, exp = context
    tech = actors["TECHNICIAN"]
    lifecycle = LifecycleService(service)
    fid = service.start_fill(tech, rx)
    service.scan_source(tech, fid, "BAR-LIFE", "SYNTHLOT", exp, "90")
    service.prepare_for_review(tech, fid, ["Synthetic payer"])
    lifecycle.cancel(tech, rx, "Synthetic prescription entered in error")
    with service.sessions() as s:
        assert s.get(Stock, stock).reserved == 0
        assert s.get(Stock, stock).on_hand == Decimal("100")
        assert s.get(Fill, fid).status == "CANCELLED"
        assert s.scalar(select(Claim).where(Claim.fill_id == fid)).status == "REVERSED_SYNTHETIC"
        assert s.get(Prescription, rx).status == "CANCELLED"
    with pytest.raises(WorkflowError):
        lifecycle.cancel(tech, rx, "Duplicate")


def test_cancel_ready_restores_stock_and_hold_cancel(context):
    service, actors, rx, stock, exp = context
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    lifecycle = LifecycleService(service)
    fid = service.start_fill(tech, rx)
    service.scan_source(tech, fid, "BAR-LIFE", "SYNTHLOT", exp, "90")
    service.prepare_for_review(tech, fid, ["Demo"])
    service.verify(pharm, fid)
    lifecycle.hold(tech, rx, "On hold for synthetic patient")
    lifecycle.cancel(tech, rx, "Synthetic cancellation")
    with service.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal("100")
        assert s.get(Fill, fid).status == "CANCELLED"


def test_other_site_cannot_cancel(context):
    service, actors, rx, stock, exp = context
    other = service.bootstrap_demo()["actors"]["PHARMACIST"]
    with pytest.raises(WorkflowError):
        LifecycleService(service).cancel(other, rx, "Wrong pharmacy")
