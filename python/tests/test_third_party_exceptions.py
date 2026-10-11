"""Site-wide synthetic Third Party exception workqueue, no external claims."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.claim_rebilling import ClaimRebillService
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.models import Claim, Fill, Prescription, Stock
from pharmacy1os.service import PharmacyService, WorkflowError
from pharmacy1os.third_party_exceptions import ThirdPartyExceptionQueue


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Mock", "ExceptionQueue")
    provider = svc.add_prescriber(tech, "Mock", "Physician", "MD")
    drug = svc.add_drug(pharm, "Synthetic exception drug", "6mg", "tablet")
    prod = svc.add_product(pharm, drug, "01010-2222-33", "Test maker", "Mock pills")
    svc.register_barcode(tech, prod, "EXCEPTION-TEST-BC")
    exp = (date.today() + timedelta(days=320)).isoformat()
    stock = svc.receive(tech, "EXCEPTION-TEST-BC", "EXCEPTION-LOT", exp, "160")
    rx = svc.add_prescription(tech, patient, provider, drug,
        "TEST-EXCEPTION-QUEUE-RX", "one daily", "60")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, days_supply=60)
    svc.scan_source(tech, fill, "EXCEPTION-TEST-BC", "EXCEPTION-LOT", exp, "60")
    ins = InsuranceDirectory(svc)
    p1 = ins.create_payer(pharm, "TEST Primary Plan")
    p2 = ins.create_payer(pharm, "TEST Secondary Plan")
    cov1 = ins.upsert_coverage(pharm, patient, 1, p1, "SECRET-MEMBER-ONE")
    cov2 = ins.upsert_coverage(pharm, patient, 2, p2, "SECRET-MEMBER-TWO")
    return svc, a, outside, patient, rx, fill, stock, exp, [cov1, cov2]


def test_rejection_to_resolution_to_retry_disappears_from_queue(case):
    svc, a, outside, patient, rx, fill, stock, exp, coverages = case
    ledger = SandboxClaimService(svc)
    reject = ledger.inject_rejection(a["PHARMACIST"], fill, coverages[0],
        "TEST_75", "EXCEPTION-REJECT-001", "Only a deliberately injected test hold")
    queue = ThirdPartyExceptionQueue(svc)
    opened = queue.snapshot(a["AUDITOR"])
    assert len(opened["items"]) == 1
    issue = opened["items"][0]
    assert issue["event_id"] == reject
    assert issue["status"] == "OPEN_TEST_REJECTION"
    assert issue["recommended_action"] == "PHARMACIST_REVIEW_TEST_REJECTION"
    assert issue["reason_code"] == "TEST_75"
    assert "SECRET-MEMBER" not in str(opened)
    assert "no" not in opened["warning"].lower() or "claim" in opened["warning"].lower()
    resolution = ledger.resolve_rejection(a["PHARMACIST"], reject,
        "Pharmacist has documented this simulated test hold resolution")
    cleared = queue.snapshot(a["AUDITOR"], status="CLEARED_AWAITING_RETRY")
    assert len(cleared["items"]) == 1
    assert cleared["items"][0]["resolution_id"] == resolution
    assert cleared["items"][0]["status"] == "CLEARED_AWAITING_RETRY"
    assert queue.snapshot(a["AUDITOR"], status="OPEN_TEST_REJECTION")["items"] == []
    ledger.retry_cleared_rejection(a["PHARMACIST"], reject,
        expected_resolution_id=resolution, coverage_ids=coverages,
        reason="Pharmacist test-only COB retry prepared after resolution")
    assert queue.snapshot(a["AUDITOR"])["items"] == []
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == Decimal("60")
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert len(s.scalars(select(Claim).where(Claim.fill_id == fill)).all()) == 2


def test_multiple_unresolved_holds_pagination_and_site_boundary(case):
    svc, a, outside, patient, rx, fill, stock, exp, coverages = case
    ledger = SandboxClaimService(svc)
    one = ledger.inject_rejection(a["PHARMACIST"], fill, coverages[0],
        "TEST_75", "EXCEPTION-REJECT-002", "Mock first manual rejection for tests")
    two = ledger.inject_rejection(a["PHARMACIST"], fill, coverages[1],
        "TEST_79", "EXCEPTION-REJECT-003", "Mock second manual rejection for tests")
    queue = ThirdPartyExceptionQueue(svc)
    first = queue.snapshot(a["AUDITOR"], limit=1)
    second = queue.snapshot(a["AUDITOR"], limit=1, offset=1)
    assert first["next_offset"] == 1 and second["next_offset"] is None
    assert {first["items"][0]["event_id"], second["items"][0]["event_id"]} == {one, two}
    assert queue.snapshot(outside["AUDITOR"])["items"] == []
    with pytest.raises(WorkflowError):
        queue.snapshot(a["AUDITOR"], limit=0)
    with pytest.raises(WorkflowError):
        queue.snapshot(a["AUDITOR"], status="NOT_A_STATUS")
    with pytest.raises(WorkflowError):
        queue.snapshot(a["AUDITOR"], offset=-1)
    with pytest.raises(WorkflowError):
        queue.snapshot(a["AUDITOR"], limit=True)
    ledger.resolve_rejection(a["PHARMACIST"], one,
        "Recorded only the first of two mock hold resolutions")
    only_cleared = queue.snapshot(a["AUDITOR"], status="CLEARED_AWAITING_RETRY")
    assert [x["event_id"] for x in only_cleared["items"]] == [one]
    assert [x["event_id"] for x in queue.snapshot(a["AUDITOR"],
        status="OPEN_TEST_REJECTION")["items"]] == [two]


def test_unreconciled_test_hold_is_not_mislabelled_open(case):
    svc, a, outside, patient, rx, fill, stock, exp, coverages = case
    ledger = SandboxClaimService(svc)
    ledger.inject_rejection(a["PHARMACIST"], fill, coverages[0],
        "TEST_70", "EXCEPTION-REJECT-004", "Deliberately bad fill status fixture")
    with svc.sessions.begin() as s:
        s.get(Fill, fill).status = "PHARMACIST_REVIEW"
    records = ThirdPartyExceptionQueue(svc).snapshot(a["AUDITOR"])
    assert records["items"][0]["status"] == "RECONCILIATION_REQUIRED"
    assert records["items"][0]["recommended_action"] == "MANUAL_RECONCILIATION"
    assert ThirdPartyExceptionQueue(svc).snapshot(
        a["AUDITOR"], status="OPEN_TEST_REJECTION")["items"] == []
    assert len(ThirdPartyExceptionQueue(svc).snapshot(
        a["AUDITOR"], status="RECONCILIATION_REQUIRED")["items"]) == 1


def test_replacement_fill_transitions_through_rescan_and_review(case):
    svc, a, outside, patient, rx, fill, stock, exp, coverages = case
    svc.prepare_for_review(a["TECHNICIAN"], fill,
        ["Mock Primary", "Mock Secondary"])
    with svc.sessions() as s:
        ids = [claim.id for claim in s.scalars(select(Claim).where(
            Claim.fill_id == fill).order_by(Claim.sequence)).all()]
    result = ClaimRebillService(svc).restart(a["PHARMACIST"], fill,
        "Incorrect mock insurance NDC requires fresh physical fill",
        expected_claim_ids=ids)
    queue = ThirdPartyExceptionQueue(svc)
    new_id = result["replacement_fill_id"]
    scan = queue.snapshot(a["AUDITOR"], status="REPLACEMENT_RESCAN_REQUIRED")
    assert [x["fill_id"] for x in scan["items"]] == [new_id]
    assert scan["items"][0]["original_fill_id"] == fill
    assert scan["items"][0]["recommended_action"] == "PHYSICAL_RESCAN_REQUIRED"
    svc.scan_source(a["TECHNICIAN"], new_id, "EXCEPTION-TEST-BC",
        "EXCEPTION-LOT", exp, "60")
    svc.prepare_for_review(a["TECHNICIAN"], new_id, ["Mock Primary"])
    review = queue.snapshot(a["AUDITOR"], status="REPLACEMENT_PHARMACIST_REVIEW")
    assert [x["fill_id"] for x in review["items"]] == [new_id]
    svc.verify(a["PHARMACIST"], new_id)
    assert queue.snapshot(a["AUDITOR"])["items"] == []


def test_original_event_corruption_is_rejected_before_queue_display(case):
    svc, a, outside, patient, rx, fill, stock, exp, coverages = case
    ledger = SandboxClaimService(svc)
    reject = ledger.inject_rejection(a["PHARMACIST"], fill, coverages[0],
        "TEST_75", "EXCEPTION-REJECT-005", "Corrupt simulated response payload test")
    with svc.sessions.begin() as s:
        s.get(SandboxClaimTransaction, reject).response_json = '{"outcome":"PAID_SYNTHETIC"}'
    with pytest.raises(WorkflowError, match="integrity"):
        ThirdPartyExceptionQueue(svc).snapshot(a["AUDITOR"])
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PRODUCT_FILL"
        assert s.get(Stock, stock).reserved == 60


def test_exception_queue_api_is_synthetic_and_role_scoped(case):
    svc, a, outside, patient, rx, fill, stock, exp, coverages = case
    ledger = SandboxClaimService(svc)
    reject = ledger.inject_rejection(a["PHARMACIST"], fill, coverages[0],
        "TEST_75", "EXCEPTION-REJECT-006", "API test case for local exception workbench")
    endpoint = "/api/third-party/exception-queue?limit=1&status=OPEN_TEST_REJECTION"
    demo = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    header = {"x-demo-staff-id": a["AUDITOR"].id}
    assert disabled.get(endpoint, headers=header).status_code == 503
    assert demo.get(endpoint).status_code == 403
    data = demo.get(endpoint, headers=header)
    assert data.status_code == 200, data.text
    assert data.json()["items"][0]["event_id"] == reject
    assert demo.get(endpoint, headers={"x-demo-staff-id": outside["AUDITOR"].id}).json()["items"] == []
    assert demo.get("/api/third-party/exception-queue?limit=51",
        headers=header).status_code == 409


def test_filtered_cleared_hold_not_lost_beyond_first_page_of_newer_open_holds(case):
    svc, a, outside, patient, rx, fill, stock, exp, coverages = case
    ledger = SandboxClaimService(svc)
    earlier = ledger.inject_rejection(a["PHARMACIST"], fill, coverages[0],
        "TEST_75", "EXCEPTION-PAGE-OLD-CLEARED",
        "Oldest pharmacist-reviewed simulated hold in the workqueue")
    ledger.resolve_rejection(a["PHARMACIST"], earlier,
        "Cleared the original mock hold before newer test failures were injected")
    for index in range(31):
        ledger.inject_rejection(a["PHARMACIST"], fill, coverages[1],
            "TEST_79", f"EXCEPTION-PAGE-OPEN-{index:04}",
            "Newer test rejection created to challenge filtered queue pagination")
    # A capped first 26 event candidates would incorrectly hide this work item.
    result = ThirdPartyExceptionQueue(svc).snapshot(
        a["AUDITOR"], status="CLEARED_AWAITING_RETRY", limit=1)
    assert [x["event_id"] for x in result["items"]] == [earlier]
    assert result["next_offset"] is None
