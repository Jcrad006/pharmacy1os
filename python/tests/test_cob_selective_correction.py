"""Increment 50: atomic selective synthetic COB payer correction, not a real claim."""
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.billing import BillingService
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.cob_attempts import CobAttemptRegistry, SyntheticCobAttempt, SyntheticCobAttemptReversal
from pharmacy1os.cob_selective_correction import SyntheticCobCorrectionService
from pharmacy1os.label_printing import LabelPrintService
from pharmacy1os.models import Audit, Claim, Fill, Label, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    drug = svc.add_drug(pharm, "COB corrected source medication", "10mg", "tablet")
    expiry = (date.today() + timedelta(days=180)).isoformat()
    stocks = []
    for idx in (1, 2):
        p = svc.add_product(pharm, drug, f"60000-4444-0{idx}",
                            f"Demo Manufacturer {idx}", f"Test pills {idx}")
        svc.register_barcode(tech, p, f"CORRECT-SCAN-{idx}")
        stocks.append(svc.receive(tech, f"CORRECT-SCAN-{idx}",
                                  f"CORRECT-LOT-{idx}", expiry, "100"))
    pat = svc.add_patient(tech, "Correction", "Synthetic")
    provider = svc.add_prescriber(tech, "Correction", "Doctor", "MD")
    rx = svc.add_prescription(tech, pat, provider, drug,
                              "COB-CORRECT-SYN-RX", "daily", "60")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, days_supply=60)
    svc.scan_source(tech, fill, "CORRECT-SCAN-1", "CORRECT-LOT-1", expiry, "40")
    svc.scan_source(tech, fill, "CORRECT-SCAN-2", "CORRECT-LOT-2", expiry, "20")
    return svc, actors, outside, rx, fill, stocks, expiry


def prepare(case, count=4):
    svc, a, out, rx, fill, stocks, exp = case
    svc.prepare_for_review(a["TECHNICIAN"], fill,
        ["Primary Mock", "Secondary Mock", "Tertiary Mock", "Fourth Mock"][:count])
    return CobAttemptRegistry(svc).history(a["AUDITOR"], fill)


def desc(history, target):
    return [row["attempts"][-1]["paid_transaction_id"] for row
            in reversed(history["claim_positions"][target-1:])]


