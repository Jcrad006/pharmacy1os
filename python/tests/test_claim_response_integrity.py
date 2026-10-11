"""Increment 53: immutable *response* evidence for local mock claims.

Request integrity already existed. These tests prevent silent changes to
synthetic PAID / REVERSED / REJECTED results across APIs and verification.
"""
from datetime import date, timedelta
import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.claim_transactions import SandboxClaimService, _record
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.cob_attempts import CobAttemptRegistry
from pharmacy1os.cob_selective_correction import SyntheticCobCorrectionService
from pharmacy1os.fill_claim_review import FillClaimReview
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.models import Fill, Stock
from pharmacy1os.service import PharmacyService, WorkflowError
from pharmacy1os.third_party_workspace import ThirdPartyWorkspace


@pytest.fixture
def case():
    service = PharmacyService()
    service.create_schema()
    a = service.bootstrap_demo()["actors"]
    external = service.bootstrap_demo()["actors"]
    technician, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    drug = service.add_drug(pharmacist, "Response hash integrity drug", "8 mg", "tablet")
    product = service.add_product(pharmacist, drug, "77665-0001-88", "Test", "Synthetic tab")
    service.register_barcode(technician, product, "RESPONSE-HASH-BC")
    exp = (date.today() + timedelta(days=365)).isoformat()
    stock = service.receive(technician, "RESPONSE-HASH-BC", "RESPONSE-HASH-LOT", exp, "100")
    patient = service.add_patient(technician, "Integrity", "Response")
    provider = service.add_prescriber(technician, "Integrity", "Doctor", "MD")
    rx = service.add_prescription(technician, patient, provider, drug,
        "RESPONSE-HASH-RX", "once per day", "60")
    service.advance_to_dur(technician, rx)
    fill = service.start_fill(technician, rx)
    service.scan_source(technician, fill, "RESPONSE-HASH-BC", "RESPONSE-HASH-LOT", exp, "60")
    return service, a, external, patient, rx, fill, stock


def prepare(case, count=2):
    svc, a, outside, patient, rx, fill, stock = case
    svc.prepare_for_review(a["TECHNICIAN"], fill,
        ["Primary synthetic payer", "Secondary synthetic payer"][:count])
    return [x for x in SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
            if x["operation"] == "BILL"]


def test_paid_transactions_expose_matching_original_response_digest(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = prepare(case)
    for paid in bills:
        digest = hashlib.sha256(json.dumps(
            paid["response"], sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode()).hexdigest()
        assert paid["response_sha256"] == digest
        assert paid["response"]["outcome"] == "PAID_SYNTHETIC"
    assert CobAttemptRegistry(svc).history(a["AUDITOR"], fill)["total_attempts"] == 2


def test_changed_paid_response_blocks_history_ready_and_correction(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = prepare(case)
    original_state = (100, 60)
    with svc.sessions.begin() as s:
        tx = s.get(SandboxClaimTransaction, bills[-1]["id"])
        tx.response_json = '{"outcome":"PAID_SYNTHETIC","amount_paid":"500000"}'
    with pytest.raises(WorkflowError, match="response integrity"):
        SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    with pytest.raises(WorkflowError, match="response integrity"):
        CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    with pytest.raises(WorkflowError, match="response integrity"):
        FillClaimReview(svc).detail(a["AUDITOR"], fill)
    with pytest.raises(WorkflowError, match="response integrity"):
        ThirdPartyWorkspace(svc).snapshot(a["AUDITOR"])
    with pytest.raises(WorkflowError, match="response integrity"):
        svc.verify(a["PHARMACIST"], fill)
    with pytest.raises(WorkflowError, match="response integrity"):
        SyntheticCobCorrectionService(svc).correct(
            a["PHARMACIST"], fill,
            "Reject altered mock payment before any payer or inventory correction",
            target_position=2,
            expected_active_paid_transaction_ids=[bills[-1]["id"]],
            corrected_billing_ndc="77665-0001-88")
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert (s.get(Stock, stock).on_hand, s.get(Stock, stock).reserved) == original_state
        assert s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "REVERSE")).all() == []


def test_response_outcome_mismatch_fails_even_with_matching_new_digest(case):
    svc, a, outside, patient, rx, fill, stock = case
    paid = prepare(case, count=1)[0]
    modified = '{"outcome":"REJECTED_SYNTHETIC"}'
    with svc.sessions.begin() as s:
        tx = s.get(SandboxClaimTransaction, paid["id"])
        tx.response_json = modified
        tx.response_sha256 = hashlib.sha256(modified.encode()).hexdigest()
    with pytest.raises(WorkflowError, match="response outcome integrity"):
        SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)


