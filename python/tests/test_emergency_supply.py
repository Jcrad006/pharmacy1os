"""Safety/lineage regression tests for synthetic-only emergency supply."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.emergency_supply import EmergencySupply, EmergencySupplyService
from pharmacy1os.exceptions import ExceptionService
from pharmacy1os.fill_completion import FillCompletionService
from pharmacy1os.lifecycle import LifecycleService
from pharmacy1os.models import Claim, Drug, Fill, Prescription, Stock
from pharmacy1os.pos import PosService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "Emergency")
    prescriber = svc.add_prescriber(tech, "Example", "Physician", "MD")
    drug = svc.add_drug(pharmacist, "Synthetic Test Tablet", "10 mg", "tablet")
    product = svc.add_product(pharmacist, drug, "00000-9876-02", "Synthetic", "White oval")
    svc.register_barcode(tech, product, "EMERG-BAR")
    expires = (date.today() + timedelta(days=120)).isoformat()
    stock = svc.receive(tech, "EMERG-BAR", "EMERGLOT", expires, "200")
    rx = svc.add_prescription(tech, patient, prescriber, drug,
                              "SYN-EMERG-01", "Once daily", "30", refills=0)
    svc.advance_to_dur(tech, rx)
    original = svc.start_fill(tech, rx)
    svc.scan_source(tech, original, "EMERG-BAR", "EMERGLOT", expires, "30")
    svc.prepare_for_review(tech, original, ["SYNTHETIC-PLAN"])
    svc.verify(pharmacist, original)
    svc.sell(tech, original, True, True, "0", "CASH")
    due = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    return svc, actors, other, rx, drug, stock, expires, original, due


def prep(svc, actors, fill_id, expires, quantity="5"):
    svc.scan_source(actors["TECHNICIAN"], fill_id, "EMERG-BAR", "EMERGLOT", expires, quantity)
    return svc.prepare_for_review(actors["TECHNICIAN"], fill_id, [])


def test_authorize_requires_pharmacist_prior_sold_and_exhausted_refills(env):
    svc, actors, other, rx, drug, stock, exp, original, due = env
    workflow = EmergencySupplyService(svc)
    with pytest.raises(AccessDenied):
        workflow.authorize(actors["TECHNICIAN"], rx, "5", "Insufficient supply", due)
    with pytest.raises(WorkflowError, match="pharmacy site"):
        workflow.authorize(other["PHARMACIST"], rx, "5", "Wrong site", due)
    for amount, reason, deadline in [
        ("-2", "Need supply", due), ("0", "Need supply", due),
        ("NaN", "Need supply", due), ("31", "Need supply", due),
        ("5", "", due), ("5", "Need supply", "2026-10-01"),
        ("5", "Need supply", "not-a-date"),
    ]:
        with pytest.raises(WorkflowError):
            workflow.authorize(actors["PHARMACIST"], rx, amount, reason, deadline)
    with svc.sessions() as s:
        assert s.scalars(select(EmergencySupply)).all() == []
        assert s.get(Stock, stock).on_hand == Decimal("170")
        assert s.get(Prescription, rx).status == "SOLD"
    # An additional available refill must be used instead of emergency supply.
    with svc.sessions.begin() as s:
        s.get(Prescription, rx).refills_allowed = 1
    with pytest.raises(WorkflowError, match="Authorized refills remain"):
        workflow.authorize(actors["PHARMACIST"], rx, "5", "Use early supply", due)


def test_synthetic_emergency_flow_no_second_payer_and_follow_up(env):
    svc, actors, other, rx, drug, stock, exp, original, due = env
    pharm, tech = actors["PHARMACIST"], actors["TECHNICIAN"]
    workflow = EmergencySupplyService(svc)
    emergency_fill = workflow.authorize(pharm, rx, "5", "Documented patient need", due)
    assert emergency_fill != original
    with svc.sessions() as s:
        original_record, emergency_record = s.get(Fill, original), s.get(Fill, emergency_fill)
        assert emergency_record.fill_number == original_record.fill_number
        assert emergency_record.attempt == original_record.attempt + 1
        assert emergency_record.billed_quantity == Decimal("5")
    tasks = ExceptionService(svc).list(actors["AUDITOR"], kind="EMERGENCY_FOLLOW_UP")
    assert len(tasks) == 1 and tasks[0]["severity"] == "WARNING"
    assert tasks[0]["prescription_id"] == rx
    with pytest.raises(WorkflowError, match="converted"):
        FillCompletionService(svc).interrupt_as_partial(tech, emergency_fill, "2", "Cannot split")
    with pytest.raises(WorkflowError, match="previously sold|already documented"):
        # Active emergency fill also prevents a second authorization.
        workflow.authorize(pharm, rx, "5", "Duplicate", due)

    svc.scan_source(tech, emergency_fill, "EMERG-BAR", "EMERGLOT", exp, "5")
    with pytest.raises(WorkflowError, match="does not support synthetic payer claims"):
        svc.prepare_for_review(tech, emergency_fill, ["DO-NOT-SEND"])
    labels = svc.prepare_for_review(tech, emergency_fill, [])
    assert "5.000/5.000" in labels[0]
    svc.verify(pharm, emergency_fill)
    with pytest.raises(AccessDenied):
        workflow.complete_follow_up(tech, emergency_fill, "Not approved")
    with pytest.raises(WorkflowError, match="physically sold"):
        workflow.complete_follow_up(pharm, emergency_fill, "Premature follow-up")
    svc.sell(tech, emergency_fill, True, True, "0", "CASH")
    with svc.sessions() as s:
        assert s.get(Prescription, rx).refills_used == 0
        assert s.get(Stock, stock).on_hand == Decimal("165")
        assert len(s.scalars(select(Claim)).all()) == 1
    workflow.complete_follow_up(pharm, emergency_fill, "Spoke with prescriber; action documented")
    assert ExceptionService(svc).list(actors["AUDITOR"], kind="EMERGENCY_FOLLOW_UP") == []
    with pytest.raises(WorkflowError, match="no longer open"):
        workflow.complete_follow_up(pharm, emergency_fill, "Duplicate")
    with pytest.raises(WorkflowError, match="already documented"):
        workflow.authorize(pharm, rx, "5", "Repeat emergency", due)


def test_return_to_stock_voids_emergency_preserving_original_sold_record(env):
    svc, actors, other, rx, drug, stock, exp, original, due = env
    pharm, tech = actors["PHARMACIST"], actors["TECHNICIAN"]
    workflow = EmergencySupplyService(svc)
    emergency = workflow.authorize(pharm, rx, "5", "No remaining authorization", due)
    prep(svc, actors, emergency, exp)
    svc.verify(pharm, emergency)
    svc.return_to_stock(pharm, emergency, "Emergency supply not collected")
    assert workflow.list(actors["AUDITOR"])[0]["status"] == "VOID_UNSOLD"
    assert workflow.list(actors["AUDITOR"], include_closed=False) == []
    with svc.sessions() as s:
        assert s.get(Fill, emergency).status == "RETURNED"
        assert s.get(Fill, original).status == "SOLD"
        assert s.get(Prescription, rx).status == "SOLD"
        assert s.get(Stock, stock).on_hand == Decimal("170")
        assert len(s.scalars(select(Claim)).all()) == 1
    with pytest.raises(WorkflowError, match="already documented"):
        workflow.authorize(pharm, rx, "3", "Second emergency", due)


def test_follow_up_exception_escalates_and_pos_sale_closes_it(env):
    svc, actors, other, rx, drug, stock, exp, original, due = env
    pharm, tech = actors["PHARMACIST"], actors["TECHNICIAN"]
    workflow = EmergencySupplyService(svc)
    fill = workflow.authorize(pharm, rx, "5", "Needs follow-up", due)
    prep(svc, actors, fill, exp)
    svc.verify(pharm, fill)
    # DB reflects a missed due date, but the event is still open and immutable authorization was retained.
    with svc.sessions.begin() as s:
        s.scalar(select(EmergencySupply).where(EmergencySupply.fill_id == fill)).follow_up_due_at = (
            datetime.now(timezone.utc) - timedelta(hours=1))
    issue = ExceptionService(svc).list(actors["AUDITOR"], kind="EMERGENCY_FOLLOW_UP")
    assert issue[0]["severity"] == "HIGH"
    assert ExceptionService(svc).list(other["AUDITOR"], kind="EMERGENCY_FOLLOW_UP") == []
    tx = PosService(svc).checkout(actors["CASHIER"],
        lines=[{"fill_id": fill, "amount": "0.00"}], tenders=[],
        scanned_bags={}, recipient_name="Synthetic Recipient",
        identity_method="DATE_OF_BIRTH", signature_method="PAPER",
        signature_attested=True, idempotency_key="SYNTH-EMERG-CHECKOUT", mode="IMMEDIATE")
    assert tx["status"] == "POSTED"
    with svc.sessions() as s:
        assert s.get(Prescription, rx).refills_used == 0
        assert len(s.scalars(select(Claim)).all()) == 1
    workflow.complete_follow_up(pharm, fill, "Patient and prescriber follow-up recorded")
    assert not ExceptionService(svc).list(actors["AUDITOR"], kind="EMERGENCY_FOLLOW_UP")


def test_emergency_enforces_controlled_dur_and_active_owed_barriers(env):
    svc, actors, _, rx, drug, stock, exp, original, due = env
    pharm = actors["PHARMACIST"]
    workflow = EmergencySupplyService(svc)
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = True
    with pytest.raises(WorkflowError, match="Controlled"):
        workflow.authorize(pharm, rx, "5", "Controlled blocked", due)
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = False
    alert = svc.add_dur_issue(pharm, rx, "HIGH", "SIMULATED_CLINICAL_ISSUE")
    with pytest.raises(WorkflowError, match="DUR"):
        workflow.authorize(pharm, rx, "5", "DUR blocked", due)
    svc.resolve_dur(pharm, alert, "Synthetic issue resolved")
    fill = workflow.authorize(pharm, rx, "5", "Permitted after pharmacist assessment", due)
    with pytest.raises(WorkflowError, match="reconciliation"):
        LifecycleService(svc).cancel(actors["TECHNICIAN"], rx, "Cannot erase sale")
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PRODUCT_FILL"


def test_emergency_api_explicitly_disabled_without_opt_in(env):
    svc, actors, other, rx, drug, stock, exp, original, due = env
    path = f"/api/emergency-supplies/prescriptions/{rx}/authorize"
    base = {"quantity": "5", "reason": "Synthetic provider follow-up needed",
            "follow_up_due_at": due}
    closed = TestClient(create_app(svc, synthetic_enabled=False))
    head = {"x-demo-staff-id": actors["PHARMACIST"].id}
    assert closed.post(path, headers=head, json=base).status_code == 503
    client = TestClient(create_app(svc, synthetic_enabled=True))
    wrong_site = {"x-demo-staff-id": other["PHARMACIST"].id}
    assert client.post(path, headers=wrong_site, json=base).status_code == 409
    assert client.post(path, headers={"x-demo-staff-id": actors["TECHNICIAN"].id},
                       json=base).status_code == 403
    authorized = client.post(path, headers=head, json=base)
    assert authorized.status_code == 201
    fill = authorized.json()["fill_id"]
    assert client.get("/api/emergency-supplies", headers=wrong_site).json() == {
        "emergency_supplies": []}
    assert len(client.get("/api/emergency-supplies", headers=head).json()["emergency_supplies"]) == 1
    response = client.post(f"/api/emergency-supplies/{fill}/follow-up/complete",
        headers=head, json={"note": "Premature"})
    assert response.status_code == 409


def test_emergency_rechecks_changed_drug_and_refill_rules_at_every_transition(env):
    svc, actors, _, rx, drug, stock, exp, original, due = env
    pharm, tech = actors["PHARMACIST"], actors["TECHNICIAN"]
    flow = EmergencySupplyService(svc)
    fid = flow.authorize(pharm, rx, "5", "Documented temporary need", due)

    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = True
    with pytest.raises(WorkflowError, match="controlled"):
        svc.scan_source(tech, fid, "EMERG-BAR", "EMERGLOT", exp, "5")
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == 0
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = False

    svc.scan_source(tech, fid, "EMERG-BAR", "EMERGLOT", exp, "5")
    with svc.sessions.begin() as s:
        s.get(Prescription, rx).refills_allowed = 1
    with pytest.raises(WorkflowError, match="Authorized refills are now available"):
        svc.prepare_for_review(tech, fid, [])
    with svc.sessions.begin() as s:
        s.get(Prescription, rx).refills_allowed = 0

    svc.prepare_for_review(tech, fid, [])
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = True
    with pytest.raises(WorkflowError, match="controlled"):
        svc.verify(pharm, fid)
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = False
    svc.verify(pharm, fid)

    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = True
    with pytest.raises(WorkflowError, match="controlled"):
        svc.sell(tech, fid, True, True, "0", "CASH")
    with pytest.raises(WorkflowError, match="controlled"):
        PosService(svc).checkout(actors["CASHIER"],
            lines=[{"fill_id": fid, "amount": "0.00"}], tenders=[],
            scanned_bags={}, recipient_name="Synthetic Recipient",
            identity_method="DATE_OF_BIRTH", signature_method="PAPER",
            signature_attested=True, idempotency_key="STALE-EMERGENCY",
            mode="IMMEDIATE")
    with svc.sessions() as s:
        assert s.get(Fill, fid).status == "READY"
        assert s.get(Prescription, rx).refills_used == 0
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = False
    svc.sell(tech, fid, True, True, "0", "CASH")
    with svc.sessions() as s:
        assert s.get(Fill, fid).status == "SOLD"
        assert len(s.scalars(select(Claim)).all()) == 1
