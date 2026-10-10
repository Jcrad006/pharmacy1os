"""Atomic reverse-COB transaction orchestration (synthetic, never real payer)."""
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.billing import BillingService
from pharmacy1os.claim_rebilling import ClaimRebillService, SyntheticRebillLink
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.label_printing import LabelPrintService
from pharmacy1os.models import Claim, Fill, Label, Prescription, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    drug = svc.add_drug(pharm, "COB synthetic source audit", "5mg", "tablet")
    prod = svc.add_product(pharm, drug, "60011-2222-55", "Synthetic", "Local test tablets")
    svc.register_barcode(tech, prod, "COB-REVERSE-SCAN")
    expiry = (date.today() + timedelta(days=350)).isoformat()
    stock = svc.receive(tech, "COB-REVERSE-SCAN", "COB-LOT-ONE", expiry, "200")
    patient = svc.add_patient(tech, "Synthetic", "FourPayer")
    prescriber = svc.add_prescriber(tech, "Synthetic", "Physician", "MD")
    rx = svc.add_prescription(tech, patient, prescriber, drug,
        "TEST-FOUR-PAYER-COB", "Take one each morning", "90")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, days_supply=90)
    svc.scan_source(tech, fill, "COB-REVERSE-SCAN", "COB-LOT-ONE", expiry, "90")
    return svc, actors, outside, patient, rx, fill, stock, expiry


def _prepare(case, count=4, *, use_coverages=False):
    svc, a, outside, patient, rx, fill, stock, expiry = case
    names = ["Primary Plan", "Secondary Plan", "Tertiary Plan", "Fourth Plan"][:count]
    coverages = None
    if use_coverages:
        db = InsuranceDirectory(svc)
        coverages = []
        for position, name in enumerate(names, 1):
            payer = db.create_payer(a["PHARMACIST"], name)
            coverages.append(db.upsert_coverage(a["PHARMACIST"], patient,
                position, payer, f"LOCAL-NONREAL-MEMBER-{position}-4321"))
        svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=coverages)
    else:
        svc.prepare_for_review(a["TECHNICIAN"], fill, names)
    bills = [item for item in SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
             if item["operation"] == "BILL"]
    assert len(bills) == count
    assert [b["request"]["coverage_position"] for b in bills] == list(range(1, count+1))
    return bills, coverages


def test_four_way_cob_reverses_downstream_first_then_requires_new_preparation(case):
    svc, a, outside, patient, rx, fill, stock, expiry = case
    bills, coverage_ids = _prepare(case, use_coverages=True)
    ids = [row["id"] for row in reversed(bills)]
    result = ClaimRebillService(svc).reverse_cob_transactions(a["PHARMACIST"], fill,
        "Pharmacist found synthetic NDC discrepancy before independent verification",
        expected_paid_transaction_ids=ids)
    replacement = result["replacement_fill_id"]
    assert result["coverage_positions_reversed"] == [4, 3, 2, 1]
    assert result["original_paid_transaction_ids"] == ids
    assert len(result["reversal_transaction_ids"]) == 4
    assert result["replayed"] is False and result["requires_fresh_scans"] is True
    assert result["external_payer_contact"] is False
    assert result["payer_intended_quantity"] == "90.000"
    txs = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    reverse_events = [t for t in txs if t["operation"] == "REVERSE"]
    assert [tx["original_transaction_id"] for tx in reverse_events] == ids
    assert [tx["id"] for tx in reverse_events] == result["reversal_transaction_ids"]
    assert [b["outcome"] for b in reverse_events] == ["REVERSED_SYNTHETIC"] * 4
    assert all(t["response"].get("transaction_reference") is None for t in reverse_events)
    assert [j["status"] for j in LabelPrintService(svc).list(
        a["TECHNICIAN"], fill)] == ["VOIDED"]
    assert len(BillingService(svc).history(a["AUDITOR"], fill)) == 8
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "RETURNED"
        assert s.get(Fill, replacement).status == "PRODUCT_FILL"
        assert s.get(Stock, stock).reserved == Decimal("0")
        assert all(c.status == "REVERSED_SYNTHETIC" for c in s.scalars(
            select(Claim).where(Claim.fill_id == fill)))
        assert s.scalars(select(Claim).where(Claim.fill_id == replacement)).all() == []
        assert s.scalars(select(Label).where(Label.fill_id == replacement)).all() == []
    svc.scan_source(a["TECHNICIAN"], replacement,
        "COB-REVERSE-SCAN", "COB-LOT-ONE", expiry, "90")
    svc.prepare_for_review(a["TECHNICIAN"], replacement, [], coverage_ids=coverage_ids)
    svc.verify(a["PHARMACIST"], replacement)
    assert len(BillingService(svc).history(a["AUDITOR"], replacement)) == 4
    # Original payer snapshots are immutable and remain tied to the retired fill.
    assert [t["original_transaction_id"] for t in SandboxClaimService(svc).list_for_fill(
        a["AUDITOR"], fill) if t["operation"] == "REVERSE"] == ids


