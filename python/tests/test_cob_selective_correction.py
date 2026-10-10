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
