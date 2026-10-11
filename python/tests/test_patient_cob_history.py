"""Increment 54: patient-scoped, cross-fill synthetic COB and test-rejection history."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.claim_rebilling import ClaimRebillService
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.cob_attempts import CobAttemptRegistry, SyntheticCobAttempt
from pharmacy1os.cob_selective_correction import SyntheticCobCorrectionService
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.models import Fill, Claim, Stock
from pharmacy1os.patient_cob_history import PatientCobHistory
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    pat = svc.add_patient(tech, "Demo", "PatientCOB", phone="919-555-9922")
    doc = svc.add_prescriber(tech, "Mock", "Provider", "MD")
    drug = svc.add_drug(pharm, "Synthetic patient history test", "10mg", "tablet")
    expiry = (date.today() + timedelta(days=280)).isoformat()
    for i in (1, 2):
        p = svc.add_product(pharm, drug, f"55677-3000-0{i}", f"Demo Mfg {i}", "Mock tablets")
        svc.register_barcode(tech, p, f"PATIENT-COB-BAR-{i}")
        svc.receive(tech, f"PATIENT-COB-BAR-{i}",
                    f"PATIENT-COB-LOT-{i}", expiry, "120")
    return svc, actors, other, pat, doc, drug, expiry


def _fill(case, number, *, both=False, qty="40"):
    svc, actors, outside, patient, doctor, drug, exp = case
    tech = actors["TECHNICIAN"]
    rx = svc.add_prescription(tech, patient, doctor, drug, number,
        "One mock unit per day", qty)
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx)
    if both:
        svc.scan_source(tech, fill, "PATIENT-COB-BAR-1", "PATIENT-COB-LOT-1", exp, "25")
        svc.scan_source(tech, fill, "PATIENT-COB-BAR-2", "PATIENT-COB-LOT-2", exp, "15")
    else:
        svc.scan_source(tech, fill, "PATIENT-COB-BAR-1", "PATIENT-COB-LOT-1", exp, qty)
    return rx, fill


def _rejected_retried(case):
    svc, a, other, patient, _, _, exp = case
    rx, fill = _fill(case, "RX-HOLD-54")
    ins = InsuranceDirectory(svc)
    p1 = ins.create_payer(a["PHARMACIST"], "Mock Primary")
    p2 = ins.create_payer(a["PHARMACIST"], "Mock Secondary")
    cov1 = ins.upsert_coverage(a["PHARMACIST"], patient, 1, p1,
        "NO-LIVE-MEMBER-123456")
    cov2 = ins.upsert_coverage(a["PHARMACIST"], patient, 2, p2,
        "NO-LIVE-MEMBER-654321")
    claim = SandboxClaimService(svc)
    rejected = claim.inject_rejection(a["PHARMACIST"], fill, cov1, "TEST_75",
        "PATIENT-COB-REJECT-54", "Test prior authorization is intentionally missing")
    resolved = claim.resolve_rejection(a["PHARMACIST"], rejected,
        "Pharmacist documented local synthetic rejection resolution")
    retry = claim.retry_cleared_rejection(a["PHARMACIST"], rejected,
        expected_resolution_id=resolved, coverage_ids=[cov1, cov2],
        reason="Documented corrected mock rule; submit only to local test adapter")
    return fill, rejected, resolved, retry["id"], (cov1, cov2)


def test_patient_history_connects_rejection_resolution_retry_and_paid_cob(case):
    svc, a, other, patient, doctor, drug, exp = case
    fill, rejected, resolved, retry, coverages = _rejected_retried(case)
    report = PatientCobHistory(svc).history(a["AUDITOR"], patient)
    assert report["total_fills"] == 1
    assert report["next_offset"] is None
    assert len(report["fills"]) == 1
    row = report["fills"][0]
    assert row["fill_id"] == fill and row["fill_status"] == "PHARMACIST_REVIEW"
    assert row["active_local_paid_positions"] == 2
    assert row["payer_correction_count"] == 0
    assert row["open_test_rejections"] == 0
    hold = row["synthetic_test_rejections"][0]
    assert hold["rejection_id"] == rejected
    assert hold["resolution_id"] == resolved
    assert hold["retry_id"] == retry
    assert hold["status"] == "RETRY_PREPARED_SYNTHETIC"
    assert hold["reject_code"] == "TEST_75"
    assert hold["external_payer_rejection"] is False
    assert report["summary"]["open_test_rejections_in_page"] == 0
    assert report["warning"] == "SYNTHETIC_ONLY_NO_REAL_CLAIM_APPROVAL_OR_PAYMENT"
    assert "NO-LIVE-MEMBER" not in str(report)
    assert "Test prior authorization is intentionally missing" not in str(report)
    assert all(p["attempts"][0]["external_submission"] is False
               for p in row["claim_positions"])


def test_history_tracks_two_rounds_of_payer_versions_and_full_rescan_link(case):
    svc, a, other, patient, doctor, drug, exp = case
    rx, fill = _fill(case, "RX-SELECTIVE-54", both=True)
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Mock One", "Mock Two"])
    history = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    original = history["claim_positions"][1]["attempts"][-1]["paid_transaction_id"]
    done = SyntheticCobCorrectionService(svc).correct(
        a["PHARMACIST"], fill,
        "Local synthetic secondary NDC needs corrected scanned manufacturer",
        target_position=2, expected_active_paid_transaction_ids=[original],
        corrected_billing_ndc="55677-3000-02")
    assert len(done["new_paid_transaction_ids"]) == 1
    updated = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    current_ids = [c["attempts"][-1]["paid_transaction_id"]
                   for c in reversed(updated["claim_positions"])]
    replaced = ClaimRebillService(svc).reverse_current_cob(
        a["PHARMACIST"], fill,
        "Pharmacist requests full local corrected COB reversal and fresh rescan",
        expected_active_paid_transaction_ids=current_ids)
    report = PatientCobHistory(svc).history(a["AUDITOR"], patient)
    assert report["total_fills"] == 2
    by_id = {row["fill_id"]: row for row in report["fills"]}
    old = by_id[fill]
    new = by_id[replaced["replacement_fill_id"]]
    assert old["fill_status"] == "RETURNED"
    assert old["payer_correction_count"] == 1
    assert old["active_local_paid_positions"] == 0
    assert old["replacement_fill_id"] == new["fill_id"]
    assert new["original_fill_id"] == fill and new["fill_status"] == "PRODUCT_FILL"
    assert new["claim_positions"] == []
    assert report["summary"]["replacement_links_for_patient"] == 1
    assert report["summary"]["payer_corrections_in_page"] == 1
    assert len(old["claim_positions"][1]["attempts"]) == 2
    assert all(x["state"] == "REVERSED_SYNTHETIC"
               for p in old["claim_positions"] for x in p["attempts"])


def test_patient_history_keeps_unresolved_rejection_without_claims(case):
    svc, a, other, patient, doctor, drug, exp = case
    rx, fill = _fill(case, "RX-OPEN-HOLD-54")
    ins = InsuranceDirectory(svc)
    payer = ins.create_payer(a["PHARMACIST"], "Not a real insurer")
    cov = ins.upsert_coverage(a["PHARMACIST"], patient, 1, payer,
        "SECRET-TEST-COVERAGE-MEMBER")
    rejected = SandboxClaimService(svc).inject_rejection(
        a["PHARMACIST"], fill, cov, "TEST_79", "PATIENT-OPEN-HOLD-54",
        "Development-only test rejection without documented resolution")
    report = PatientCobHistory(svc).history(a["AUDITOR"], patient)
    assert report["fills"][0]["claim_positions"] == []
    hold = report["fills"][0]["synthetic_test_rejections"][0]
    assert hold["rejection_id"] == rejected
    assert hold["status"] == "OPEN_TEST_REJECTION"
    assert hold["resolution_id"] is None and hold["retry_id"] is None
    assert report["summary"]["open_test_rejections_in_page"] == 1
    assert "SECRET-TEST-COVERAGE-MEMBER" not in str(report)


def test_patient_history_site_and_api_pagination_gates(case):
    svc, a, other, patient, doctor, drug, exp = case
    _fill(case, "A-54")
    _fill(case, "B-54")
    _fill(case, "C-54")
    work = PatientCobHistory(svc)
    assert [len(work.history(a["AUDITOR"], patient, limit=1, offset=n)["fills"])
            for n in range(3)] == [1,1,1]
    page = work.history(a["AUDITOR"], patient, limit=2)
    assert page["total_fills"] == 3
    assert page["next_offset"] == 2
    assert page["summary"]["replacement_links_for_patient"] == 0
    assert work.history(a["AUDITOR"], patient, limit=2, offset=2)["next_offset"] is None
    with pytest.raises(WorkflowError, match="pharmacy site"):
        work.history(other["AUDITOR"], patient)
    for limit, offset in ((0, 0), (51, 0), (25, -1), (25, 10001)):
        with pytest.raises(WorkflowError):
            work.history(a["AUDITOR"], patient, limit=limit, offset=offset)
    enabled = TestClient(create_app(svc, synthetic_enabled=True))
    off = TestClient(create_app(svc, synthetic_enabled=False))
    endpoint = f"/api/third-party/patients/{patient}/cob-history"
    headers = {"x-demo-staff-id": a["AUDITOR"].id}
    assert off.get(endpoint, headers=headers).status_code == 503
    assert enabled.get(endpoint).status_code == 403
    assert enabled.get(endpoint, headers=headers).status_code == 200
    assert enabled.get(endpoint + "?limit=1&offset=1", headers=headers).json()["next_offset"] == 2
    assert enabled.get(endpoint + "?limit=51", headers=headers).status_code == 409
    assert enabled.get(endpoint, headers={
        "x-demo-staff-id": other["AUDITOR"].id}).status_code == 409


def test_rejection_response_tamper_and_orphan_links_fail_closed(case):
    svc, a, other, patient, doc, drug, exp = case
    fill, rejected, resolved, retry, coverages = _rejected_retried(case)
    with svc.sessions.begin() as s:
        tx = s.get(SandboxClaimTransaction, rejected)
        old = tx.response_json
        tx.response_json = '{"outcome":"REJECTED_SYNTHETIC","reject_codes":["TEST_70"]}'
    with pytest.raises(WorkflowError, match="integrity"):
        PatientCobHistory(svc).history(a["AUDITOR"], patient)
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, rejected).response_json = old
        s.get(SandboxClaimTransaction, retry).original_transaction_id = resolved
    with pytest.raises(WorkflowError, match="orphaned"):
        PatientCobHistory(svc).history(a["AUDITOR"], patient)
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, retry).original_transaction_id = rejected
    assert PatientCobHistory(svc).history(a["AUDITOR"], patient)["total_fills"] == 1


def test_missing_payer_attempt_mirror_fails_closed_without_status_change(case):
    svc, a, other, patient, doctor, drug, exp = case
    rx, fill = _fill(case, "RX-MISSING-54")
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Synthetic Example Payer"])
    with svc.sessions.begin() as s:
        attempt = s.scalar(select(SyntheticCobAttempt))
        s.delete(attempt)
    with pytest.raises(WorkflowError, match="incomplete"):
        PatientCobHistory(svc).history(a["AUDITOR"], patient)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert len(s.scalars(select(Claim)).all()) == 1