def test_correct_middle_payer_preserves_upstream_and_physical_fill(case):
    svc, a, out, rx, fill, stocks, exp = case
    before = prepare(case)
    original_label_jobs = LabelPrintService(svc).list(a["PHARMACIST"], fill)
    original_stock = {}
    with svc.sessions() as s:
        original_stock = {x.id: (x.on_hand, x.reserved)
                          for x in s.scalars(select(Stock).where(Stock.id.in_(stocks))).all()}
    original_events = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    action = SyntheticCobCorrectionService(svc)
    ids = desc(before, 2)
    note = "Correct documented synthetic payer NDC to already scanned second source"
    result = action.correct(a["PHARMACIST"], fill, note,
        target_position=2, expected_active_paid_transaction_ids=ids,
        corrected_billing_ndc="60000-4444-02")
    assert result["positions_reversed"] == [4, 3, 2]
    assert result["positions_reprocessed"] == [2, 3, 4]
    assert result["original_active_paid_transaction_ids"] == ids
    assert len(result["reversal_transaction_ids"]) == 3
    assert len(result["new_paid_transaction_ids"]) == 3
    assert result["replayed"] is False
    assert not result["external_payer_contact"] and not result["stock_moved"]
    after = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    assert after["total_attempts"] == 7 and after["active_local_paid_positions"] == 4
    assert [len(x["attempts"]) for x in after["claim_positions"]] == [1, 2, 2, 2]
    assert after["claim_positions"][0]["attempts"] == before["claim_positions"][0]["attempts"]
    assert after["claim_positions"][1]["attempts"][-1]["billed_ndc"] == "60000-4444-02"
    assert after["claim_positions"][2]["attempts"][-1]["billed_ndc"] == "60000-4444-01"
    all_tx = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    assert len([tx for tx in all_tx if tx["operation"] == "REVERSE"]) == 3
    assert len([tx for tx in all_tx if tx["operation"] == "BILL"]) == 7
    assert [x["original_transaction_id"] for x in all_tx if
            x["id"] in result["reversal_transaction_ids"]] == ids
    for txid in result["new_paid_transaction_ids"]:
        row = next(x for x in all_tx if x["id"] == txid)
        assert row["response"]["authorization_number"] is None
        assert row["response"]["amount_paid"] is None
        assert row["request"]["external_submission"] is False
    assert LabelPrintService(svc).list(a["PHARMACIST"], fill) == original_label_jobs
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert all(c.status == "PAID_SYNTHETIC" for c in s.scalars(
            select(Claim).where(Claim.fill_id == fill)))
        assert {x.id: (x.on_hand, x.reserved) for x in s.scalars(
            select(Stock).where(Stock.id.in_(stocks))).all()} == original_stock
        assert len(s.scalars(select(Label).where(Label.fill_id == fill)).all()) == 2
        assert s.scalar(select(Audit.id).where(Audit.kind ==
            "SYNTHETIC_SELECTIVE_COB_REPROCESSED")) is not None
    assert len(BillingService(svc).history(a["AUDITOR"], fill)) == 4
    replay = action.correct(a["PHARMACIST"], fill, note,
        target_position=2, expected_active_paid_transaction_ids=ids,
        corrected_billing_ndc="60000-4444-02")
    assert replay["replayed"] is True
    assert replay["reversal_transaction_ids"] == result["reversal_transaction_ids"]
    assert replay["new_paid_transaction_ids"] == result["new_paid_transaction_ids"]
    assert len(SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)) == len(all_tx)


def test_multiple_rounds_and_pharmacist_verification_use_versioned_ledger(case):
    svc, a, out, rx, fill, stocks, exp = case
    prepare(case, 4)
    action = SyntheticCobCorrectionService(svc)
    history = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    note1 = "First test correction to second scanned NDC for secondary mock payer"
    first = action.correct(a["PHARMACIST"], fill, note1,
        target_position=2, expected_active_paid_transaction_ids=desc(history,2),
        corrected_billing_ndc="60000-4444-02")
    newer = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    second = action.correct(a["PHARMACIST"], fill,
        "Second simulated correction updates tertiary position and fourth downstream",
        target_position=3, expected_active_paid_transaction_ids=desc(newer,3),
        corrected_billing_ndc="60000-4444-02")
    history = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    assert history["total_attempts"] == 9
    assert [len(c["attempts"]) for c in history["claim_positions"]] == [1,2,3,3]
    assert all(c["current_paid_attempt_id"] for c in history["claim_positions"])
    assert first["new_paid_transaction_ids"][0] == history["claim_positions"][1][
        "attempts"][-1]["paid_transaction_id"]
    assert second["new_paid_transaction_ids"][0] == history["claim_positions"][2][
        "attempts"][-1]["paid_transaction_id"]
    svc.verify(a["PHARMACIST"], fill)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "READY"
        assert all(s.get(Stock, id).reserved == 0 for id in stocks)
        assert sum(s.get(Stock, id).on_hand for id in stocks) == 140


