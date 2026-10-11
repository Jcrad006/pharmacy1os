from datetime import date, timedelta
from decimal import Decimal
import pytest
from sqlalchemy import select
from fastapi.testclient import TestClient

from pharmacy1os.models import Claim, Fill, Label, Prescription
from pharmacy1os.billing_models import ClaimOperation, PayerBillingProfile
from pharmacy1os.billing import BillingService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError
from pharmacy1os.api import create_app

@pytest.fixture
def setup():
    svc=PharmacyService()
    svc.create_schema()
    actors=svc.bootstrap_demo()["actors"]
    p=svc.add_patient(actors["TECHNICIAN"],"Jamie","Synthetic")
    pres=svc.add_prescriber(actors["TECHNICIAN"],"Taylor","Doc","MD")
    drug=svc.add_drug(actors["PHARMACIST"],"TestMed","1 mg","tablet")
    expiration=(date.today()+timedelta(days=360)).isoformat()
    for i in (1,2):
        pid=svc.add_product(actors["PHARMACIST"],drug,f"11111-2222{i}-33",f"MFG-{i}",f"tablet-{i}")
        svc.register_barcode(actors["TECHNICIAN"],pid,f"B-{i}")
        svc.receive(actors["TECHNICIAN"],f"B-{i}",f"LOT-{i}",expiration,"100")
    rx=svc.add_prescription(actors["TECHNICIAN"],p,pres,drug,"FIN-001","Use daily","90",refills=0)
    svc.advance_to_dur(actors["TECHNICIAN"],rx)
    fill=svc.start_fill(actors["TECHNICIAN"],rx,"75")
    svc.scan_source(actors["TECHNICIAN"],fill,"B-1","LOT-1",expiration,"60")
    svc.scan_source(actors["TECHNICIAN"],fill,"B-2","LOT-2",expiration,"15")
    return svc,actors,rx,fill,BillingService(svc)


def test_versioned_profiles_never_mutate_prior_profile(setup):
    svc,a,rx,fill,billing=setup
    p1=billing.update_profile(a["PHARMACIST"],"Plan X",max_physical_sources=1,
                             reason="Restricted synthetic physical source test")
    with pytest.raises(WorkflowError,match="fewer physical"):
        svc.prepare_for_review(a["TECHNICIAN"],fill,["Plan X"])
    with svc.sessions() as s:
        assert s.scalars(select(Claim)).all()==[]
        assert s.scalars(select(Label)).all()==[]
        assert s.get(Fill,fill).status=="PRODUCT_FILL"
    p2=billing.update_profile(a["PHARMACIST"],"Plan X",max_physical_sources=2,
                               billing_ndc_strategy="FIRST_SCANNED",reason="New synthetic rule")
    assert p1!=p2
    profiles=billing.profiles(a["PHARMACIST"])
    assert [(p["version"],p["effective"]) for p in profiles]==[(1,False),(2,True)]
    svc.prepare_for_review(a["TECHNICIAN"],fill,["Plan X"])
    history=billing.history(a["TECHNICIAN"],fill)
    assert len(history)==1
    assert history[0]["selected_ndc"]=="11111-22221-33"
    assert history[0]["billed_quantity"]=="90.000"
    assert history[0]["source_snapshot"]["billing_profile"]["version"]==2
    assert len(history[0]["source_snapshot"]["physical_sources"])==2


def test_multi_payer_majority_ndc_and_reversal_history(setup):
    svc,a,rx,fill,billing=setup
    labels=svc.prepare_for_review(a["TECHNICIAN"],fill,["Payer A","Payer B"])
    assert len(labels)==2
    history=billing.history(a["PHARMACIST"],fill)
    assert [x["payer"] for x in history]==["Payer A","Payer B"]
    assert all(x["selected_ndc"]=="11111-22221-33" for x in history)
    assert all(x["operation"]=="SYNTHETIC_PAID" for x in history)
    svc.verify(a["PHARMACIST"],fill)
    svc.return_to_stock(a["PHARMACIST"],fill,"Rx patient no longer wants it")
    history=billing.history(a["TECHNICIAN"],fill)
    assert len(history)==4
    for payer in ("Payer A","Payer B"):
        ev=[x for x in history if x["payer"]==payer]
        assert {x["operation"] for x in ev}=={"SYNTHETIC_PAID","SYNTHETIC_REVERSED"}
        assert all(x["billed_quantity"]=="90.000" for x in ev)
    with svc.sessions() as s:
        assert all(c.status=="REVERSED_SYNTHETIC" for c in s.scalars(select(Claim)))


def test_cancel_reverses_and_records_history(setup):
    from pharmacy1os.lifecycle import LifecycleService
    svc,a,rx,fill,billing=setup
    svc.prepare_for_review(a["TECHNICIAN"],fill,["Primary"])
    LifecycleService(svc).cancel(a["PHARMACIST"],rx,"Provider canceled")
    ops=billing.history(a["PHARMACIST"],fill)
    assert [op["operation"] for op in ops]==["SYNTHETIC_PAID","SYNTHETIC_REVERSED"]
    assert ops[1]["reason"]=="Provider canceled"


def test_profile_site_scope_and_access_control(setup):
    svc,a,rx,fill,billing=setup
    other=svc.bootstrap_demo()["actors"]
    with pytest.raises(AccessDenied):
        billing.update_profile(a["TECHNICIAN"],"Plan",max_physical_sources=4,reason="no")
    billing.update_profile(a["PHARMACIST"],"Plan",max_physical_sources=4,reason="okay")
    assert billing.profiles(other["PHARMACIST"])==[]
    with pytest.raises(WorkflowError):
        billing.history(other["PHARMACIST"],fill)
    with pytest.raises(AccessDenied):
        billing.update_profile(a["AUDITOR"],"Plan",max_physical_sources=4,reason="no")


def test_billing_rule_validations(setup):
    svc,a,rx,fill,billing=setup
    kwargs={"max_physical_sources":4,"reason":"testing"}
    with pytest.raises(WorkflowError,match="supports only"):
        billing.update_profile(a["PHARMACIST"],"Plan",full_authorized_quantity=False,**kwargs)
    with pytest.raises(WorkflowError,match="Unsupported"):
        billing.update_profile(a["PHARMACIST"],"Plan",billing_ndc_strategy="MYSTERY",**kwargs)
    with pytest.raises(WorkflowError,match="1-4"):
        billing.update_profile(a["PHARMACIST"],"Plan",max_physical_sources=5,reason="testing")


def test_billing_api_profiles_and_history(setup):
    svc,a,rx,fill,billing=setup
    cli=TestClient(create_app(svc,synthetic_enabled=True))
    pharmacist={"x-demo-staff-id":a["PHARMACIST"].id}
    tech={"x-demo-staff-id":a["TECHNICIAN"].id}
    result=cli.post("/api/billing/profiles",headers=pharmacist,json={
        "payer_name":"Test Payer","max_physical_sources":4,"reason":"configure test"})
    assert result.status_code==201,result.text
    assert len(cli.get("/api/billing/profiles",headers=tech).json()["profiles"])==1
    svc.prepare_for_review(a["TECHNICIAN"],fill,["Test Payer"])
    response=cli.get(f"/api/billing/fills/{fill}/claim-history",headers=tech)
    assert response.status_code==200,response.text
    assert response.json()["operations"][0]["source_snapshot"]["billing_profile"]["version"]==1
    assert cli.post("/api/billing/profiles",headers=tech,json={
        "payer_name":"Reject","max_physical_sources":4,"reason":"unauthorized"}).status_code==403
