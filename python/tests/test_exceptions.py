from datetime import date, timedelta
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from pharmacy1os.exceptions import ExceptionService
from pharmacy1os.scheduling_models import ScheduledFill
from pharmacy1os.service import PharmacyService, WorkflowError
from pharmacy1os.api import create_app

@pytest.fixture
def state():
    svc=PharmacyService();svc.create_schema()
    staff=svc.bootstrap_demo()["actors"]
    patient=svc.add_patient(staff["TECHNICIAN"],"Sample","Person")
    pre=svc.add_prescriber(staff["TECHNICIAN"],"Demo","MD","MD")
    drug=svc.add_drug(staff["PHARMACIST"],"DemoMed","2 mg","tablet")
    rx=svc.add_prescription(staff["TECHNICIAN"],patient,pre,drug,"RX-100","One daily","30")
    svc.advance_to_dur(staff["TECHNICIAN"],rx)
    svc.add_dur_issue(staff["PHARMACIST"],rx,"HIGH","INTERACTION")
    with svc.sessions.begin() as session:
        from pharmacy1os.models import Prescription
        rx2=Prescription(site_id=staff["TECHNICIAN"].site_id,patient_id=patient,prescriber_id=pre,drug_id=drug,
                         rx_number="RX-200",sig="One daily",quantity=30,refills_allowed=0,status="ON_HOLD",held_from="DATA_ENTRY")
        session.add(rx2);session.flush()
        session.add(ScheduledFill(site_id=staff["TECHNICIAN"].site_id,prescription_id=rx,
                                  due_date=(date.today()+timedelta(days=3)).isoformat(),
                                  idempotency_key="schedule-synthetic",status="PENDING",created_by_id=staff["TECHNICIAN"].id))
    return svc,staff,rx,ExceptionService(svc)


def test_combines_unresolved_dur_hold_and_future_fill(state):
    svc,a,rx,e=state
    out=e.list(a["AUDITOR"])
    assert {x["kind"] for x in out}=={"CLINICAL_ISSUE","ON_HOLD","SCHEDULED_FILL"}
    assert out[0]["severity"]=="HIGH"
    assert len(e.list(a["AUDITOR"],kind="CLINICAL_ISSUE"))==1
    assert e.list(a["AUDITOR"],query="RX-200")[0]["kind"]=="ON_HOLD"
    assert len(e.list(a["AUDITOR"],limit=1))==1


def test_exception_site_isolation_and_validation(state):
    svc,a,rx,e=state
    other=svc.bootstrap_demo()["actors"]
    assert e.list(other["PHARMACIST"])==[]
    with pytest.raises(WorkflowError,match="not-yet-supported"):
        e.list(a["AUDITOR"],kind="NOT_YET_SUPPORTED")
    with pytest.raises(WorkflowError):e.list(a["AUDITOR"],limit=301)


def test_exception_api_is_development_gated(state):
    svc,a,rx,e=state
    c=TestClient(create_app(svc,synthetic_enabled=True))
    h={"x-demo-staff-id":a["AUDITOR"].id}
    out=c.get("/api/exceptions",headers=h,params={"kind":"ON_HOLD"})
    assert out.status_code==200,out.text
    assert out.json()["items"][0]["kind"]=="ON_HOLD"
    assert TestClient(create_app(svc,synthetic_enabled=False)).get("/api/exceptions",headers=h).status_code==503
