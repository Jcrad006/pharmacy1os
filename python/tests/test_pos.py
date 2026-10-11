"""Synthetic-only integration tests for multi-Rx checkout and financial provenance."""
from datetime import date, timedelta
from decimal import Decimal
import pytest
from sqlalchemy import select
from pharmacy1os.service import PharmacyService, WorkflowError, AccessDenied
from pharmacy1os.pos import PosService
from pharmacy1os.pos_models import PosFinancialEvent, PosTransaction
from pharmacy1os.models import Fill, Prescription, Sale, Stock
from pharmacy1os.willcall import WillCallService


@pytest.fixture
def env():
    svc=PharmacyService();svc.create_schema()
    a=svc.bootstrap_demo()["actors"]
    patient=svc.add_patient(a["TECHNICIAN"],"Pat","Test")
    provider=svc.add_prescriber(a["TECHNICIAN"],"Dr","Test","MD")
    drug=svc.add_drug(a["PHARMACIST"],"Simulated","10 mg","tablet")
    prod=svc.add_product(a["PHARMACIST"],drug,"11111-1111-11","Synthetic","White tablets")
    svc.register_barcode(a["TECHNICIAN"],prod,"SYNTH111")
    exp=(date.today()+timedelta(days=90)).isoformat()
    svc.receive(a["TECHNICIAN"],"SYNTH111","LOT1",exp,"400")
    def filled(i, person=None, stage=True):
        rx=svc.add_prescription(a["TECHNICIAN"],person or patient,provider,drug,f"P-{i}","One daily","30",refills=0)
        svc.advance_to_dur(a["TECHNICIAN"],rx)
        f=svc.start_fill(a["TECHNICIAN"],rx)
        svc.scan_source(a["TECHNICIAN"],f,"SYNTH111","LOT1",exp,"30")
        svc.prepare_for_review(a["TECHNICIAN"],f,[])
        svc.verify(a["PHARMACIST"],f)
        if stage:svc.stage_will_call(a["TECHNICIAN"],f,"BIN1",f"BAG{i}")
        return rx,f
    return svc,a,patient,filled,PosService(svc)


def checkout(pos,a,fills,**kwargs):
    return pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":f"{i+1}.00"} for i,f in enumerate(fills)],
        tenders=[{"method":"CASH","amount":f"{sum(range(1,len(fills)+1))}.00"}],
        scanned_bags={f:f"BAG{i+1}" for i,f in enumerate(fills)},
        recipient_name="Pat Test",identity_method="DATE_OF_BIRTH",signature_method="PAPER",
        signature_attested=True,idempotency_key="sale-1",**kwargs)


def test_multi_fill_single_transaction_and_duplicate_key(env):
    svc,a,patient,filled,pos=env
    rx1,f1=filled(1);rx2,f2=filled(2)
    tx=checkout(pos,a,[f1,f2])
    assert tx["total"]=="3.00" and tx["status"]=="POSTED"
    assert len(tx["lines"])==2 and len(tx["tenders"])==1
    assert checkout(pos,a,[f1,f2])["id"]==tx["id"]
    assert [e["kind"] for e in pos.ledger(a["AUDITOR"],tx["id"])]==["CAPTURE_SIMULATED"]
    with svc.sessions() as s:
        assert [s.get(Fill, f).status for f in [f1,f2]]==["SOLD","SOLD"]
        assert len(s.scalars(select(Sale)).all())==2
    assert "NO REAL BANK" in pos.receipt(a["CASHIER"],tx["id"])


def test_split_tender_refund_versions_and_cannot_over_refund(env):
    svc,a,patient,filled,pos=env
    _rx,f=filled(1)
    tx=pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":"3.00"}],
        tenders=[{"method":"CARD","amount":"1.50"},{"method":"CASH","amount":"1.50"}],
        scanned_bags={f:"BAG1"},recipient_name="Pat Test",identity_method="ADDRESS",
        signature_method="ELECTRONIC_TYPED",signature_attested=True,idempotency_key="split")
    out=pos.refund(a["PHARMACIST"],tx["id"],"1.00","CARD","Price adjustment","refund-1")
    assert out["status"]=="PARTIAL_REFUND" and out["refunded"]=="1.00"
    assert pos.refund(a["PHARMACIST"],tx["id"],"1.00","CARD","Price adjustment","refund-1")["refunded"]=="1.00"
    with pytest.raises(WorkflowError,match="key reused"):
        pos.refund(a["PHARMACIST"],tx["id"],"1.50","CARD","Price adjustment","refund-1")
    with pytest.raises(WorkflowError,match="exceeds"):
        pos.refund(a["PHARMACIST"],tx["id"],"2.01","CARD","Too large","refund-2")
    out=pos.refund(a["PHARMACIST"],tx["id"],"2.00","CASH","Closing difference","refund-3")
    assert out["status"]=="REFUNDED" and out["remaining"]=="0.00"
    assert len(pos.ledger(a["AUDITOR"],tx["id"]))==3


