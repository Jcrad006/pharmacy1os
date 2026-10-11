from datetime import date, timedelta
from decimal import Decimal
import pytest
from sqlalchemy import select
from fastapi.testclient import TestClient
from pharmacy1os.api import create_app
from pharmacy1os.models import Audit, Fill, Prescription
from pharmacy1os.scheduling_models import ScheduledFill
from pharmacy1os.scheduling import SchedulingService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError

@pytest.fixture
def seed():
    svc=PharmacyService()
    svc.create_schema()
    ac=svc.bootstrap_demo()["actors"]
    p=svc.add_patient(ac["TECHNICIAN"], "Test", "Person")
    dr=svc.add_prescriber(ac["TECHNICIAN"], "Doc", "Test", "MD")
    drug=svc.add_drug(ac["PHARMACIST"], "StudyMed", "10 mg", "tablet")
    rx=svc.add_prescription(ac["TECHNICIAN"], p, dr, drug, "RX-SCH-1", "Take daily", "30", refills=1)
    svc.advance_to_dur(ac["TECHNICIAN"], rx)
    return svc,ac,rx, SchedulingService(svc)


def test_future_requires_due_and_dur(seed):
    svc,ac,rx,sch=seed
    today=date.today()
    due=(today+timedelta(days=4)).isoformat()
    sid=sch.schedule(ac["TECHNICIAN"],rx,due,"req-1", "20")
    with pytest.raises(WorkflowError, match="pending future fill"):
        svc.start_fill(ac["TECHNICIAN"],rx)
    with pytest.raises(WorkflowError, match="not due"):
        sch.start_due(ac["TECHNICIAN"],sid,today=today)
    with svc.sessions() as s:
        assert s.scalar(select(Fill.id)) is None
    fill=sch.start_due(ac["TECHNICIAN"],sid,today=today+timedelta(days=4))
    assert fill==sch.start_due(ac["TECHNICIAN"],sid,today=today+timedelta(days=4))
    with svc.sessions() as s:
        assert s.get(Fill,fill).quantity==Decimal("20")
        assert s.get(Fill,fill).billed_quantity==Decimal("30")
        assert s.get(ScheduledFill,sid).status=="STARTED"
        assert len(s.scalars(select(Fill)).all())==1


def test_cancel_reasons_and_replacement(seed):
    svc,ac,rx,sch=seed
    due=(date.today()+timedelta(days=1)).isoformat()
    sid=sch.schedule(ac["TECHNICIAN"],rx,due,"req-2")
    with pytest.raises(WorkflowError,match="reason"):
        sch.cancel(ac["TECHNICIAN"],sid, "")
    sch.cancel(ac["TECHNICIAN"],sid,"Patient asked")
    with pytest.raises(WorkflowError,match="not pending"):
        sch.start_due(ac["TECHNICIAN"],sid,today=date.today()+timedelta(days=2))
    sid2=sch.schedule(ac["TECHNICIAN"],rx,due,"req-3")
    assert sid2!=sid
    assert len(sch.list(ac["TECHNICIAN"]))==2
    with pytest.raises(WorkflowError,match="pending scheduled"):
        sch.schedule(ac["TECHNICIAN"],rx,due,"req-4")


def test_key_replay_is_idempotent_and_conflict_rejected(seed):
    svc,ac,rx,sch=seed
    due=(date.today()+timedelta(days=1)).isoformat()
    sid=sch.schedule(ac["TECHNICIAN"],rx,due,"stable-123", "15")
    assert sid==sch.schedule(ac["TECHNICIAN"],rx,due,"stable-123", "15")
    with pytest.raises(WorkflowError,match="Idempotency"):
        sch.schedule(ac["TECHNICIAN"],rx,due,"stable-123", "16")


def test_site_isolation_role_gates_and_audit(seed):
    svc,ac,rx,sch=seed
    other=svc.bootstrap_demo()["actors"]["TECHNICIAN"]
    due=(date.today()+timedelta(days=1)).isoformat()
    with pytest.raises(WorkflowError):
        sch.schedule(other,rx,due,"other")
    with pytest.raises(AccessDenied):
        sch.schedule(ac["AUDITOR"],rx,due,"auditor")
    sid=sch.schedule(ac["TECHNICIAN"],rx,due,"mine")
    assert sch.list(other)==[]
    with pytest.raises(WorkflowError):
        sch.cancel(other,sid,"no access")
    with svc.sessions() as s:
        assert any(x.kind=="FILL_SCHEDULED" for x in s.scalars(select(Audit)))


