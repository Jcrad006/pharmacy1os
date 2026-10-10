"""Selective COB correction preflight and status-safety regression tests.

Preflight is read-only: no partial insurer claim mutation exists in this increment.
"""
from datetime import date, timedelta, datetime, timezone
from hashlib import sha256

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.claim_rebilling import ClaimRebillService
from pharmacy1os.claim_transactions import SandboxClaimService, record_test_reversal
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.cob_correction_plan import CobCorrectionPlanner
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.label_printing import LabelPrintService
from pharmacy1os.models import Claim, Fill, Stock
from pharmacy1os.service import PharmacyService, WorkflowError
from pharmacy1os.third_party_workspace import ThirdPartyWorkspace


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "CorrectionPlanner")
    prescriber = svc.add_prescriber(tech, "Synthetic", "Doctor", "MD")
    drug = svc.add_drug(pharm, "Development COB planning drug", "10mg", "tablet")
    product = svc.add_product(pharm, drug, "98800-1111-13", "Demo", "White demo pill")
    svc.register_barcode(tech, product, "COB-PLAN-BC")
    expiry = (date.today() + timedelta(days=300)).isoformat()
    stock = svc.receive(tech, "COB-PLAN-BC", "COB-PLAN-LOT", expiry, "160")
    rx = svc.add_prescription(tech, patient, prescriber, drug,
        "COB-PLAN-RX", "Take one per day", "80")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, days_supply=80)
    svc.scan_source(tech, fill, "COB-PLAN-BC", "COB-PLAN-LOT", expiry, "80")
    return svc, actors, outside, patient, rx, fill, stock


def _ready(case, count=4):
    svc, a, outside, patient, rx, fill, stock = case
    names = ["First Plan", "Second Plan", "Third Plan", "Fourth Plan"][:count]
    svc.prepare_for_review(a["TECHNICIAN"], fill, names)
    return [e for e in SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
            if e["operation"] == "BILL"]


def test_preflight_orders_one_target_and_downstream_positions_without_mutation(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = _ready(case)
    before = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    planner = CobCorrectionPlanner(svc)
    plan = planner.plan(a["AUDITOR"], fill, target_position=2)
    assert plan["payer_count"] == 4
    assert plan["target_position"] == 2
    assert plan["reverse_positions"] == [4, 3, 2]
    assert plan["then_reprocess_positions"] == [2, 3, 4]
    assert plan["upstream_positions_unchanged"] == [1]
    assert plan["reverse_transaction_ids"] == [
        bills[3]["id"], bills[2]["id"], bills[1]["id"]]
    assert plan["payer_intended_quantity"] == "80.000"
    assert plan["action_enabled"] is False
    assert plan["requires_new_claim_event_generation"] is True
    assert "READ_ONLY_SYNTHETIC_PREFLIGHT" in plan["warning"]
    assert planner.plan(a["PHARMACIST"], fill, target_position=4)[
        "reverse_positions"] == [4]
    assert planner.plan(a["AUDITOR"], fill, target_position=1)[
        "reverse_positions"] == [4, 3, 2, 1]
    assert before == SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    with svc.sessions() as s:
        assert all(c.status == "PAID_SYNTHETIC" for c in s.scalars(select(Claim)))
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.get(Stock, stock).reserved == 80


def test_plan_rejects_invalid_site_position_print_and_corrupt_source(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = _ready(case, 2)
    planner = CobCorrectionPlanner(svc)
    with pytest.raises(WorkflowError, match="outside"):
        planner.plan(outside["AUDITOR"], fill, target_position=1)
    for position in (0, 3, 5, True, "2"):
        with pytest.raises(WorkflowError):
            planner.plan(a["AUDITOR"], fill, target_position=position)
    with svc.sessions.begin() as s:
        first = s.scalar(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.id == bills[0]["id"]))
        original = first.request_json
        first.request_json = '{"changed":"unexpected"}'
    with pytest.raises(WorkflowError, match="integrity"):
        planner.plan(a["AUDITOR"], fill, target_position=1)
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, bills[0]["id"]).request_json = original
    job = LabelPrintService(svc).list(a["PHARMACIST"], fill)[0]
    LabelPrintService(svc).record_output_attempt(a["PHARMACIST"], job["id"],
        "PLAN-SYN-PRINTER", "Synthetic operating system dialog was accepted",
        dialog_accepted=True)
    with pytest.raises(WorkflowError, match="printed labels"):
        planner.plan(a["AUDITOR"], fill, target_position=2)


