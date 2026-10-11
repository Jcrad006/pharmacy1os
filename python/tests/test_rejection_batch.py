"""Increment 55: two mock holds must be atomically resolved/retried as one COB fill."""
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.models import Claim, Fill, Label, Stock
from pharmacy1os.rejection_batch import RejectionBatchService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def demo():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    pat = svc.add_patient(tech, "Batch", "TestPatient")
    doc = svc.add_prescriber(tech, "Batch", "Doctor", "MD")
    drug = svc.add_drug(pharm, "Batch synthetic tablets", "10mg", "tablet")
    product = svc.add_product(pharm, drug, "71012-1020-11", "Demo", "Mock white tablets")
    svc.register_barcode(tech, product, "BATCH-TEST-SCAN")
    expiry = (date.today() + timedelta(days=200)).isoformat()
    stock = svc.receive(tech, "BATCH-TEST-SCAN", "BATCH-TEST-LOT", expiry, "120")
    rx = svc.add_prescription(tech, pat, doc, drug,
        "TEST-BATCH-55", "one daily", "50")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, days_supply=50)
    svc.scan_source(tech, fill, "BATCH-TEST-SCAN", "BATCH-TEST-LOT", expiry, "50")
    insurance = InsuranceDirectory(svc)
    p1 = insurance.create_payer(pharm, "Batch Primary")
    p2 = insurance.create_payer(pharm, "Batch Secondary")
    p3 = insurance.create_payer(pharm, "Batch Tertiary")
    coverages = [
        insurance.upsert_coverage(pharm, pat, 1, p1, "SYN-SECRET-PRIMARY"),
        insurance.upsert_coverage(pharm, pat, 2, p2, "SYN-SECRET-SECONDARY"),
        insurance.upsert_coverage(pharm, pat, 3, p3, "SYN-SECRET-TERTIARY"),
    ]
    service = SandboxClaimService(svc)
    rejection_ids = [
        service.inject_rejection(pharm, fill, coverages[0], "TEST_75",
            "BATCH-TEST-REJ-PRIMARY", "Synthetic test authorization denied deliberately"),
        service.inject_rejection(pharm, fill, coverages[2], "TEST_79",
            "BATCH-TEST-REJ-TERTIARY", "Synthetic test refill is too soon deliberately"),
    ]
    return svc, actors, outside, fill, stock, coverages, rejection_ids, service


def resolved(demo):
    svc, actors, outside, fill, stock, cov, ids, service = demo
    ph = actors["PHARMACIST"]
    return [{
        "rejection_id": rid,
        "expected_resolution_id": service.resolve_rejection(ph, rid,
            "Pharmacist reviewed and resolved this mock payer rejection")
    } for rid in ids]


def batch(demo, pairs, *, reason="Batch pharmacist corrected both local fake insurance holds"):
    svc, actors, outside, fill, stock, coverage, ids, service = demo
    return RejectionBatchService(svc).retry(actors["PHARMACIST"], fill,
        rejections=pairs, coverage_ids=coverage, reason=reason)


def test_two_resolved_holds_require_atomic_batch_and_preserve_all_ancestry(demo):
    svc, actors, outside, fill, stock, cov, rejection_ids, ledger = demo
    ph, tech = actors["PHARMACIST"], actors["TECHNICIAN"]
    pairs = resolved(demo)
    with pytest.raises(WorkflowError, match="own pharmacist resolution and retry"):
        svc.prepare_for_review(tech, fill, [], coverage_ids=cov)
    with pytest.raises(WorkflowError, match="Multiple test rejections"):
        ledger.retry_cleared_rejection(ph, rejection_ids[0],
            expected_resolution_id=pairs[0]["expected_resolution_id"],
            coverage_ids=cov, reason="Single retry must not bypass second cleared rejection")
    result = batch(demo, pairs)
    assert result["replayed"] is False and result["synthetic_only"] is True
    assert result["external_submission"] is False
    assert len(result["retry_transaction_ids"]) == 2
    assert len(result["claim_ids"]) == 3 and len(result["labels"]) == 1
    assert result["fill_status"] == "PHARMACIST_REVIEW"
    queue = ledger.rejection_queue(actors["AUDITOR"])
    assert {r["status"] for r in queue} == {"RETRY_PREPARED_SYNTHETIC"}
    events = ledger.list_for_fill(actors["AUDITOR"], fill)
    assert len([x for x in events if x["operation"] == "TEST_RETRY"]) == 2
    assert len([x for x in events if x["operation"] == "BILL"]) == 3
    for retry_id, pair in zip(result["retry_transaction_ids"], pairs):
        event = next(x for x in events if x["id"] == retry_id)
        assert event["request"]["original_rejection_id"] == pair["rejection_id"]
        assert event["request"]["resolution_id"] == pair["expected_resolution_id"]
        assert event["request"]["coverage_ids"] == cov
        assert event["request"]["batch_key"] == result["batch_key"]
    assert "SYN-SECRET-" not in str(events)
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == Decimal("50")
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
    svc.verify(ph, fill)
    assert batch(demo, pairs)["replayed"] is True


