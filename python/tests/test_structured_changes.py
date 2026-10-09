"""Synthetic structured-change workflow and safety regression tests."""
import pytest
from sqlalchemy import select
from fastapi.testclient import TestClient
from pharmacy1os.documents import DocumentService
from pharmacy1os.models import Audit, DocumentChange, Fill, Prescription
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError
from pharmacy1os.structured_changes import StructuredChangeApplication, StructuredChangeService
from pharmacy1os.structured_changes_api import make_structured_changes_router
from fastapi import FastAPI, Header, HTTPException
from pharmacy1os.service import Actor


@pytest.fixture
def setup(tmp_path):
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = svc.add_patient(tech, "Test", "Only")
    provider = svc.add_prescriber(tech, "Dr", "Test", "MD")
    med = svc.add_drug(pharm, "Fictitious", "1 mg", "tablet")
    rx = svc.add_prescription(tech, patient, provider, med, "CHANGE-01", "one daily", "30")
    docsvc = DocumentService(svc, tmp_path / "vault")
    doc = docsvc.create_source(tech, rx, b"original synthetic scan", "application/pdf")
    change = {"change_type":"SIG","what_changed":"Clarified frequency",
              "reason":"Prescriber returned call","communication_method":"PHONE",
              "contacted_party":"Office staff","authorizing_prescriber":"Dr Test"}
    annotation = docsvc.annotate(tech, doc["id"], "Called office", ".1", ".2", ".3", ".2", change)
    with svc.sessions() as s:
        record = s.scalar(select(DocumentChange).where(DocumentChange.annotation_id == annotation))
        rid = record.id
    return svc, actors, rx, doc, rid, docsvc, StructuredChangeService(svc, docsvc)


def test_verified_change_updates_only_structured_rx_and_immutable_record(setup):
    svc,a,rx,doc,rid,docs,changes = setup
    res=changes.apply(a["PHARMACIST"],rid," two daily ","Physician clarification noted; test",expected_version=0)
    assert res["field"]=="sig" and res["version"]==1 and res["before"]=="one daily"
    assert res["after"]=="two daily"
    with svc.sessions() as s:
        item=s.get(Prescription,rx)
        assert item.sig=="two daily" and item.version==1
        assert s.scalar(select(StructuredChangeApplication).where(StructuredChangeApplication.change_record_id==rid)) is not None
        assert any(x.kind=="STRUCTURED_RX_CHANGE_APPLIED" for x in s.scalars(select(Audit)).all())
    assert docs.read_source(a["TECHNICIAN"],doc["id"])[0]==b"original synthetic scan"
    assert changes.history(a["AUDITOR"],rx)[0]["version_after"]==1
    with pytest.raises(WorkflowError,match="already been applied"):
        changes.apply(a["PHARMACIST"],rid,"three daily","Duplicate attempt denied",expected_version=1)


def test_forbid_unauthorized_and_conflicting_version(setup):
    svc,a,rx,doc,rid,docs,changes=setup
    with pytest.raises(AccessDenied):
        changes.apply(a["TECHNICIAN"],rid,"twice daily","Technician cannot approve",expected_version=0)
    with pytest.raises(WorkflowError,match="modified"):
        changes.apply(a["PHARMACIST"],rid,"twice daily","Stale version prevented",expected_version=5)
    with svc.sessions() as s:
        assert s.get(Prescription,rx).sig=="one daily"
    other=svc.bootstrap_demo()["actors"]["PHARMACIST"]
    with pytest.raises(WorkflowError,match="not found"):
        changes.apply(other,rid,"twice daily","Wrong-site attempt rejected",expected_version=0)


def test_change_fails_after_dur_fill_or_scheduled_work(setup):
    svc,a,rx,doc,rid,docs,changes=setup
    tech=a["TECHNICIAN"]
    svc.advance_to_dur(tech,rx)
    changes.apply(a["PHARMACIST"],rid,"two daily","Reset clinical verification",expected_version=0)
    with svc.sessions() as s:
        assert s.get(Prescription,rx).status=="DATA_ENTRY"


def test_fill_history_blocks_mutation(setup):
    svc,a,rx,doc,rid,docs,changes=setup
    tech=a["TECHNICIAN"]
    svc.advance_to_dur(tech,rx)
    fill=svc.start_fill(tech,rx)
    with pytest.raises(WorkflowError,match="unfilled"):
        changes.apply(a["PHARMACIST"],rid,"two daily","Cannot alter active fill",expected_version=0)
    with svc.sessions.begin() as s:
        s.get(Prescription,rx).status="DATA_ENTRY"
    with pytest.raises(WorkflowError,match="fill history"):
        changes.apply(a["PHARMACIST"],rid,"two daily","Cannot retroactively alter fill",expected_version=0)


def test_tampered_original_disallows_application(setup):
    svc,a,rx,doc,rid,docs,changes=setup
    path=docs._path(a["TECHNICIAN"].site_id,doc["id"])
    path.write_bytes(b"altered original")
    with pytest.raises(WorkflowError,match="integrity"):
        changes.apply(a["PHARMACIST"],rid,"two daily","Failed immutable integrity",expected_version=0)
    with svc.sessions() as s:
        assert s.get(Prescription,rx).version==0