def test_preflight_requires_unreversed_complete_claim_set(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = _ready(case, 2)
    planner = CobCorrectionPlanner(svc)
    with svc.sessions.begin() as s:
        claim = s.get(Claim, bills[1]["claim_id"])
        claim.status = "REVERSED_SYNTHETIC"
    with pytest.raises(WorkflowError, match="partially reversed"):
        planner.plan(a["AUDITOR"], fill, target_position=2)


def test_verification_refuses_partially_reversed_claim_without_deducting_stock(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = _ready(case, 2)
    with svc.sessions.begin() as s:
        s.get(Claim, bills[1]["claim_id"]).status = "REVERSED_SYNTHETIC"
    with pytest.raises(WorkflowError, match="re-adjudication"):
        svc.verify(a["PHARMACIST"], fill)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.get(Stock, stock).reserved == 80
        assert s.get(Stock, stock).on_hand == 160
    with svc.sessions.begin() as s:
        claim = s.get(Claim, bills[1]["claim_id"])
        claim.status = "PAID_SYNTHETIC"
        record_test_reversal(s, a["PHARMACIST"], claim, "Deliberate simulated ledger mismatch")
    with pytest.raises(WorkflowError, match="manual billing reconciliation"):
        svc.verify(a["PHARMACIST"], fill)
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == 80
        assert s.get(Stock, stock).on_hand == 160


def test_cob_preflight_api_gated_and_read_only(case):
    svc, a, outside, patient, rx, fill, stock = case
    _ready(case)
    client = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    endpoint = f"/api/third-party/fills/{fill}/cob-correction-plan?target_position=3"
    header = {"x-demo-staff-id": a["AUDITOR"].id}
    assert disabled.get(endpoint, headers=header).status_code == 503
    assert client.get(endpoint).status_code == 403
    assert client.get(endpoint, headers=header).status_code == 200
    assert client.get(endpoint, headers=header).json()["reverse_positions"] == [4, 3]
    assert client.get(endpoint, headers={"x-demo-staff-id": outside["AUDITOR"].id}).status_code == 409
    assert client.get(endpoint.replace("target_position=3", "target_position=0"),
                      headers=header).status_code == 409


def _bulk_local_events(svc, actor, fill_id, count):
    """Test-only synthetic ledger noise bypassing external adapters entirely."""
    from pharmacy1os.models import uuid
    payload = "{}"
    digest = sha256(payload.encode()).hexdigest()
    with svc.sessions.begin() as s:
        s.add_all([
            SandboxClaimTransaction(
                id=uuid(), site_id=actor.site_id, fill_id=fill_id,
                operation="TEST_RESOLVE", outcome="CLEARED_TEST_HOLD",
                idempotency_key=f"test-workbench-history-spill-{i}",
                request_json=payload,
                response_json='{"outcome":"CLEARED_TEST_HOLD"}',
                request_sha256=digest, actor_id=actor.id)
            for i in range(count)
        ])


def test_workspace_keeps_open_rejection_visible_beyond_300_recent_events(case):
    svc, a, outside, patient, rx, fill, stock = case
    directory = InsuranceDirectory(svc)
    payer = directory.create_payer(a["PHARMACIST"], "Synthetic cap plan")
    cov = directory.upsert_coverage(a["PHARMACIST"], patient, 1, payer,
                                     "TEST-MEMBER-REDACT-ME")
    ledger = SandboxClaimService(svc)
    rejection = ledger.inject_rejection(a["PHARMACIST"], fill, cov,
        "TEST_75", "SYN-CAP-HOLD-ONE", "Prior authorization mocked for test only")
    _bulk_local_events(svc, a["PHARMACIST"], fill, 315)
    view = ThirdPartyWorkspace(svc).snapshot(a["AUDITOR"])
    assert len(view["recentClaimEvents"]) == 300
    assert rejection not in [x["id"] for x in view["recentClaimEvents"]]
    assert len(view["claimIssues"]) == 1
    assert view["claimIssues"][0]["id"] == rejection
    assert view["openIssueListTruncated"] is False
    assert view["limits"]["open_issues"] == 100
    assert "TEST-MEMBER-REDACT-ME" not in str(view)
    ledger.resolve_rejection(a["PHARMACIST"], rejection,
        "Cleared development-only rejection following independent mock review")
    later = ThirdPartyWorkspace(svc).snapshot(a["AUDITOR"])
    assert later["claimIssues"] == []


def test_workspace_marks_resolved_rejections_using_full_history_not_page(case):
    svc, a, outside, patient, rx, fill, stock = case
    directory = InsuranceDirectory(svc)
    payer = directory.create_payer(a["PHARMACIST"], "Test resolution plan")
    cov = directory.upsert_coverage(a["PHARMACIST"], patient, 1, payer, "SHOULD-BE-MASKED")
    ledger = SandboxClaimService(svc)
    rejection = ledger.inject_rejection(a["PHARMACIST"], fill, cov,
        "TEST_79", "SYN-OLD-RESOLUTION", "Test old resolution pagination correctness")
    resolution = ledger.resolve_rejection(a["PHARMACIST"], rejection,
        "Verified the test hold is resolved locally not by real insurer")
    # Make the original reject visible but resolution fall outside the
    # 300-row display only; this is synthetic test data reordering.
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, resolution).recorded_at = (
            datetime(2000, 1, 1, tzinfo=timezone.utc))
    _bulk_local_events(svc, a["PHARMACIST"], fill, 305)
    # Reject is older than newer event batch; force reject into recent window.
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, rejection).recorded_at = (
            datetime(2099, 1, 1, tzinfo=timezone.utc))
    view = ThirdPartyWorkspace(svc).snapshot(a["AUDITOR"])
    visible = next(x for x in view["recentClaimEvents"] if x["id"] == rejection)
    assert visible["status"] == "CLEARED_TEST_HOLD"
    assert view["claimIssues"] == []