def test_void_no_inventory_or_rx_rollback(env):
    svc,a,patient,filled,pos=env
    rx,f=filled(1)
    tx=checkout(pos,a,[f])
    before=pos.void(a["PHARMACIST"],tx["id"],"Duplicate collection; investigate", "void-1")
    assert before["status"]=="VOIDED"
    assert pos.void(a["PHARMACIST"],tx["id"],"Duplicate collection; investigate", "void-1")["status"]=="VOIDED"
    assert [e["kind"] for e in pos.ledger(a["AUDITOR"],tx["id"])]==["CAPTURE_SIMULATED","VOID_SIMULATED"]
    with svc.sessions() as s:
        assert s.get(Fill,f).status=="SOLD" and s.get(Prescription,rx).status=="SOLD"
    with pytest.raises(WorkflowError,match="cannot be refunded"):
        pos.refund(a["PHARMACIST"],tx["id"],"1.00","CASH","No","refund")


def test_atomic_failure_duplicate_fill_and_patient_mismatch(env):
    svc,a,patient,filled,pos=env
    rx1,f1=filled(1)
    other=svc.add_patient(a["TECHNICIAN"],"Other","Patient")
    rx2,f2=filled(2,person=other)
    with pytest.raises(WorkflowError,match="multiple patients"):
        checkout(pos,a,[f1,f2])
    with svc.sessions() as s:
        assert s.get(Fill,f1).status=="READY"
        assert len(s.scalars(select(PosTransaction)).all())==0
    with pytest.raises(WorkflowError,match="Duplicate"):
        pos.checkout(a["CASHIER"],lines=[{"fill_id":f1,"amount":"1.00"}]*2,
            tenders=[{"method":"CASH","amount":"2.00"}],scanned_bags={f1:"BAG1"},
            recipient_name="Pat Test",identity_method="OTHER",signature_method="PAPER",
            signature_attested=True,idempotency_key="dupe")


def test_wrong_retired_bag_rejected_without_side_effects(env):
    svc,a,patient,filled,pos=env
    rx,f=filled(1)
    WillCallService(svc).rebag(a["TECHNICIAN"],f,"BAG-NEW","Broken seal")
    with pytest.raises(WorkflowError,match="matching active bag"):
        checkout(pos,a,[f])
    with svc.sessions() as s:
        assert len(s.scalars(select(PosTransaction)).all())==0
        assert s.get(Fill,f).status=="READY"
    out=pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":"1.00"}],
            tenders=[{"method":"CASH","amount":"1.00"}],scanned_bags={f:"BAG-NEW"},
            recipient_name="Pat Test",identity_method="DATE_OF_BIRTH",signature_method="PAPER",
            signature_attested=True,idempotency_key="newbag")
    assert out["status"]=="POSTED"


def test_permissions_site_scope_and_original_sale_cannot_resell(env):
    svc,a,patient,filled,pos=env
    rx,f=filled(1)
    other=svc.bootstrap_demo()["actors"]
    with pytest.raises(AccessDenied):checkout(pos,a|{"CASHIER":a["AUDITOR"]},[f])
    with pytest.raises(WorkflowError,match="pharmacy site"):
        checkout(pos,a|{"CASHIER":other["CASHIER"]},[f])
    tx=checkout(pos,a,[f])
    with pytest.raises(WorkflowError,match="pharmacy site"):
        pos.get(other["PHARMACIST"],tx["id"])
    with pytest.raises(AccessDenied):
        pos.refund(a["CASHIER"],tx["id"],"1.00","CASH","No","refund")
    with pytest.raises(WorkflowError,match="already|Ready"):
        pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":"1.00"}],
            tenders=[{"method":"CASH","amount":"1.00"}],scanned_bags={f:"BAG1"},
            recipient_name="Pat Test",identity_method="DATE_OF_BIRTH",signature_method="PAPER",
            signature_attested=True,idempotency_key="new-key")