def test_qty_refills_and_unsupported(setup):
    svc,a,rx,doc,rid,docs,changes=setup
    tech, pharm=a["TECHNICIAN"],a["PHARMACIST"]
    for kind,value,fail in [("QUANTITY","NaN",True),("QUANTITY","25",False),("REFILLS",3,False),("STRENGTH","2 mg",True)]:
        record=docs.annotate(tech,doc["id"],"Changed", ".1", ".2", ".2", ".2",
                             {"change_type":kind,"what_changed":"Clinical update","reason":"Office verified",
                              "communication_method":"PHONE","contacted_party":"Office",
                              "authorizing_prescriber":"Dr Test"})
        with svc.sessions() as s:
            change=s.scalar(select(DocumentChange).where(DocumentChange.annotation_id==record))
            change_id=change.id
            version=s.get(Prescription,rx).version
        if fail:
            with pytest.raises(WorkflowError):
                changes.apply(pharm,change_id,value,"Review not accepted",expected_version=version)
        else:
            result=changes.apply(pharm,change_id,value,"Verified office request",expected_version=version)
            assert result["version"]==version+1


def test_api_apply_and_history(setup):
    svc,actors,rx,doc,rid,docs,changes=setup
    app=FastAPI()
    def actor(x_demo_staff_id:str=Header()):
        with svc.sessions() as s:
            from pharmacy1os.models import Staff
            staff=s.get(Staff,x_demo_staff_id)
            if staff is None: raise HTTPException(403)
            return Actor(staff.id,staff.site_id,staff.role)
    app.include_router(make_structured_changes_router(changes,actor))
    client=TestClient(app)
    response=client.post(f"/api/prescription-changes/{rid}/apply",headers={"x-demo-staff-id":actors["PHARMACIST"].id},json={
        "value":"two daily","approval_note":"Approved synthetic data change","expected_version":0})
    assert response.status_code==200,response.text
    hist=client.get(f"/api/prescriptions/{rx}/structured-change-history",headers={"x-demo-staff-id":actors["AUDITOR"].id})
    assert hist.status_code==200 and hist.json()["applications"][0]["after"]=="two daily"


def test_applied_annotation_cannot_be_superseded(setup):
    svc, actors, rx, doc, record_id, docs, changes = setup
    changes.apply(actors["PHARMACIST"], record_id, "two daily",
                  "Verified prescriber instructions", expected_version=0)
    with svc.sessions() as session:
        change = session.get(DocumentChange, record_id)
        ann_id = change.annotation_id
    proposed = {"change_type":"SIG","what_changed":"New clarification",
                "reason":"Subsequent discussion","communication_method":"PHONE",
                "contacted_party":"Office","authorizing_prescriber":"Dr Test"}
    with pytest.raises(WorkflowError, match="cannot be superseded"):
        docs.annotate(actors["TECHNICIAN"], doc["id"], "New note",
                      ".2", ".2", ".2", ".2", proposed, supersedes_id=ann_id)
    with svc.sessions() as session:
        assert session.get(DocumentChange, record_id).status == "ACTIVE"


def test_schedule_blocks_structured_application(setup):
    from pharmacy1os.scheduling_models import ScheduledFill
    from datetime import date, timedelta
    svc, actors, rx, _, record_id, _, changes = setup
    tech = actors["TECHNICIAN"]
    svc.advance_to_dur(tech, rx)
    due = (date.today() + timedelta(days=3)).isoformat()
    with svc.sessions.begin() as session:
        session.add(ScheduledFill(site_id=tech.site_id, prescription_id=rx, due_date=due,
                                  status="PENDING", idempotency_key="scheduled-excludes-apply",
                                  created_by_id=tech.id))
    with pytest.raises(WorkflowError, match="pending schedules"):
        changes.apply(actors["PHARMACIST"], record_id, "two daily",
                      "Schedule must be cleared", expected_version=0)


def test_change_to_controlled_drug_is_rejected(setup):
    svc, actors, rx, doc, _, docs, changes = setup
    tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
    drug = svc.add_drug(pharmacist, "CONTROLLED SYNTHETIC", "5 mg", "tablet", controlled=True)
    ann = docs.annotate(tech,doc["id"],"Change drug", ".1", ".1", ".3", ".3",
                        {"change_type":"DRUG", "what_changed":"Drug change",
                         "reason":"Synthetic prescriber review", "communication_method":"PHONE",
                         "contacted_party":"Office", "authorizing_prescriber":"Dr Test"})
    with svc.sessions() as s:
        id = s.scalar(select(DocumentChange).where(DocumentChange.annotation_id == ann)).id
    with pytest.raises(WorkflowError,match="noncontrolled"):
        changes.apply(pharmacist,id,drug,"Never permitted controlled switch",expected_version=0)
