"""Explicit pharmacist replay of a corrected, synthetic-only rejection."""
from datetime import date, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.models import Claim, Fill, Label, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def demo():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "RetryCase")
    provider = svc.add_prescriber(tech, "Synthetic", "Provider", "MD")
    drug = svc.add_drug(pharm, "Simulated retry medication", "10 mg", "tablet")
    prod = svc.add_product(pharm, drug, "66110-8888-11", "Demo", "Synthetic tabs")
    svc.register_barcode(tech, prod, "RETRY-TEST-BAR")
    expiry = (date.today() + timedelta(days=200)).isoformat()
    svc.receive(tech, "RETRY-TEST-BAR", "SYN-RETRY-LOT", expiry, "120")
    rx = svc.add_prescription(tech, patient, provider, drug,
        "SYN-RX-RETRY", "Take one daily", "90")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, "60", days_supply=30)
    svc.scan_source(tech, fill, "RETRY-TEST-BAR", "SYN-RETRY-LOT", expiry, "60")
    ins = InsuranceDirectory(svc)
    payer1 = ins.create_payer(pharm, "Test primary")
    payer2 = ins.create_payer(pharm, "Test secondary")
    cov1 = ins.upsert_coverage(pharm, patient, 1, payer1, "DO-NOT-SEND-MEMBER-9911")
    cov2 = ins.upsert_coverage(pharm, patient, 2, payer2, "DO-NOT-SEND-MEMBER-2222")
    claims = SandboxClaimService(svc)
    rejected = claims.inject_rejection(pharm, fill, cov1, "TEST_75",
        "RETRY-INJECT-ONE", "Local test pharmacy rejection requires resolution")
    return svc, a, other, patient, fill, (cov1, cov2), rejected, claims, expiry


def _clear(demo):
    svc, a, other, patient, fill, coverage, rejection, ledger, expiry = demo
    return ledger.resolve_rejection(a["PHARMACIST"], rejection,
        "Reviewed simulated rejection and documented missing mock prior authorization")


def test_explicit_retry_records_lineage_and_prepares_full_cob_atomically(demo):
    svc, a, outside, patient, fill, coverage, original, ledger, expiry = demo
    with pytest.raises(WorkflowError, match="Open synthetic insurance rejection"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=list(coverage))
    resolution = _clear(demo)
    retry = ledger.retry_cleared_rejection(a["PHARMACIST"], original,
        expected_resolution_id=resolution, coverage_ids=list(coverage),
        reason="Corrected mock insurance rule after pharmacist review")
    assert retry["original_rejection_id"] == original
    assert retry["resolution_id"] == resolution
    assert len(retry["labels"]) == 1
    assert len(retry["claim_ids"]) == 2
    assert retry["requires_pharmacist_verification"] is True
    assert retry["external_submission"] is False
    assert ledger.rejection_queue(a["AUDITOR"])[0]["status"] == "RETRY_PREPARED_SYNTHETIC"
    events = ledger.list_for_fill(a["AUDITOR"], fill)
    assert [x["operation"] for x in events] == [
        "TEST_REJECT", "TEST_RESOLVE", "TEST_RETRY", "BILL", "BILL"]
    assert events[2]["original_transaction_id"] == original
    assert events[2]["request"]["resolution_id"] == resolution
    assert events[2]["request"]["coverage_ids"] == list(coverage)
    assert "DO-NOT-SEND-MEMBER" not in str(events)
    assert all(ev["response"]["authorization_number"] is None
               for ev in events if ev["operation"] == "BILL")
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert len(s.scalars(select(Claim).where(Claim.fill_id == fill)).all()) == 2
        assert len(s.scalars(select(Label).where(Label.fill_id == fill)).all()) == 1
        assert s.scalars(select(Stock)).first().reserved == 60
    svc.verify(a["PHARMACIST"], fill)


def test_retry_fails_closed_if_original_hold_uncleared(demo):
    svc, a, outside, patient, fill, coverage, original, ledger, expiry = demo
    with pytest.raises(WorkflowError, match="first resolve"):
        ledger.retry_cleared_rejection(a["PHARMACIST"], original,
            expected_resolution_id="stale", coverage_ids=list(coverage),
            reason="No documented pharmacist resolution exists yet")
    assert [x["operation"] for x in ledger.list_for_fill(a["AUDITOR"], fill)] == [
        "TEST_REJECT"]


def test_retry_guards_role_cross_site_stale_resolution_and_cob_order(demo):
    svc, a, outside, patient, fill, coverage, original, ledger, expiry = demo
    resolution = _clear(demo)
    args = dict(expected_resolution_id=resolution, coverage_ids=list(coverage),
                reason="Verified synthetic correction with documented rationale")
    with pytest.raises(AccessDenied):
        ledger.retry_cleared_rejection(a["TECHNICIAN"], original, **args)
    with pytest.raises(WorkflowError, match="not found at pharmacy"):
        ledger.retry_cleared_rejection(outside["PHARMACIST"], original, **args)
    with pytest.raises(WorkflowError, match="changed"):
        ledger.retry_cleared_rejection(a["PHARMACIST"], original,
            **{**args, "expected_resolution_id": "stale-resolution"})
    with pytest.raises(WorkflowError, match="previously rejected coverage"):
        ledger.retry_cleared_rejection(a["PHARMACIST"], original,
            **{**args, "coverage_ids": [coverage[1]]})
    with pytest.raises(WorkflowError, match="COB coverage order"):
        ledger.retry_cleared_rejection(a["PHARMACIST"], original,
            **{**args, "coverage_ids": list(reversed(coverage))})
    assert ledger.rejection_queue(a["AUDITOR"])[0]["status"] == "CLEARED_TEST_HOLD"
    success = ledger.retry_cleared_rejection(a["PHARMACIST"], original, **args)
    with pytest.raises(WorkflowError, match="Only an active Product Fill"):
        ledger.retry_cleared_rejection(a["PHARMACIST"], original, **args)
    assert len(ledger.rejection_queue(a["AUDITOR"])) == 1
    assert success["claim_ids"]