def test_local_rejection_response_tamper_blocks_queue_resolution_and_workspace(case):
    svc, a, outside, patient, rx, fill, stock = case
    insurance = InsuranceDirectory(svc)
    payer = insurance.create_payer(a["PHARMACIST"], "Test reject hash payer")
    coverage = insurance.upsert_coverage(a["PHARMACIST"], patient, 1, payer,
                                         "SHOULD-STAY-MASKED")
    claims = SandboxClaimService(svc)
    reject_id = claims.inject_rejection(a["PHARMACIST"], fill, coverage,
        "TEST_75", "HASH-REJECT-DEMO", "Local rejection for response integrity")
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, reject_id).response_json = (
            '{"outcome":"REJECTED_SYNTHETIC","reject_codes":["TEST_00"]}')
    with pytest.raises(WorkflowError, match="response integrity"):
        claims.rejection_queue(a["AUDITOR"])
    with pytest.raises(WorkflowError, match="response integrity"):
        claims.resolve_rejection(a["PHARMACIST"], reject_id,
            "Cannot clear an altered local test rejection response")
    with pytest.raises(WorkflowError, match="response integrity"):
        ThirdPartyWorkspace(svc).snapshot(a["AUDITOR"])
    assert ThirdPartyWorkspace(svc).snapshot(outside["AUDITOR"])["claimIssues"] == []


def test_inconsistent_local_adapter_outcome_never_written(case):
    svc, a, outside, patient, rx, fill, stock = case
    with svc.sessions.begin() as s:
        with pytest.raises(WorkflowError, match="does not match"):
            _record(s, a["PHARMACIST"], fill,
                "TEST_RESOLVE", "CLEARED_TEST_HOLD", "test-mismatched-response-check",
                {"audit": "synthetic"}, {"outcome": "REJECTED_SYNTHETIC"})
    with svc.sessions() as s:
        assert s.scalars(select(SandboxClaimTransaction)).all() == []


def test_synthetic_api_history_rejects_modified_response_without_leaking_it(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = prepare(case)
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, bills[0]["id"]).response_json = (
            '{"outcome":"PAID_SYNTHETIC","member_id":"tamper secret"}')
    client = TestClient(create_app(svc, synthetic_enabled=True))
    response = client.get(f"/api/third-party/fills/{fill}/cob-attempts",
        headers={"x-demo-staff-id": a["AUDITOR"].id})
    assert response.status_code == 409
    assert "tamper secret" not in response.text


def test_legitimate_mock_paid_reversal_chain_retains_response_digest(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = prepare(case)
    from pharmacy1os.claim_rebilling import ClaimRebillService
    result = ClaimRebillService(svc).reverse_cob_transactions(
        a["PHARMACIST"], fill,
        "Reverse the whole local test claim chain before pharmacist physical verification",
        expected_paid_transaction_ids=[tx["id"] for tx in reversed(bills)])
    assert not result["external_payer_contact"]
    items = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    assert len(items) == 4
    assert all(len(item["response_sha256"]) == 64 for item in items)
    assert CobAttemptRegistry(svc).history(a["AUDITOR"], fill)[
        "active_local_paid_positions"] == 0


def test_original_response_cannot_be_silently_replaced_after_selective_correction(case):
    svc, a, outside, patient, rx, fill, stock = case
    bills = prepare(case)
    correction = SyntheticCobCorrectionService(svc).correct(
        a["PHARMACIST"], fill,
        "Synthetic corrected payer uses the physically verified test NDC",
        target_position=2,
        expected_active_paid_transaction_ids=[bills[-1]["id"]],
        corrected_billing_ndc="77665-0001-88")
    with svc.sessions.begin() as s:
        tx = s.get(SandboxClaimTransaction, correction["new_paid_transaction_ids"][0])
        tx.response_json = '{"outcome":"PAID_SYNTHETIC","authorization_number":"FAKE"}'
    with pytest.raises(WorkflowError, match="response integrity"):
        CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    with pytest.raises(WorkflowError, match="response integrity"):
        svc.verify(a["PHARMACIST"], fill)