def test_blocks_stale_order_role_site_printed_label_and_unscanned_ndc(case):
    svc, a, out, rx, fill, stocks, exp = case
    history = prepare(case, 3)
    ids = desc(history, 2)
    subject = SyntheticCobCorrectionService(svc)
    note = "Synthetic correction needs complete downstream COB payer positions"
    with pytest.raises(AccessDenied):
        subject.correct(a["TECHNICIAN"], fill, note, target_position=2,
            expected_active_paid_transaction_ids=ids, corrected_billing_ndc="60000-4444-01")
    with pytest.raises(WorkflowError, match="outside"):
        subject.correct(out["PHARMACIST"], fill, note, target_position=2,
            expected_active_paid_transaction_ids=ids, corrected_billing_ndc="60000-4444-01")
    for wrong in (ids[::-1], ids[:1], ["no-such-id", ids[-1]]):
        with pytest.raises(WorkflowError):
            subject.correct(a["PHARMACIST"], fill, note, target_position=2,
                expected_active_paid_transaction_ids=wrong, corrected_billing_ndc="60000-4444-01")
    with pytest.raises(WorkflowError, match="scanned"):
        subject.correct(a["PHARMACIST"], fill, note, target_position=2,
            expected_active_paid_transaction_ids=ids, corrected_billing_ndc="99999-0000-00")
    assert CobAttemptRegistry(svc).history(a["AUDITOR"], fill)["total_attempts"] == 3
    label_job = LabelPrintService(svc).list(a["PHARMACIST"], fill)[0]
    LabelPrintService(svc).record_output_attempt(a["PHARMACIST"], label_job["id"],
        "CORRECTION-NATIVE-PRINT-TEST", "Native synthetic spool dialog accepted",
        dialog_accepted=True)
    with pytest.raises(WorkflowError, match="Printed test labels"):
        subject.correct(a["PHARMACIST"], fill, note, target_position=2,
            expected_active_paid_transaction_ids=ids, corrected_billing_ndc="60000-4444-02")


def test_fail_halfway_rolls_back_all_local_reversals_and_resubmissions(case):
    svc, a, out, rx, fill, stocks, exp = case
    initial = prepare(case,4)
    ids = desc(initial,1)
    with patch("pharmacy1os.cob_selective_correction.append_paid_correction_tx",
        side_effect=WorkflowError("Injected failure during repeated mock payer submission")):
        with pytest.raises(WorkflowError, match="Injected failure"):
            SyntheticCobCorrectionService(svc).correct(
                a["PHARMACIST"], fill,
                "Test transaction rollback when a synthetic resubmission raises an error",
                target_position=1, expected_active_paid_transaction_ids=ids,
                corrected_billing_ndc="60000-4444-02")
    current = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    assert current == initial
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert [s.get(Stock, id).reserved for id in stocks] == [40,20]
        assert s.scalars(select(SyntheticCobAttemptReversal)).all() == []


def test_synthetic_api_gating_validation_and_retry_idempotency(case):
    svc, a, out, rx, fill, stocks, exp = case
    history = prepare(case,3)
    ids = desc(history,3)
    endpoint = f"/api/third-party/fills/{fill}/correct-cob"
    headers = {"x-demo-staff-id": a["PHARMACIST"].id}
    body = {
        "target_position": 3, "expected_active_paid_transaction_ids": ids,
        "corrected_billing_ndc": "60000-4444-02",
        "reason": "Reprocess one local third-position mock claim for documented NDC adjustment",
    }
    enabled = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    assert disabled.post(endpoint, headers=headers, json=body).status_code == 503
    assert enabled.post(endpoint, json=body).status_code == 403
    assert enabled.post(endpoint, headers={
        "x-demo-staff-id": a["TECHNICIAN"].id}, json=body).status_code == 403
    assert enabled.post(endpoint, headers={
        "x-demo-staff-id": out["PHARMACIST"].id}, json=body).status_code == 409
    assert enabled.post(endpoint, headers=headers, json={
        **body, "target_position": 0}).status_code == 422
    first = enabled.post(endpoint, headers=headers, json=body)
    assert first.status_code == 200, first.text
    assert first.json()["positions_reprocessed"] == [3]
    last = enabled.post(endpoint, headers=headers, json=body)
    assert last.status_code == 200 and last.json()["replayed"] is True
    assert last.json()["new_paid_transaction_ids"] == first.json()["new_paid_transaction_ids"]