def test_invalid_dates_and_dur_block_atomic(seed):
    svc,ac,rx,sch=seed
    tech=ac["TECHNICIAN"]
    for invalid in ("2026-02-30", "tomorrow", "2026-01-01T00:00", "2026-2-3"):
        with pytest.raises(WorkflowError):
            sch.schedule(tech,rx,invalid,"bad-date")
    due=date.today().isoformat()
    sid=sch.schedule(tech,rx,due,"ok-date")
    issue=svc.add_dur_issue(ac["PHARMACIST"],rx,"HIGH","CHECK")
    with pytest.raises(WorkflowError, match="DUR"):
        sch.start_due(tech,sid)
    with svc.sessions() as s:
        assert s.get(ScheduledFill,sid).status=="PENDING"
        assert s.scalar(select(Fill.id)) is None
    svc.resolve_dur(ac["PHARMACIST"],issue,"Reviewed synthetic")
    assert sch.start_due(tech,sid)


def test_expiration_and_not_before(seed):
    svc,ac,rx,sch=seed
    with svc.sessions.begin() as s:
        r=s.get(Prescription,rx)
        r.expiration_date=(date.today()+timedelta(days=2)).isoformat()
        r.do_not_fill_before=(date.today()+timedelta(days=1)).isoformat()
    with pytest.raises(WorkflowError,match="do-not-fill"):
        sch.schedule(ac["TECHNICIAN"],rx,date.today().isoformat(),"early")
    with pytest.raises(WorkflowError,match="expiration"):
        sch.schedule(ac["TECHNICIAN"],rx,(date.today()+timedelta(days=3)).isoformat(),"late")
    sid=sch.schedule(ac["TECHNICIAN"],rx,(date.today()+timedelta(days=1)).isoformat(),"okay")
    with pytest.raises(WorkflowError,match="not due"):
        sch.start_due(ac["TECHNICIAN"],sid,today=date.today())


def test_refill_review_cannot_bypass_sold_state(seed):
    svc,ac,rx,sch=seed
    with pytest.raises(WorkflowError,match="after a sold"):
        sch.begin_refill_review(ac["TECHNICIAN"],rx,"test")
    with svc.sessions.begin() as s:
        r=s.get(Prescription,rx)
        r.status="SOLD"
        f=Fill(prescription_id=rx,fill_number=0,attempt=1,quantity=Decimal("30"),billed_quantity=Decimal("30"),status="SOLD")
        s.add(f)
    sch.begin_refill_review(ac["TECHNICIAN"],rx,"Patient requested refill")
    with svc.sessions() as s:
        assert s.get(Prescription,rx).status=="DUR_REVIEW"
    with svc.sessions.begin() as s:
        s.get(Prescription,rx).status="SOLD"
        s.add(Fill(prescription_id=rx,fill_number=1,attempt=1,quantity=Decimal("30"),billed_quantity=Decimal("30"),status="SOLD"))
    with pytest.raises(WorkflowError,match="No refills"):
        sch.begin_refill_review(ac["TECHNICIAN"],rx,"another")


def test_scheduling_api(seed):
    svc,ac,rx,sch=seed
    c=TestClient(create_app(svc,synthetic_enabled=True))
    hdr={"x-demo-staff-id":ac["TECHNICIAN"].id}
    due=date.today().isoformat()
    r=c.post("/api/scheduled-fills",json={"prescription_id":rx,"due_date":due,"idempotency_key":"http-1"},headers=hdr)
    assert r.status_code==201, r.text
    sid=r.json()["id"]
    assert len(c.get("/api/scheduled-fills",headers=hdr).json()["scheduled_fills"])==1
    r=c.post(f"/api/scheduled-fills/{sid}/start",headers=hdr)
    assert r.status_code==200, r.text
    assert r.json()["fill_id"]
    assert c.post(f"/api/scheduled-fills/{sid}/start",headers=hdr).json()["fill_id"]==r.json()["fill_id"]
