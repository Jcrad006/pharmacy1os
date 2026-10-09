"""Synthetic-only communication tasks; no live fax or eRx transport."""
import hashlib
import pytest
from sqlalchemy import select
from fastapi.testclient import TestClient
from pharmacy1os.api import create_app
from pharmacy1os.documents import DocumentService, DocumentError
from pharmacy1os.communications import CommunicationService, CommunicationTask, CommunicationEvent
from pharmacy1os.service import PharmacyService, WorkflowError, AccessDenied


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    monkeypatch.setenv("DOCUMENT_STORAGE_ROOT", str(tmp_path / "vault"))
    monkeypatch.delenv("DOCUMENT_ENCRYPTION_KEY", raising=False)
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = svc.add_patient(tech, "Demo", "Patient")
    prescriber = svc.add_prescriber(tech, "Fictional", "Doctor", "MD")
    drug = svc.add_drug(pharmacist, "Synthetic Med", "1 mg", "tablet")
    rx = svc.add_prescription(tech, patient, prescriber, drug, "RX-COMM-001", "Test", "30")
    vault = DocumentService(svc, tmp_path / "vault")
    source = vault.create_source(tech, rx, b"synthetic fax source bytes", "application/pdf")
    return svc, actors, rx, source, CommunicationService(svc, vault), vault


def create_task(f, *, direction="OUTBOUND", channel="FAX", key="task-1"):
    svc, actors, rx, src, comm, vault = f
    return comm.create(actors["TECHNICIAN"], rx, src["id"], direction, channel,
                       "Fictional prescriber", "Synthetic call back requested", key)


def test_outbound_work_order_requires_pharmacist_and_never_claims_delivery(fixture):
    svc, a, rx, doc, comm, _ = fixture
    task = create_task(fixture)
    assert comm.list(a["TECHNICIAN"])[0]["status"] == "DRAFT"
    with pytest.raises(WorkflowError, match="approved"):
        comm.change(a["TECHNICIAN"], task, "ATTEMPT_RECORDED", "tried fax", "try-1")
    with pytest.raises(AccessDenied):
        comm.change(a["TECHNICIAN"], task, "APPROVED", "approve it", "ap-1")
    comm.change(a["PHARMACIST"], task, "APPROVED", "Office contact reviewed", "ap-1")
    event = comm.change(a["TECHNICIAN"], task, "ATTEMPT_RECORDED",
                        "Manual attempt logged; no transport receipt verified", "try-1")
    assert event == comm.change(a["TECHNICIAN"], task, "ATTEMPT_RECORDED",
                                "Manual attempt logged; no transport receipt verified", "try-1")
    assert [x["action"] for x in comm.history(a["PHARMACIST"], task)] == [
        "CREATED", "APPROVED", "ATTEMPT_RECORDED"]
    assert comm.list(a["TECHNICIAN"])[0]["status"] == "ACTIVITY_RECORDED"
    with pytest.raises(WorkflowError, match="different content"):
        comm.change(a["TECHNICIAN"], task, "ATTEMPT_RECORDED", "different content", "try-1")
    assert len(comm.history(a["PHARMACIST"], task)) == 3


def test_inbound_erx_is_quarantined_no_automatic_rx_creation(fixture):
    svc, a, rx, doc, comm, _ = fixture
    task = create_task(fixture, direction="INBOUND", channel="ERX")
    assert comm.list(a["TECHNICIAN"])[0]["status"] == "QUARANTINED"
    with pytest.raises(WorkflowError, match="outbound"):
        comm.change(a["PHARMACIST"], task, "APPROVED", "n/a", "key-1")
    with pytest.raises(AccessDenied):
        comm.change(a["TECHNICIAN"], task, "REVIEWED", "Reviewed?", "rev-1")
    comm.change(a["PHARMACIST"], task, "REVIEWED", "Structured data not authenticated", "rev-1")
    assert comm.list(a["PHARMACIST"])[0]["status"] == "REVIEWED"
    with pytest.raises(WorkflowError):
        comm.change(a["PHARMACIST"], task, "REVIEWED", "again", "rev-2")
    with svc.sessions() as s:
        from pharmacy1os.models import Prescription
        assert len(s.scalars(select(Prescription)).all()) == 1