def test_duplicate_partial_and_out_of_order_requests_fail_without_mutation(demo):
    svc, actors, outside, fill, stock, cov, rejects, ledger = demo
    pairs = resolved(demo)
    ph = actors["PHARMACIST"]
    with pytest.raises(WorkflowError, match="every rejection"):
        RejectionBatchService(svc).retry(ph, fill,
            rejections=pairs[:1] + [{"rejection_id": "fake-other",
                                     "expected_resolution_id": pairs[1]["expected_resolution_id"]}],
            coverage_ids=cov, reason="Batch list is inconsistent and must not submit")
    with pytest.raises(WorkflowError, match="increasing COB"):
        batch(demo, list(reversed(pairs)))
    with pytest.raises(WorkflowError, match="resolution ID"):
        batch(demo, [{**pairs[0], "expected_resolution_id": "wrong"}, pairs[1]])
    with pytest.raises(WorkflowError, match="coverage"):
        RejectionBatchService(svc).retry(ph, fill, rejections=pairs,
            coverage_ids=[cov[0], cov[1]],
            reason="Missing rejected tertiary coverage must block this batch")
    with pytest.raises(AccessDenied):
        RejectionBatchService(svc).retry(actors["TECHNICIAN"], fill,
            rejections=pairs, coverage_ids=cov,
            reason="Technician cannot authorize payer rejection retry")
    with pytest.raises(WorkflowError, match="pharmacy site"):
        RejectionBatchService(svc).retry(outside["PHARMACIST"], fill,
            rejections=pairs, coverage_ids=cov,
            reason="Cross site reject retry is not permitted")
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == 50
        assert s.get(Fill, fill).status == "PRODUCT_FILL"
        assert s.scalars(select(Claim)).all() == []
        assert s.scalars(select(Label)).all() == []
        assert not s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "TEST_RETRY")).all()


def test_failed_batch_rolls_back_all_retry_events_and_payer_claims(demo):
    svc, actors, outside, fill, stock, cov, rejects, ledger = demo
    pairs = resolved(demo)
    with patch.object(svc, "_prepare_for_review_tx",
                      side_effect=WorkflowError("Mock claim adapter crash")):
        with pytest.raises(WorkflowError, match="Mock claim adapter crash"):
            batch(demo, pairs)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PRODUCT_FILL"
        assert not s.scalars(select(Claim)).all()
        assert not s.scalars(select(Label)).all()
        assert s.get(Stock, stock).reserved == 50
        assert not s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "TEST_RETRY")).all()
    success = batch(demo, pairs)
    assert len(success["claim_ids"]) == 3


def test_replay_rejects_different_reason_or_changed_resolution(demo):
    svc, actors, outside, fill, stock, cov, rejects, ledger = demo
    pairs = resolved(demo)
    first = batch(demo, pairs)
    replay = batch(demo, pairs)
    assert replay["replayed"] is True
    assert replay["retry_transaction_ids"] == first["retry_transaction_ids"]
    with pytest.raises(WorkflowError, match="differs from committed"):
        batch(demo, pairs, reason="An entirely different simulated test retry rationale")
    with pytest.raises(WorkflowError, match="resolution ID"):
        batch(demo, [{**pairs[0], "expected_resolution_id": "stale"}, pairs[1]])
    with svc.sessions() as s:
        assert len(s.scalars(select(Claim)).all()) == 3
        assert len(s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "TEST_RETRY")).all()) == 2


def test_corrupt_resolution_response_fails_closed_before_retry(demo):
    svc, actors, outside, fill, stock, cov, rejects, ledger = demo
    pairs = resolved(demo)
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, pairs[1]["expected_resolution_id"]).response_json = (
            '{"outcome":"CLEARED_TEST_HOLD","message":"fabricated"}')
    with pytest.raises(WorkflowError, match="integrity"):
        batch(demo, pairs)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PRODUCT_FILL"
        assert not s.scalars(select(Claim)).all()
        assert not s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "TEST_RETRY")).all()


def test_http_batch_api_synthetic_gate_roles_and_validation(demo):
    svc, actors, outside, fill, stock, cov, rejects, ledger = demo
    pairs = resolved(demo)
    yes = TestClient(create_app(svc, synthetic_enabled=True))
    no = TestClient(create_app(svc, synthetic_enabled=False))
    url = "/api/third-party/test-rejections/retry-batch"
    payload = {"fill_id": fill, "rejections": pairs,
               "coverage_ids": cov,
               "reason": "Pharmacist retries every cleared mock test hold"}
    ph = {"x-demo-staff-id": actors["PHARMACIST"].id}
    assert no.post(url, headers=ph, json=payload).status_code == 503
    assert yes.post(url, json=payload).status_code == 403
    assert yes.post(url, headers={"x-demo-staff-id": actors["TECHNICIAN"].id},
                    json=payload).status_code == 403
    assert yes.post(url, headers=ph,
        json={**payload, "rejections": pairs[:1]}).status_code == 422
    answer = yes.post(url, headers=ph, json=payload)
    assert answer.status_code == 200, answer.text
    assert len(answer.json()["retry_transaction_ids"]) == 2
    assert yes.post(url, headers=ph, json=payload).json()["replayed"] is True
