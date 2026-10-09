"""Synthetic contract tests for interrupted fills and owed physical completions."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.date_rules import DateRulesService
from pharmacy1os.fill_completion import FillCompletion, FillCompletionService, FillObligation
from pharmacy1os.lifecycle import LifecycleService
from pharmacy1os.models import Claim, Fill, FillSource, Label, Prescription, Stock
from pharmacy1os.pos import PosService
from pharmacy1os.scheduling import SchedulingService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    service = PharmacyService()
    service.create_schema()
    actors = service.bootstrap_demo()["actors"]
    other = service.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = service.add_patient(tech, "Synthetic", "Partial")
    physician = service.add_prescriber(tech, "Synthetic", "Prescriber", "MD")
    drug = service.add_drug(pharm, "Example tablet", "5 mg", "tablet")
    product = service.add_product(pharm, drug, "00000-9999-77", "Synthetic", "White tablets")
    service.register_barcode(tech, product, "PART-5MG")
    expiry = (date.today() + timedelta(days=180)).isoformat()
    stock = service.receive(tech, "PART-5MG", "PART-LOT", expiry, "150")
    rx = service.add_prescription(tech, patient, physician, drug, "RX-PART", "One daily", "90", refills=2)
    service.advance_to_dur(tech, rx)
    return service, actors, other, rx, stock, expiry


def ready(service, actors, fid, expiry, qty, payers=()):
    service.scan_source(actors["TECHNICIAN"], fid, "PART-5MG", "PART-LOT", expiry, str(qty))
    labels = service.prepare_for_review(actors["TECHNICIAN"], fid, list(payers))
    service.verify(actors["PHARMACIST"], fid)
    return labels


def test_interruption_rescans_part_then_completes_without_new_claim_or_refill(env):
    svc, actors, other, rx, stock, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    flow = FillCompletionService(svc)
    primary = svc.start_fill(tech, rx)
    svc.scan_source(tech, primary, "PART-5MG", "PART-LOT", expiry, "60")
    obligation = flow.interrupt_as_partial(tech, primary, "12", "Only 12 physically available")
    assert obligation
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == 0
        assert s.scalars(select(FillSource).where(FillSource.fill_id == primary)).all() == []
        assert s.get(Fill, primary).quantity == 12
    labels = ready(svc, actors, primary, expiry, 12, ["Synthetic primary"])
    assert "12.000/12.000" in labels[0]
    svc.sell(tech, primary, True, True, "0", "CASH")
    snapshot = flow.balance(tech, primary)
    assert snapshot["remaining_owed"] == "78.000"
    assert snapshot["physically_sold"] == "12.000"
    with pytest.raises(WorkflowError, match="outstanding partial"):
        SchedulingService(svc).begin_refill_review(tech, rx, "Need next refill")
    with pytest.raises(WorkflowError, match="outstanding partial"):
        SchedulingService(svc).schedule(tech, rx, date.today().isoformat(),
                                         "PART-SCHEDULE")
    with pytest.raises(WorkflowError, match="remaining"):
        flow.begin_completion(tech, primary, "79")
    with pytest.raises(WorkflowError, match="not found at this site"):
        flow.balance(other["PHARMACIST"], primary)

    # Refill interval applies to new logical fills, not to the remainder of this claim.
    DateRulesService(svc).set_minimum_days(pharm, rx, 30, "Synthetic test policy")
    second = flow.begin_completion(tech, primary, "78")
    with pytest.raises(WorkflowError, match="already active|available"):
        flow.begin_completion(tech, primary, "78")
    with pytest.raises(WorkflowError, match="another synthetic payer"):
        svc.scan_source(tech, second, "PART-5MG", "PART-LOT", expiry, "78")
        svc.prepare_for_review(tech, second, ["Second false claim"])
    labels = svc.prepare_for_review(tech, second, [])
    assert "78.000/78.000" in labels[0]
    svc.verify(pharm, second)
    # Second physical part may be checked out via the multi-fill POS path.
    checkout = PosService(svc).checkout(actors["CASHIER"],
        lines=[{"fill_id": second, "amount": "0.00"}], tenders=[],
        scanned_bags={}, recipient_name="Synthetic Patient",
        identity_method="DATE_OF_BIRTH", signature_method="PAPER",
        signature_attested=True, idempotency_key="PART-SECOND", mode="IMMEDIATE")
    assert checkout["status"] == "POSTED"
    snapshot = flow.balance(tech, primary)
    assert snapshot["status"] == "FULFILLED"
    assert snapshot["remaining_owed"] == "0.000"
    assert snapshot["physically_sold"] == "90.000"
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal("60")
        fills = [s.get(Fill, fid) for fid in (primary, second)]
        assert [x.fill_number for x in fills] == [0, 0]
        assert [x.attempt for x in fills] == [1, 2]
        assert s.get(Prescription, rx).refills_used == 0
        assert len(s.scalars(select(Claim)).all()) == 1
        assert len(s.scalars(select(Label)).all()) == 2
        assert s.scalar(select(FillCompletion).where(FillCompletion.fill_id == second)).part_number == 2


def test_direct_short_fill_tracks_owed_and_rejects_duplicate_completion_claim(env):
    svc, actors, _, rx, stock, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    flow = FillCompletionService(svc)
    anchor = svc.start_fill(tech, rx, "30")
    assert flow.balance(tech, anchor)["remaining_owed"] == "90.000"
    with pytest.raises(WorkflowError, match="physically sold"):
        flow.begin_completion(tech, anchor, "60")
    ready(svc, actors, anchor, expiry, 30, ["Primary"])
    svc.sell(tech, anchor, True, True, "0", "CASH")
    fid = flow.begin_completion(tech, anchor, "60")
    svc.scan_source(tech, fid, "PART-5MG", "PART-LOT", expiry, "60")
    with pytest.raises(WorkflowError, match="cannot create another"):
        svc.prepare_for_review(tech, fid, ["Duplicate primary"])
    with svc.sessions() as s:
        assert s.get(Fill, fid).status == "PRODUCT_FILL"
        assert len(s.scalars(select(Claim)).all()) == 1
    svc.prepare_for_review(tech, fid, [])
    svc.verify(pharm, fid)
    svc.sell(tech, fid, True, True, "0", "CASH")
    assert flow.balance(tech, anchor)["status"] == "FULFILLED"


def test_unsold_partial_return_to_stock_voids_obligation_and_allows_retry(env):
    svc, actors, _, rx, stock, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    flow = FillCompletionService(svc)
    anchor = svc.start_fill(tech, rx, "15")
    ready(svc, actors, anchor, expiry, 15, ["Sandbox payer"])
    svc.return_to_stock(pharm, anchor, "Patient no longer wants this fill")
    assert flow.balance(tech, anchor)["status"] == "VOID_UNSOLD"
    retry = svc.start_fill(tech, rx)
    with svc.sessions() as s:
        assert s.get(Fill, retry).attempt == 2
        assert s.get(Stock, stock).on_hand == Decimal("150")


def test_completion_return_keeps_owed_balance_without_new_claim(env):
    svc, actors, _, rx, stock, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    flow = FillCompletionService(svc)
    root = svc.start_fill(tech, rx, "20")
    ready(svc, actors, root, expiry, 20, ["First"])
    svc.sell(tech, root, True, True, "0", "CASH")
    second = flow.begin_completion(tech, root, "70")
    ready(svc, actors, second, expiry, 70)
    svc.return_to_stock(pharm, second, "Patient declined remainder")
    assert flow.balance(tech, root)["remaining_owed"] == "70.000"
    with svc.sessions() as s:
        assert s.get(Prescription, rx).status == "SOLD"
    third = flow.begin_completion(tech, root, "70")
    assert third != second
    with svc.sessions() as s:
        assert s.get(Fill, third).fill_number == s.get(Fill, root).fill_number
        assert len(s.scalars(select(Claim)).all()) == 1


def test_interruption_rejections_are_atomic_and_cancellation_boundaries(env):
    svc, actors, other, rx, stock, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    flow = FillCompletionService(svc)
    root = svc.start_fill(tech, rx)
    svc.scan_source(tech, root, "PART-5MG", "PART-LOT", expiry, "30")
    for qty, reason in [("90", "Not partial"), ("NaN", "Invalid"), ("10", "")]:
        with pytest.raises(WorkflowError):
            flow.interrupt_as_partial(tech, root, qty, reason)
    with pytest.raises(WorkflowError):
        flow.interrupt_as_partial(other["TECHNICIAN"], root, "10", "Wrong site")
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == Decimal("30")
    flow.interrupt_as_partial(tech, root, "10", "Reported on hand discrepancy")
    with pytest.raises(WorkflowError):
        flow.interrupt_as_partial(tech, root, "5", "Double interruption")
    LifecycleService(svc).cancel(tech, rx, "Synthetic prescription cancelled")
    assert flow.balance(tech, root)["status"] == "VOID_UNSOLD"
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == 0


def test_sold_partial_cannot_be_cancelled_with_unresolved_owed_balance(env):
    svc, actors, _, rx, stock, expiry = env
    tech = actors["TECHNICIAN"]
    root = svc.start_fill(tech, rx, "10")
    ready(svc, actors, root, expiry, 10)
    svc.sell(tech, root, True, True, "0", "CASH")
    with pytest.raises(WorkflowError):
        LifecycleService(svc).cancel(tech, rx, "Attempt to erase owed quantity")
    with svc.sessions() as s:
        assert s.get(Prescription, rx).status == "SOLD"


def test_partial_api_is_synthetic_only_and_site_bound(env):
    svc, actors, other, rx, stock, expiry = env
    root = svc.start_fill(actors["TECHNICIAN"], rx)
    client = TestClient(create_app(svc, synthetic_enabled=True))
    denied = {"x-demo-staff-id": other["TECHNICIAN"].id}
    tech = {"x-demo-staff-id": actors["TECHNICIAN"].id}
    assert client.post(f"/api/fills/{root}/interrupt-as-partial",
        json={"quantity": "10", "reason": "Unauthorized"}, headers=denied).status_code == 409
    r = client.post(f"/api/fills/{root}/interrupt-as-partial",
        json={"quantity": "10", "reason": "Synthetic shortage"}, headers=tech)
    assert r.status_code == 200
    balance = client.get(f"/api/fills/{root}/owed-balance", headers=tech)
    assert balance.status_code == 200
    assert balance.json()["remaining_owed"] == "90.000"
    assert client.post(f"/api/fills/{root}/begin-completion",
                       json={}, headers=tech).status_code == 409
    assert TestClient(create_app(svc)).get(f"/api/fills/{root}/owed-balance",
             headers=tech).status_code == 503