def test_partial_reversal_forgery_or_changed_snapshot_blocks_verified_stock(case):
    svc, a, out, rx, fill, stocks, exp = case
    prepare(case, 2)
    with svc.sessions.begin() as s:
        first = s.scalar(select(SyntheticCobAttempt).where(
            SyntheticCobAttempt.coverage_position == 2))
        paid = s.get(SandboxClaimTransaction, first.paid_transaction_id)
        from pharmacy1os.claim_transactions import _record
        request = {"claim_id": first.claim_id, "manual_correction": "unreconciled"}
        ev = _record(s, a["PHARMACIST"], fill, "REVERSE", "REVERSED_SYNTHETIC",
            f"manual-fake-reversal:{first.id}", request,
            {"outcome": "REVERSED_SYNTHETIC"}, claim_id=first.claim_id,
            original_id=paid.id)
    with pytest.raises(WorkflowError, match="manual billing reconciliation"):
        svc.verify(a["PHARMACIST"], fill)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.get(Stock, stocks[0]).reserved == 40


def test_corrected_attempts_do_not_use_unsafe_legacy_full_fill_restart(case):
    svc, a, out, rx, fill, stocks, exp = case
    from pharmacy1os.claim_rebilling import ClaimRebillService
    history = prepare(case, 2)
    ids = desc(history,2)
    SyntheticCobCorrectionService(svc).correct(a["PHARMACIST"], fill,
        "Correct an existing second position locally before any physical dispense",
        target_position=2, expected_active_paid_transaction_ids=ids,
        corrected_billing_ndc="60000-4444-02")
    claim_ids = [c["claim_id"] for c in CobAttemptRegistry(svc).history(
        a["AUDITOR"],fill)["claim_positions"]]
    with pytest.raises(WorkflowError, match="Versioned selective"):
        ClaimRebillService(svc).restart(a["PHARMACIST"],fill,
            "Legacy full restart cannot understand repeated synthetic claim positions",
            expected_claim_ids=claim_ids)


def test_version_aware_preflight_tracks_current_paid_suffix_after_two_corrections(case):
    """The read-only preview must never return a reversed historic payer ID."""
    from pharmacy1os.cob_correction_plan import CobCorrectionPlanner
    svc, a, out, rx, fill, stocks, exp = case
    registry = CobAttemptRegistry(svc)
    planner = CobCorrectionPlanner(svc)
    before = prepare(case, 4)
    first = planner.plan(a["AUDITOR"], fill, target_position=2)
    assert first["reverse_transaction_ids"] == desc(before, 2)
    assert first["expected_active_paid_transaction_ids"] == desc(before, 2)
    assert first["reverse_positions"] == [4, 3, 2]
    assert first["then_reprocess_positions"] == [2, 3, 4]
    assert first["action_enabled"] is True
    assert first["available_billing_ndcs"] == [
        "60000-4444-01", "60000-4444-02"]
    action = SyntheticCobCorrectionService(svc)
    action.correct(a["PHARMACIST"], fill,
        "First NDC correction must refresh dynamic payer attempt identity",
        target_position=2, expected_active_paid_transaction_ids=first[
            "expected_active_paid_transaction_ids"],
        corrected_billing_ndc="60000-4444-02")
    after = registry.history(a["AUDITOR"], fill)
    new_plan = planner.plan(a["AUDITOR"], fill, target_position=3)
    assert new_plan["reverse_positions"] == [4, 3]
    assert new_plan["expected_active_paid_transaction_ids"] == desc(after, 3)
    assert new_plan["expected_active_paid_transaction_ids"] != desc(before, 3)
    assert new_plan["full_chain"][0]["active_attempt_number"] == 1
    assert new_plan["full_chain"][1]["active_attempt_number"] == 2
    assert new_plan["full_chain"][1]["original_billing_ndc"] == "60000-4444-01"
    assert new_plan["full_chain"][1]["current_billing_ndc"] == "60000-4444-02"
    assert new_plan["upstream_positions_unchanged"] == [1, 2]
    action.correct(a["PHARMACIST"], fill,
        "Second simulated correction replays tertiary and fourth payers",
        target_position=3, expected_active_paid_transaction_ids=new_plan[
            "expected_active_paid_transaction_ids"],
        corrected_billing_ndc="60000-4444-02")
    final = registry.history(a["AUDITOR"], fill)
    plan = planner.plan(a["PHARMACIST"], fill, target_position=2)
    assert plan["reverse_transaction_ids"] == desc(final, 2)
    assert [x["active_attempt_number"] for x in plan["full_chain"]] == [1, 2, 3, 3]
    assert [x["position"] for x in plan["full_chain"]] == [1, 2, 3, 4]
    assert planner.plan(a["AUDITOR"], fill, target_position=4)[
        "reverse_positions"] == [4]
    assert registry.history(a["AUDITOR"], fill) == final  # strict read-only