def test_money_and_idempotency_validation(env):
    svc,a,patient,filled,pos=env
    _rx,f=filled(1)
    with pytest.raises(WorkflowError,match="match"):
        pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":"3.00"}],
            tenders=[{"method":"CASH","amount":"2.00"}],scanned_bags={f:"BAG1"},
            recipient_name="Pat Test",identity_method="DATE_OF_BIRTH",signature_method="PAPER",
            signature_attested=True,idempotency_key="bad")
    with pytest.raises(WorkflowError,match="monetary|decimals"):
        pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":"NaN"}],
            tenders=[{"method":"CASH","amount":"1.00"}],scanned_bags={f:"BAG1"},
            recipient_name="Pat Test",identity_method="DATE_OF_BIRTH",signature_method="PAPER",
            signature_attested=True,idempotency_key="bad2")
    tx=checkout(pos,a,[f])
    with pytest.raises(WorkflowError,match="reused"):
        pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":"1.00"}],
            tenders=[{"method":"CARD","amount":"1.00"}],scanned_bags={f:"BAG1"},
            recipient_name="Pat Test",identity_method="DATE_OF_BIRTH",signature_method="PAPER",
            signature_attested=True,idempotency_key="sale-1")


def test_zero_cost_checkout_requires_no_tender_and_is_audited(env):
    svc,a,patient,filled,pos=env
    rx,f=filled(1)
    result=pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":"0.00"}],
        tenders=[],scanned_bags={f:"BAG1"},recipient_name="Pat Test",
        identity_method="KNOWN_PATIENT",signature_method="PAPER",
        signature_attested=True,idempotency_key="no-charge")
    assert result["total"]=="0.00" and result["tenders"]==[]
    assert len(pos.ledger(a["AUDITOR"],result["id"]))==1


def test_immediate_unstaged_pickup_and_staged_bypass_is_prohibited(env):
    svc,a,patient,filled,pos=env
    rx,f=filled(1,stage=False)
    result=pos.checkout(a["CASHIER"],lines=[{"fill_id":f,"amount":"1.00"}],
        tenders=[{"method":"CASH","amount":"1.00"}],scanned_bags={},
        recipient_name="Pat Test",identity_method="OTHER",signature_method="PAPER",
        signature_attested=True,idempotency_key="immediate",mode="IMMEDIATE")
    assert result["status"]=="POSTED"
    _rx,f2=filled(2,stage=True)
    with pytest.raises(WorkflowError,match="existing Will Call"):
        pos.checkout(a["CASHIER"],lines=[{"fill_id":f2,"amount":"1.00"}],
            tenders=[{"method":"CASH","amount":"1.00"}],scanned_bags={},
            recipient_name="Pat Test",identity_method="OTHER",signature_method="PAPER",
            signature_attested=True,idempotency_key="bypass",mode="IMMEDIATE")


def test_pos_api_endpoints_and_guardrails(env):
    from pharmacy1os.api import create_app
    from fastapi.testclient import TestClient
    svc,a,patient,filled,pos=env
    rx,f=filled(1)
    client=TestClient(create_app(svc,synthetic_enabled=True))
    cashier={"x-demo-staff-id":a["CASHIER"].id}
    pharmacist={"x-demo-staff-id":a["PHARMACIST"].id}
    body={"lines":[{"fill_id":f,"amount":"2.00"}],
          "tenders":[{"method":"CASH","amount":"2.00"}],
          "scanned_bags":{f:"BAG1"},"recipient_name":"Pat Test",
          "identity_method":"ADDRESS","signature_method":"PAPER",
          "signature_attested":True,"idempotency_key":"api-1"}
    out=client.post("/api/pos/transactions",headers=cashier,json=body)
    assert out.status_code==201,out.text
    tx=out.json()["id"]
    assert client.get("/api/pos/transactions",headers=cashier).json()["transactions"][0]["id"]==tx
    assert "NOT PROOF" in client.get(f"/api/pos/transactions/{tx}/receipt",headers=cashier).text
    deny=client.post(f"/api/pos/transactions/{tx}/refund",headers=cashier,json={
         "amount":"1.00","method":"CASH","reason":"Price difference","request_key":"r-1"})
    assert deny.status_code==403
    done=client.post(f"/api/pos/transactions/{tx}/refund",headers=pharmacist,json={
         "amount":"1.00","method":"CASH","reason":"Price difference","request_key":"r-1"})
    assert done.status_code==200,done.text
    assert done.json()["status"]=="PARTIAL_REFUND"
    assert len(client.get(f"/api/pos/transactions/{tx}/events",headers=pharmacist).json()["events"])==2
    gated=TestClient(create_app(svc,synthetic_enabled=False))
    assert gated.get("/api/pos/transactions",headers=cashier).status_code==503
