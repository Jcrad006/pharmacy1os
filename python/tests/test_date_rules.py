"""Synthetic-only tests for historical sale/refill eligibility and hard clinical gates."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.date_rules import DateRulesService, FillSaleTimestamp, PrescriptionDatePolicy
from pharmacy1os.models import Audit, Fill, Prescription, Sale
from pharmacy1os.scheduling import SchedulingService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    p = svc.add_patient(tech, "Synthetic", "Subject")
    pres = svc.add_prescriber(tech, "Synthetic", "Authorizer", "MD")
    drug = svc.add_drug(pharm, "IntervalTest", "1 mg", "tablet")
    product = svc.add_product(pharm, drug, "99999-1111-22", "TestBrand", "tablet")
    svc.register_barcode(tech, product, "DATE-RULE-BARCODE")
    expiry = (date.today()+timedelta(days=400)).isoformat()
    svc.receive(tech, "DATE-RULE-BARCODE", "DATE-LOT", expiry, "250")
    rx = svc.add_prescription(tech, p, pres, drug, "DATE-RX-1", "One daily", "30", refills=2)
    svc.advance_to_dur(tech, rx)
    return svc, actors, rx, expiry


def sell_first(env):
    svc, actors, rx, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    fill = svc.start_fill(tech, rx)
    svc.scan_source(tech, fill, "DATE-RULE-BARCODE", "DATE-LOT", expiry, "30")
    svc.prepare_for_review(tech, fill, [])
    svc.verify(pharm, fill)
    svc.sell(actors["CASHIER"], fill, True, True, "0", "CASH")
    return fill


def test_interval_blocks_refill_atomically_then_allows_after_elapsed(env):
    svc, actors, rx, _ = env
    first = sell_first(env)
    policy = DateRulesService(svc)
    policy.set_minimum_days(actors["PHARMACIST"], rx, 21, "Synthetic interval validation")
    SchedulingService(svc).begin_refill_review(actors["TECHNICIAN"], rx, "Patient requested refill")
    with pytest.raises(WorkflowError, match="REFILL_TOO_SOON"):
        svc.start_fill(actors["TECHNICIAN"], rx)
    with svc.sessions() as session:
        assert len(session.scalars(select(Fill)).all()) == 1
        assert session.scalar(select(FillSaleTimestamp).where(FillSaleTimestamp.fill_id == first)) is not None
    with svc.sessions.begin() as session:
        event = session.scalar(select(FillSaleTimestamp).where(FillSaleTimestamp.fill_id == first))
        event.sold_at = datetime.now(timezone.utc) - timedelta(days=22)
    fill_id = svc.start_fill(actors["TECHNICIAN"], rx)
    with svc.sessions() as session:
        assert session.get(Fill, fill_id).fill_number == 1
        assert any(a.kind == "RX_DATE_POLICY_CHANGED" for a in session.scalars(select(Audit)))


def test_unknown_sold_timestamp_fails_closed_no_guess(env):
    svc, actors, rx, _ = env
    with svc.sessions.begin() as s:
        r = s.get(Prescription, rx)
        r.status = "SOLD"
        f = Fill(prescription_id=rx, fill_number=0, attempt=1,
                 status="SOLD", quantity=Decimal("30"), billed_quantity=Decimal("30"))
        s.add(f)
        s.flush()
        s.add(Sale(fill_id=f.id, verified_identity=True,
                   signature_attested=True, tender="CASH", amount=Decimal("0")))
    DateRulesService(svc).set_minimum_days(actors["PHARMACIST"], rx, 30, "Legacy sale missing verified time")
    SchedulingService(svc).begin_refill_review(actors["TECHNICIAN"], rx, "Follow-up")
    with pytest.raises(WorkflowError, match="SALE_TIME_UNKNOWN"):
        svc.start_fill(actors["TECHNICIAN"], rx)
    preview = DateRulesService(svc).preview(actors["TECHNICIAN"], rx)
    assert preview["eligible"] is False
    assert preview["blocks"][0]["code"] == "SALE_TIME_UNKNOWN"


def test_scheduled_refill_future_date_rechecked_and_not_early(env):
    svc, actors, rx, _ = env
    first = sell_first(env)
    DateRulesService(svc).set_minimum_days(actors["PHARMACIST"], rx, 10, "Synthetic refill interval")
    SchedulingService(svc).begin_refill_review(actors["TECHNICIAN"], rx, "Review")
    tomorrow=(date.today()+timedelta(days=1)).isoformat()
    with pytest.raises(WorkflowError, match="REFILL_TOO_SOON"):
        SchedulingService(svc).schedule(actors["TECHNICIAN"], rx, tomorrow, "too-soon")
    with svc.sessions.begin() as s:
        s.scalar(select(FillSaleTimestamp).where(FillSaleTimestamp.fill_id == first)).sold_at = (
            datetime.now(timezone.utc)-timedelta(days=15))
    schedule = SchedulingService(svc).schedule(actors["TECHNICIAN"], rx, tomorrow, "valid")
    with pytest.raises(WorkflowError, match="not due"):
        SchedulingService(svc).start_due(actors["TECHNICIAN"], schedule)
    started = SchedulingService(svc).start_due(actors["TECHNICIAN"], schedule,
                                                   today=date.today()+timedelta(days=1))
    assert started


def test_policy_roles_site_validation_and_api(env):
    svc, actors, rx, _ = env
    rules=DateRulesService(svc)
    with pytest.raises(AccessDenied):
        rules.set_minimum_days(actors["TECHNICIAN"], rx, 20, "Not pharmacist")
    for value in (-1, 366, 2.5, True, "ten"):
        with pytest.raises(WorkflowError):
            rules.set_minimum_days(actors["PHARMACIST"], rx, value, "invalid")
    other=svc.bootstrap_demo()["actors"]["PHARMACIST"]
    with pytest.raises(WorkflowError):
        rules.preview(other, rx)
    with pytest.raises(WorkflowError):
        rules.set_minimum_days(other, rx, 10, "Cross-site attempt")
    api=TestClient(create_app(svc, synthetic_enabled=True))
    pharm_header={"x-demo-staff-id":actors["PHARMACIST"].id}
    tech_header={"x-demo-staff-id":actors["TECHNICIAN"].id}
    assert api.post(f"/api/prescriptions/{rx}/date-rules",headers=tech_header,
        json={"minimum_days_between_fills":15,"reason":"deny"}).status_code==403
    res=api.post(f"/api/prescriptions/{rx}/date-rules",headers=pharm_header,
        json={"minimum_days_between_fills":15,"reason":"Changed after clinical review"})
    assert res.status_code==200, res.text
    preview=api.get(f"/api/prescriptions/{rx}/date-rules",headers=tech_header)
    assert preview.status_code==200
    assert preview.json()["minimum_days_between_fills"]==15
    assert api.get(f"/api/prescriptions/{rx}/date-rules?target_day=2026-02-30",headers=tech_header).status_code==409


def test_invalid_original_prescription_date_cannot_bypass(env):
    svc,actors,rx,_=env
    with svc.sessions.begin() as s:
        s.get(Prescription,rx).expiration_date="not-a-date"
    with pytest.raises(WorkflowError, match="expiration"):
        svc.start_fill(actors["TECHNICIAN"],rx)


def test_single_fill_checkout_writes_timestamp_once(env):
    svc,actors,rx,_=env
    first=sell_first(env)
    with svc.sessions() as s:
        ev=s.scalars(select(FillSaleTimestamp).where(FillSaleTimestamp.fill_id==first)).all()
        assert len(ev)==1
        assert ev[0].site_id==actors["CASHIER"].site_id