def test_reconciled_fill_claim_review_displays_current_not_original_billed_ndc(case):
    from pharmacy1os.fill_claim_review import FillClaimReview
    svc, a, out, rx, fill, stocks, exp = case
    before = prepare(case, 3)
    subject = FillClaimReview(svc)
    initial = subject.detail(a["AUDITOR"], fill)
    assert [x["selected_ndc"] for x in initial["claims"]] == ["60000-4444-01"] * 3
    correct = SyntheticCobCorrectionService(svc)
    report = correct.correct(a["PHARMACIST"], fill,
        "Documented local synthetic secondary payer NDC correction for audit",
        target_position=2, expected_active_paid_transaction_ids=desc(before, 2),
        corrected_billing_ndc="60000-4444-02")
    after = subject.detail(a["AUDITOR"], fill)
    claims = after["claims"]
    assert [x["selected_ndc"] for x in claims] == [
        "60000-4444-01", "60000-4444-02", "60000-4444-01"]
    assert [x["original_selected_ndc"] for x in claims] == ["60000-4444-01"] * 3
    assert [x["active_attempt_number"] for x in claims] == [1, 2, 2]
    assert [len(x["attempt_history"]) for x in claims] == [1, 2, 2]
    assert [x["current_paid_transaction_id"] for x in claims[1:]] == report[
        "new_paid_transaction_ids"]
    assert all(x["original_claim_operation_snapshot_only"] for x in claims)
    assert after["versioned_cob"] == {
        "total_attempts": 5, "active_local_paid_positions": 3,
        "external_payer_contact": False}
    assert [len(x["claim_transactions"]) for x in claims] == [1, 3, 3]
    assert [label["ndc"] for label in after["labels"]] == [
        label["ndc"] for label in initial["labels"]]
    assert len(BillingService(svc).history(a["AUDITOR"], fill)) == 3
    assert after["warnings"]
    assert subject.detail(a["AUDITOR"], fill) == after


def test_versioned_correction_preflight_remains_site_scoped_and_excludes_printed_labels(case):
    from pharmacy1os.cob_correction_plan import CobCorrectionPlanner
    svc, a, out, rx, fill, stocks, exp = case
    history = prepare(case, 2)
    planner = CobCorrectionPlanner(svc)
    with pytest.raises(WorkflowError, match="pharmacy site"):
        planner.plan(out["AUDITOR"], fill, target_position=1)
    job = LabelPrintService(svc).list(a["PHARMACIST"], fill)[0]
    LabelPrintService(svc).record_output_attempt(
        a["PHARMACIST"], job["id"], "VERSIONED-PREFLIGHT-PRINT-TEST",
        "A mock label output attempt occurred before proposed correction",
        dialog_accepted=True)
    with pytest.raises(WorkflowError, match="Previously printed"):
        planner.plan(a["AUDITOR"], fill, target_position=1)
    # Test print attempts never change the underlying immutable payer ledger.
    assert CobAttemptRegistry(svc).history(a["AUDITOR"], fill) == history