def test_replay_of_complete_two_payer_chain_is_read_only_even_after_rescan(case):
    svc, a, outside, patient, rx, fill, stock, exp = case
    bills, _ = _prepare(case, 2)
    desc = [bill["id"] for bill in reversed(bills)]
    work = ClaimRebillService(svc)
    first = work.reverse_cob_transactions(a["PHARMACIST"], fill,
        "Correct one incorrect source across two simulated insurance payers",
        expected_paid_transaction_ids=desc)
    second = work.reverse_cob_transactions(a["PHARMACIST"], fill,
        "Idempotent retry of already completed local COB reversal",
        expected_paid_transaction_ids=desc)
    assert second["replayed"] is True
    assert second["reversal_transaction_ids"] == first["reversal_transaction_ids"]
    assert second["replacement_fill_id"] == first["replacement_fill_id"]
    with svc.sessions() as s:
        assert len(s.scalars(select(SyntheticRebillLink)).all()) == 1
        assert len(s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "REVERSE")).all()) == 2
        assert s.get(Stock, stock).reserved == 0
    fresh = first["replacement_fill_id"]
    svc.scan_source(a["TECHNICIAN"], fresh,
        "COB-REVERSE-SCAN", "COB-LOT-ONE", exp, "90")
    svc.prepare_for_review(a["TECHNICIAN"], fresh, ["Primary Plan", "Secondary Plan"])
    svc.verify(a["PHARMACIST"], fresh)
    third = work.reverse_cob_transactions(a["PHARMACIST"], fill,
        "Check immutable historical original after replacement verification",
        expected_paid_transaction_ids=desc)
    assert third["replayed"] is True and third["requires_fresh_scans"] is False


def test_claim_id_or_paid_transaction_order_mismatch_never_changes_any_claim(case):
    svc, a, outside, patient, rx, fill, stock, exp = case
    bills, _ = _prepare(case, 3)
    ids = [b["id"] for b in reversed(bills)]
    subject = ClaimRebillService(svc)
    note = "Pharmacist reviewed full mock COB reversal; do not reverse incomplete lists"
    for incorrect in (
        list(reversed(ids)), ids[:2], [ids[0], ids[0], ids[2]],
        [ids[0], ids[2], ids[1]], ids + ["unknown"],
    ):
        with pytest.raises(WorkflowError):
            subject.reverse_cob_transactions(a["PHARMACIST"], fill, note,
                expected_paid_transaction_ids=incorrect)
    with pytest.raises(WorkflowError, match="two to four"):
        subject.reverse_cob_transactions(a["PHARMACIST"], fill, note,
            expected_paid_transaction_ids=[ids[0]])
    with pytest.raises(AccessDenied):
        subject.reverse_cob_transactions(a["TECHNICIAN"], fill, note,
            expected_paid_transaction_ids=ids)
    with pytest.raises(WorkflowError, match="outside"):
        subject.reverse_cob_transactions(outside["PHARMACIST"], fill, note,
            expected_paid_transaction_ids=ids)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.get(Stock, stock).reserved == 90
        assert all(c.status == "PAID_SYNTHETIC" for c in s.scalars(select(Claim)))
        assert s.scalars(select(SyntheticRebillLink)).all() == []
        assert s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "REVERSE")).all() == []