def test_failed_claim_preparation_rolls_back_retry_and_paid_events(demo):
    svc, a, outside, patient, fill, coverage, original, ledger, expiry = demo
    resolution = _clear(demo)
    source = svc.scanned_sources(a["TECHNICIAN"], fill)[0]["id"]
    svc.remove_scanned_source(a["TECHNICIAN"], fill, source,
        "Test partial source shortage requiring a fresh physical rescan")
    with pytest.raises(WorkflowError, match="Physical source"):
        ledger.retry_cleared_rejection(a["PHARMACIST"], original,
            expected_resolution_id=resolution, coverage_ids=list(coverage),
            reason="Mock payer retry should fail with missing verified physical sources")
    events = ledger.list_for_fill(a["AUDITOR"], fill)
    assert [x["operation"] for x in events] == ["TEST_REJECT", "TEST_RESOLVE"]
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PRODUCT_FILL"
        assert s.scalars(select(Claim).where(Claim.fill_id == fill)).all() == []
        assert s.scalars(select(Label).where(Label.fill_id == fill)).all() == []
    svc.scan_source(a["TECHNICIAN"], fill, "RETRY-TEST-BAR", "SYN-RETRY-LOT",
                    expiry, "60")
    result = ledger.retry_cleared_rejection(a["PHARMACIST"], original,
        expected_resolution_id=resolution, coverage_ids=list(coverage),
        reason="Corrected stock source before returning to simulated payer workflow")
    assert len(result["claim_ids"]) == 2


def test_transaction_rolls_back_when_claim_adapter_crashes(demo):
    svc, a, outside, patient, fill, coverage, original, ledger, expiry = demo
    resolution = _clear(demo)
    from pharmacy1os import claim_transactions
    with patch.object(claim_transactions, "record_test_paid",
            side_effect=WorkflowError("Deliberate synthetic payer preparation exception")):
        with pytest.raises(WorkflowError, match="Deliberate"):
            ledger.retry_cleared_rejection(a["PHARMACIST"], original,
                expected_resolution_id=resolution, coverage_ids=list(coverage),
                reason="Payer transaction exception should not leave retry or label side effects")
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PRODUCT_FILL"
        assert s.scalars(select(Claim)).all() == []
        assert s.scalars(select(Label)).all() == []
        assert s.scalar(select(SandboxClaimTransaction.id).where(
            SandboxClaimTransaction.operation == "TEST_RETRY")) is None


def test_api_requires_synthetic_mode_and_pharmacist(demo):
    svc, a, outside, patient, fill, coverage, original, ledger, expiry = demo
    resolution = _clear(demo)
    yes = TestClient(create_app(svc, synthetic_enabled=True))
    no = TestClient(create_app(svc, synthetic_enabled=False))
    url = f"/api/third-party/test-rejections/{original}/retry"
    data = {
        "expected_resolution_id": resolution,
        "coverage_ids": list(coverage),
        "reason": "Documented local synthetic retry after reviewing prior simulated rejection",
    }
    ph = {"x-demo-staff-id": a["PHARMACIST"].id}
    assert no.post(url, headers=ph, json=data).status_code == 503
    assert yes.post(url, json=data).status_code == 403
    assert yes.post(url, headers={"x-demo-staff-id": a["TECHNICIAN"].id},
                    json=data).status_code == 403
    assert yes.post(url, headers=ph, json={
        "expected_resolution_id": resolution, "coverage_ids": [],
        "reason": data["reason"]}).status_code == 422
    response = yes.post(url, headers=ph, json=data)
    assert response.status_code == 200, response.text
    assert len(response.json()["claim_ids"]) == 2
    assert response.json()["external_submission"] is False


def test_malformed_historical_rejection_request_blocks_retry(demo):
    svc, a, outside, patient, fill, coverage, original, ledger, expiry = demo
    resolution = _clear(demo)
    with svc.sessions.begin() as s:
        row = s.get(SandboxClaimTransaction, original)
        row.request_json = '{"changed":"unexpected"}'
    with pytest.raises(WorkflowError, match="integrity"):
        ledger.retry_cleared_rejection(a["PHARMACIST"], original,
            expected_resolution_id=resolution, coverage_ids=list(coverage),
            reason="Corrupt simulated original must be rejected before a retry")
    with svc.sessions() as s:
        assert s.scalar(select(SandboxClaimTransaction.id).where(
            SandboxClaimTransaction.operation == "TEST_RETRY")) is None