def test_versioned_correction_api_preflight_and_fill_detail_are_read_only(case):
    from pharmacy1os.cob_correction_plan import CobCorrectionPlanner
    svc, a, out, rx, fill, stocks, exp = case
    before = prepare(case, 2)
    corrected = SyntheticCobCorrectionService(svc).correct(
        a["PHARMACIST"], fill,
        "Prepare versioned current payer information without modifying it",
        target_position=2, expected_active_paid_transaction_ids=desc(before, 2),
        corrected_billing_ndc="60000-4444-02")
    app = TestClient(create_app(svc, synthetic_enabled=True))
    header = {"x-demo-staff-id": a["AUDITOR"].id}
    result = app.get(f"/api/third-party/fills/{fill}/cob-correction-plan?target_position=2",
                     headers=header)
    assert result.status_code == 200, result.text
    assert result.json()["action_enabled"] is True
    assert result.json()["reverse_transaction_ids"] == corrected["new_paid_transaction_ids"]
    claims = app.get(f"/api/fills/{fill}/claims", headers=header)
    assert claims.status_code == 200, claims.text
    assert claims.json()["claims"][1]["selected_ndc"] == "60000-4444-02"
    assert claims.json()["claims"][1]["original_selected_ndc"] == "60000-4444-01"
    denied = app.get(f"/api/fills/{fill}/claims",
        headers={"x-demo-staff-id": out["AUDITOR"].id})
    assert denied.status_code == 409


def test_increment_52_reverses_latest_corrected_four_payer_chain_and_preserves_all_attempts(case):
    from pharmacy1os.claim_rebilling import ClaimRebillService, SyntheticRebillLink
    svc, a, out, rx, fill, stocks, exp = case
    start = prepare(case)
    correct = SyntheticCobCorrectionService(svc)
    first = correct.correct(a["PHARMACIST"], fill,
        "Document first mock primary source NDC change with all dependent COB payers",
        target_position=1,
        expected_active_paid_transaction_ids=desc(start, 1),
        corrected_billing_ndc="60000-4444-02")
    second_history = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    correct.correct(a["PHARMACIST"], fill,
        "Correct third position a second time before locally reversing full chain",
        target_position=3,
        expected_active_paid_transaction_ids=desc(second_history, 3),
        corrected_billing_ndc="60000-4444-01")
    before = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    ids = desc(before, 1)
    assert [len(x["attempts"]) for x in before["claim_positions"]] == [2, 2, 3, 3]
    with svc.sessions() as s:
        original_stock = {p.id:(p.on_hand,p.reserved)
                          for p in s.scalars(select(Stock).where(Stock.id.in_(stocks)))}
    result = ClaimRebillService(svc).reverse_current_cob(a["PHARMACIST"], fill,
        "Pharmacist retires all latest corrected mock claims before a physical refill",
        expected_active_paid_transaction_ids=ids)
    assert result["coverage_positions_reversed"] == [4, 3, 2, 1]
    assert result["original_active_paid_transaction_ids"] == ids
    assert len(result["reversal_transaction_ids"]) == 4
    assert result["replayed"] is False
    assert result["requires_fresh_scans"] is True
    assert not result["external_payer_contact"]
    final = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    assert final["total_attempts"] == 10
    assert final["active_local_paid_positions"] == 0
    assert [len(x["attempts"]) for x in final["claim_positions"]] == [2, 2, 3, 3]
    assert [x["attempts"][-1]["paid_transaction_id"] for x in reversed(final["claim_positions"])] == ids
    assert [x["attempts"][-1]["reversal_transaction_id"]
            for x in reversed(final["claim_positions"])] == result["reversal_transaction_ids"]
    all_events = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    assert len([x for x in all_events if x["operation"] == "REVERSE"]) == 10
    assert len([x for x in all_events if x["operation"] == "BILL"]) == 10
    assert [e["original_transaction_id"] for e in all_events
            if e["id"] in result["reversal_transaction_ids"]] == ids
    labels = LabelPrintService(svc).list(a["PHARMACIST"], fill)
    assert labels and all(x["status"] == "VOIDED" for x in labels)
    assert len(BillingService(svc).history(a["AUDITOR"], fill)) == 8
    with svc.sessions() as s:
        for p in s.scalars(select(Stock).where(Stock.id.in_(stocks))):
            assert p.on_hand == original_stock[p.id][0]
            assert p.reserved == 0
        assert s.get(Fill, fill).status == "RETURNED"
        assert s.get(Fill, result["replacement_fill_id"]).status == "PRODUCT_FILL"
        assert s.scalars(select(Claim).where(
            Claim.fill_id == result["replacement_fill_id"])).all() == []
        assert len(s.scalars(select(SyntheticRebillLink).where(
            SyntheticRebillLink.original_fill_id == fill)).all()) == 1
    again = ClaimRebillService(svc).reverse_current_cob(a["PHARMACIST"], fill,
        "Identical caller retry should not release stock or create a second replacement",
        expected_active_paid_transaction_ids=ids)
    assert again["replayed"] is True
    assert again["reversal_transaction_ids"] == result["reversal_transaction_ids"]
    assert again["replacement_fill_id"] == result["replacement_fill_id"]
    # Replacement is still a completely fresh scan and payer workflow.
    replacement = result["replacement_fill_id"]
    assert svc.scanned_sources(a["TECHNICIAN"], replacement) == []
    svc.scan_source(a["TECHNICIAN"], replacement,
        "CORRECT-SCAN-1", "CORRECT-LOT-1", exp, "60")
    svc.prepare_for_review(a["TECHNICIAN"], replacement, ["Primary Mock", "Secondary Mock"])
    svc.verify(a["PHARMACIST"], replacement)
    replay = ClaimRebillService(svc).reverse_current_cob(a["PHARMACIST"], fill,
        "Historical replay after a later successful replacement verification",
        expected_active_paid_transaction_ids=ids)
    assert replay["replayed"] is True and replay["requires_fresh_scans"] is False