def test_post_print_reversal_blocked_and_original_paid_transaction_integrity_required(case):
    svc, a, outside, patient, rx, fill, stock, exp = case
    bills, _ = _prepare(case, 2)
    ids = [b["id"] for b in reversed(bills)]
    first_job = LabelPrintService(svc).list(a["PHARMACIST"], fill)[0]
    LabelPrintService(svc).record_output_attempt(
        a["PHARMACIST"], first_job["id"], "FULL-COB-TEST-PRINT",
        "Local simulated label accepted by OS print dialog",
        dialog_accepted=True)
    with pytest.raises(WorkflowError, match="printed test labels"):
        ClaimRebillService(svc).reverse_cob_transactions(
            a["PHARMACIST"], fill,
            "Previously printed test label requires controlled manual reconciliation",
            expected_paid_transaction_ids=ids)
    with svc.sessions.begin() as s:
        tx = s.get(SandboxClaimTransaction, ids[0])
        tx.request_json = '{"incorrect":"historical payer request was modified"}'
    with pytest.raises(WorkflowError, match="integrity"):
        ClaimRebillService(svc).reverse_cob_transactions(
            a["PHARMACIST"], fill,
            "Tampered original transaction needs manual correction, never silent reversal",
            expected_paid_transaction_ids=ids)
    with svc.sessions() as s:
        assert all(c.status == "PAID_SYNTHETIC" for c in s.scalars(select(Claim)))
        assert s.scalars(select(SyntheticRebillLink)).all() == []


def test_atomic_cob_reversal_rolls_back_all_payers_if_new_fill_fails(case):
    svc, a, outside, patient, rx, fill, stock, exp = case
    bills, _ = _prepare(case, 4)
    ids = [b["id"] for b in reversed(bills)]
    with patch.object(svc, "_start_fill_tx",
        side_effect=WorkflowError("Forced failed replacement after four payer reversals")):
        with pytest.raises(WorkflowError, match="Forced failed replacement"):
            ClaimRebillService(svc).reverse_cob_transactions(
                a["PHARMACIST"], fill,
                "Atomic test failure after all four local payer positions are reversed",
                expected_paid_transaction_ids=ids)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.get(Stock, stock).reserved == 90
        assert all(c.status == "PAID_SYNTHETIC" for c in s.scalars(select(Claim)))
        assert s.scalars(select(SyntheticRebillLink)).all() == []
        assert s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "REVERSE")).all() == []
        assert all(x["status"] == "QUEUED" for x in LabelPrintService(svc).list(
            a["PHARMACIST"], fill))


def test_cob_api_is_synthetic_only_and_requires_pharmacist_role(case):
    svc, a, outside, patient, rx, fill, stock, exp = case
    bills, _ = _prepare(case, 2)
    ids = [b["id"] for b in reversed(bills)]
    enabled = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    endpoint = "/api/third-party/claims/reverse-cob"
    payload = {
        "fill_id": fill,
        "reason": "Reverse whole local claim chain for corrected product source selection",
        "expected_paid_transaction_ids": ids,
    }
    pharmacist = {"x-demo-staff-id": a["PHARMACIST"].id}
    assert disabled.post(endpoint, json=payload, headers=pharmacist).status_code == 503
    assert enabled.post(endpoint, json=payload).status_code == 403
    assert enabled.post(endpoint, json=payload, headers={
        "x-demo-staff-id": a["TECHNICIAN"].id}).status_code == 403
    assert enabled.post(endpoint, json={
        **payload, "expected_paid_transaction_ids": [ids[0]]
    }, headers=pharmacist).status_code == 422
    assert enabled.post(endpoint, json=payload, headers={
        "x-demo-staff-id": outside["PHARMACIST"].id}).status_code == 409
    first = enabled.post(endpoint, json=payload, headers=pharmacist)
    assert first.status_code == 200, first.text
    assert first.json()["coverage_positions_reversed"] == [2, 1]
    replay = enabled.post(endpoint, json=payload, headers=pharmacist)
    assert replay.status_code == 200 and replay.json()["replayed"] is True


def test_legacy_restart_also_records_reversals_in_safe_descending_order(case):
    svc, a, outside, patient, rx, fill, stock, exp = case
    bills, _ = _prepare(case, 3)
    # Existing API expects claim IDs primary->tertiary even though
    # physical reversal events now execute tertiary->primary.
    with svc.sessions() as s:
        claim_ids = [x.id for x in s.scalars(select(Claim).where(
            Claim.fill_id == fill).order_by(Claim.sequence))]
    ClaimRebillService(svc).restart(a["PHARMACIST"], fill,
        "Original whole-fill restart now preserves correct downstream-first order",
        expected_claim_ids=claim_ids)
    events = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    assert [event["original_transaction_id"] for event in events if
            event["operation"] == "REVERSE"] == [x["id"] for x in reversed(bills)]