def test_foreign_site_and_mismatched_prescription_source_rejected(fixture):
    svc,a,rx,doc,comm,_=fixture
    other=svc.bootstrap_demo()["actors"]
    task=create_task(fixture)
    assert comm.list(other["PHARMACIST"])==[]
    with pytest.raises(WorkflowError):
        comm.history(other["PHARMACIST"], task)
    with pytest.raises(WorkflowError):
        comm.change(other["PHARMACIST"], task,"APPROVED","test","foreign-1")
    another=svc.add_prescription(a["TECHNICIAN"],
        svc.add_patient(a["TECHNICIAN"],"Other","Patient"),
        svc.add_prescriber(a["TECHNICIAN"],"Other","Provider","MD"),
        svc.add_drug(a["PHARMACIST"],"Other Med","3mg","tablet"),"RX-COMM-002","Test","30")
    with pytest.raises(WorkflowError,match="another prescription"):
        comm.create(a["TECHNICIAN"], another, doc["id"],"OUTBOUND","FAX","Office","Wrong Rx","other-1")


def test_document_integrity_is_required_for_approval(fixture):
    svc,a,rx,doc,comm,vault=fixture
    task=create_task(fixture)
    location=vault._path(a["TECHNICIAN"].site_id, doc["id"])
    location.write_bytes(b"altered content")
    with pytest.raises(DocumentError):
        comm.change(a["PHARMACIST"],task,"APPROVED","yes","approve-1")
    assert comm.list(a["TECHNICIAN"])[0]["status"]=="DRAFT"


def test_creation_and_event_idempotency_cancel_and_restricted_erx(fixture):
    svc,a,rx,doc,comm,_=fixture
    task=create_task(fixture)
    assert task==create_task(fixture)
    with pytest.raises(WorkflowError,match="reused"):
        comm.create(a["TECHNICIAN"],rx,doc["id"],"OUTBOUND","FAX","Elsewhere","Changed","task-1")
    with pytest.raises(WorkflowError,match="not implemented"):
        create_task(fixture,channel="ERX",key="no-send")
    comm.change(a["PHARMACIST"],task,"CANCELLED","No longer needed","cancel-1")
    with pytest.raises(WorkflowError):
        comm.change(a["PHARMACIST"],task,"APPROVED","cancelled","approve-1")
    with svc.sessions() as session:
        event=session.scalars(select(CommunicationEvent).where(CommunicationEvent.task_id==task)).all()
        assert len(event)==2


def test_synthetic_api_router_and_role_isolation(fixture):
    svc,a,rx,doc,comm,vault=fixture
    client=TestClient(create_app(svc,synthetic_enabled=True))
    tech={"x-demo-staff-id":a["TECHNICIAN"].id}
    pharmacist={"x-demo-staff-id":a["PHARMACIST"].id}
    payload={"prescription_id":rx,"document_id":doc["id"],"direction":"OUTBOUND",
             "channel":"PHONE","destination":"Office","summary":"Synthetic contact","request_key":"api-1"}
    res=client.post("/api/communications",json=payload,headers=tech)
    assert res.status_code==201,res.text
    task_id=res.json()["id"]
    assert len(client.get("/api/communications",headers=tech).json()["tasks"])==1
    blocked=client.post(f"/api/communications/{task_id}/events",headers=tech,json={
        "action":"APPROVED","note":"No","request_key":"api-ap"})
    assert blocked.status_code==403
    okay=client.post(f"/api/communications/{task_id}/events",headers=pharmacist,json={
        "action":"APPROVED","note":"Clinician documented","request_key":"api-ap"})
    assert okay.status_code==201,okay.text
    events=client.get(f"/api/communications/{task_id}/events",headers=tech)
    assert [x["action"] for x in events.json()["events"]]==["CREATED","APPROVED"]
    assert client.get("/api/communications",headers={}).status_code==403