def test_increment_52_stale_order_role_site_and_printed_labels_rejected(case):
    from pharmacy1os.claim_rebilling import ClaimRebillService
    svc, a, out, rx, fill, stocks, exp = case
    original = prepare(case, 3)
    SyntheticCobCorrectionService(svc).correct(a["PHARMACIST"], fill,
        "Selective synthetic tertiary correction without physical inventory movement",
        target_position=3, expected_active_paid_transaction_ids=desc(original,3),
        corrected_billing_ndc="60000-4444-02")
    recent = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    ids = desc(recent,1)
    reversal = ClaimRebillService(svc)
    note = "Pharmacist attests all currently active local payer versions need rescan"
    with pytest.raises(AccessDenied):
        reversal.reverse_current_cob(a["TECHNICIAN"], fill, note,
            expected_active_paid_transaction_ids=ids)
    with pytest.raises(WorkflowError, match="outside"):
        reversal.reverse_current_cob(out["PHARMACIST"], fill, note,
            expected_active_paid_transaction_ids=ids)
    for bad in (ids[::-1], ids[1:], [ids[0],ids[0],ids[2]], [ids[0],ids[1],"fake"]):
        with pytest.raises(WorkflowError):
            reversal.reverse_current_cob(a["PHARMACIST"], fill, note,
                expected_active_paid_transaction_ids=bad)
    # Original attempt ID may never be substituted for the current active ID.
    stale = list(ids)
    stale[0] = recent["claim_positions"][-1]["attempts"][0]["paid_transaction_id"]
    with pytest.raises(WorkflowError, match="changed"):
        reversal.reverse_current_cob(a["PHARMACIST"], fill, note,
            expected_active_paid_transaction_ids=stale)
    job = LabelPrintService(svc).list(a["PHARMACIST"], fill)[0]
    LabelPrintService(svc).record_output_attempt(a["PHARMACIST"], job["id"],
        "INC52-CORRECTED-PRINT-1", "Synthetic label dialog acceptance blocks reopening",
        dialog_accepted=True)
    with pytest.raises(WorkflowError, match="printed test labels"):
        reversal.reverse_current_cob(a["PHARMACIST"], fill, note,
            expected_active_paid_transaction_ids=ids)
    assert CobAttemptRegistry(svc).history(a["AUDITOR"], fill)["active_local_paid_positions"] == 3
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert sum(x.reserved for x in s.scalars(select(Stock).where(
            Stock.id.in_(stocks)))) == Decimal("60")


def test_increment_52_final_current_reverse_is_fully_atomic_on_new_attempt_failure(case):
    from pharmacy1os.claim_rebilling import ClaimRebillService, SyntheticRebillLink
    svc, a, out, rx, fill, stocks, exp = case
    original = prepare(case,3)
    SyntheticCobCorrectionService(svc).correct(a["PHARMACIST"], fill,
        "Version two secondary test billing source corrected before final reverse",
        target_position=2, expected_active_paid_transaction_ids=desc(original,2),
        corrected_billing_ndc="60000-4444-02")
    old = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    events = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    ids = desc(old,1)
    with patch.object(svc, "_start_fill_tx", side_effect=WorkflowError(
        "Simulated fresh fill start error after local corrected payer reversals")):
        with pytest.raises(WorkflowError, match="Simulated fresh fill"):
            ClaimRebillService(svc).reverse_current_cob(a["PHARMACIST"], fill,
                "All or nothing rollback on simulated replacement start failure",
                expected_active_paid_transaction_ids=ids)
    assert CobAttemptRegistry(svc).history(a["AUDITOR"], fill) == old
    assert SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill) == events
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert sum(x.reserved for x in s.scalars(select(Stock).where(
            Stock.id.in_(stocks)))) == Decimal("60")
        assert s.scalars(select(SyntheticRebillLink)).all() == []


def test_increment_52_api_requires_demo_pharmacist_and_exact_active_positions(case):
    from pharmacy1os.api import create_app
    from fastapi.testclient import TestClient
    svc, a, out, rx, fill, stocks, exp = case
    first = prepare(case,2)
    correction = SyntheticCobCorrectionService(svc)
    correction.correct(a["PHARMACIST"], fill,
        "Correction to physical split manufacturer before final COB retirement",
        target_position=2, expected_active_paid_transaction_ids=desc(first,2),
        corrected_billing_ndc="60000-4444-02")
    ids = desc(CobAttemptRegistry(svc).history(a["AUDITOR"],fill),1)
    payload = {
        "reason": "Pharmacist restart for new synthetic fill after adjusted payer NDC",
        "expected_active_paid_transaction_ids": ids,
    }
    path = f"/api/third-party/fills/{fill}/reverse-current-cob"
    on = TestClient(create_app(svc, synthetic_enabled=True))
    off = TestClient(create_app(svc, synthetic_enabled=False))
    pharm = {"x-demo-staff-id":a["PHARMACIST"].id}
    assert off.post(path,json=payload,headers=pharm).status_code == 503
    assert on.post(path,json=payload).status_code == 403
    assert on.post(path,json=payload,headers={"x-demo-staff-id":a["TECHNICIAN"].id}).status_code == 403
    assert on.post(path,json={**payload,"expected_active_paid_transaction_ids":ids[:1]},
                   headers=pharm).status_code == 422
    first_result = on.post(path,json=payload,headers=pharm)
    assert first_result.status_code == 200, first_result.text
    assert first_result.json()["replayed"] is False
    second = on.post(path,json=payload,headers=pharm)
    assert second.status_code == 200
    assert second.json()["replayed"] is True
    assert second.json()["replacement_fill_id"] == first_result.json()["replacement_fill_id"]
