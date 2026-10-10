"""Synthetic insurance event ledger and rejection workspace regression tests."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.billing import BillingService
from pharmacy1os.billing_models import PayerBillingProfile
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.insurance_models import ClaimCoverageSnapshot
from pharmacy1os.models import Claim, Fill, Label, Prescription
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    technician, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(technician, "Synthetic", "ClaimLedger")
    provider = svc.add_prescriber(technician, "Synthetic", "Prescriber", "MD")
    drug = svc.add_drug(pharmacist, "Test-Ledger-Med", "10mg", "tablet")
    product = svc.add_product(pharmacist, drug, "11122-3333-44", "Demo", "White tablet")
    svc.register_barcode(technician, product, "LEDGER-BARCODE")
    exp = (date.today() + timedelta(days=365)).isoformat()
    svc.receive(technician, "LEDGER-BARCODE", "LEDGER-LOT", exp, "120")
    rx = svc.add_prescription(technician, patient, provider, drug, "LEDGER-RX",
                              "Take 1 daily", "90", refills=1)
    svc.advance_to_dur(technician, rx)
    fill = svc.start_fill(technician, rx, "60")
    svc.scan_source(technician, fill, "LEDGER-BARCODE", "LEDGER-LOT", exp, "60")
    return svc, a, outside, patient, rx, fill, InsuranceDirectory(svc), SandboxClaimService(svc)


def cover(env):
    svc, a, outside, patient, rx, fill, directory, claims = env
    payer = directory.create_payer(a["PHARMACIST"], "Synthetic Test Insurance",
                                   bin="234567")
    coverage = directory.upsert_coverage(a["PHARMACIST"], patient, 1,
                                         payer, "TEST-MEMBER-1234")
    return payer, coverage


def inject(env, coverage, key="UNIQUE-TEST-REQUEST"):
    svc, a, _, _, _, fill, _, claim_svc = env
    return claim_svc.inject_rejection(a["PHARMACIST"], fill, coverage,
        "TEST_75", key, "Simulated prior authorization test")


def test_rejection_holds_fill_until_pharmacist_documents_clearance(env):
    svc, a, outside, patient, rx, fill, directory, ledger = env
    payer, coverage = cover(env)
    rejection_id = inject(env, coverage)
    assert ledger.rejection_queue(a["AUDITOR"])[0]["status"] == "OPEN_TEST_REJECTION"
    assert ledger.rejection_queue(outside["AUDITOR"]) == []
    with pytest.raises(WorkflowError, match="Open synthetic insurance rejection"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[coverage])
    with pytest.raises(WorkflowError, match="Open synthetic insurance rejection"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, ["Legacy Sandbox"])
    with svc.sessions() as s:
        assert s.scalars(select(Claim)).all() == []
        assert s.scalars(select(Label)).all() == []
        assert s.get(Fill, fill).status == "PRODUCT_FILL"
    with pytest.raises(AccessDenied):
        ledger.resolve_rejection(a["TECHNICIAN"], rejection_id,
            "Need a pharmacist to review")
    cleared = ledger.resolve_rejection(a["PHARMACIST"], rejection_id,
        "Reviewed simulated rejection, cleared development-only hold")
    assert cleared != rejection_id
    assert ledger.rejection_queue(a["AUDITOR"])[0]["status"] == "CLEARED_TEST_HOLD"
    with pytest.raises(WorkflowError, match="already cleared"):
        ledger.resolve_rejection(a["PHARMACIST"], rejection_id,
            "Duplicate resolution should not be accepted")
    svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[coverage])
    with svc.sessions() as s:
        assert len(s.scalars(select(Claim)).all()) == 1


def test_paid_and_reversal_are_append_only_request_response_and_refer_to_original(env):
    svc, a, outside, patient, rx, fill, directory, ledger = env
    payer, coverage = cover(env)
    svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[coverage])
    events = ledger.list_for_fill(a["AUDITOR"], fill)
    assert len(events) == 1
    paid = events[0]
    assert paid["operation"] == "BILL"
    assert paid["outcome"] == "PAID_SYNTHETIC"
    assert paid["request"]["payer_id"] == payer
    assert paid["request"]["coverage_id"] == coverage
    assert paid["request"]["payer_intended_quantity"] == "90.000"
    assert paid["request"]["physical_part_quantity"] == "60.000"
    assert paid["request"]["billed_ndc"] == "11122-3333-44"
    assert paid["response"]["transaction_reference"] is None
    assert paid["response"]["amount_paid"] is None
    assert "TEST-MEMBER" not in str(paid)
    svc.verify(a["PHARMACIST"], fill)
    svc.return_to_stock(a["PHARMACIST"], fill, "Return synthetic fill to stock")
    all_events = ledger.list_for_fill(a["AUDITOR"], fill)
    assert [x["operation"] for x in all_events] == ["BILL", "REVERSE"]
    reversal = all_events[1]
    assert reversal["original_transaction_id"] == paid["id"]
    assert reversal["outcome"] == "REVERSED_SYNTHETIC"
    assert "remote payer" in reversal["response"]["message"]
    with svc.sessions() as s:
        assert s.get(Claim, paid["claim_id"]).status == "REVERSED_SYNTHETIC"
        assert len(s.scalars(select(ClaimCoverageSnapshot)).all()) == 1


def test_local_rejection_duplicate_key_replays_only_identical_request(env):
    svc, a, outside, patient, rx, fill, directory, ledger = env
    payer, coverage = cover(env)
    original = inject(env, coverage, "KEY-ONE-123456")
    repeated = inject(env, coverage, "KEY-ONE-123456")
    assert original == repeated
    with pytest.raises(WorkflowError, match="Idempotency key conflict"):
        ledger.inject_rejection(a["PHARMACIST"], fill, coverage, "TEST_70",
            "KEY-ONE-123456", "Different test rejection request")
    with svc.sessions() as s:
        assert len(s.scalars(select(SandboxClaimTransaction)).all()) == 1


def test_test_rejection_role_and_cross_site_ownership(env):
    svc, a, outside, patient, rx, fill, directory, ledger = env
    payer, coverage = cover(env)
    with pytest.raises(AccessDenied):
        ledger.inject_rejection(a["TECHNICIAN"], fill, coverage, "TEST_70",
            "KEY-TECH-12345", "Technician cannot inject test rejection")
    with pytest.raises(WorkflowError, match="not found at actor"):
        ledger.inject_rejection(outside["PHARMACIST"], fill, coverage, "TEST_70",
            "KEY-OTHER-1234", "Different pharmacy site is not allowed")
    with pytest.raises(WorkflowError, match="Unsupported"):
        ledger.inject_rejection(a["PHARMACIST"], fill, coverage, "ACTUAL_PAYER_XX",
            "KEY-UNKNOWN-1234", "Unsupported payer network rejection")
    with pytest.raises(WorkflowError):
        ledger.list_for_fill(outside["AUDITOR"], fill)


def test_immutable_request_hash_detects_storage_tampering(env):
    svc, a, outside, patient, rx, fill, directory, ledger = env
    payer, coverage = cover(env)
    rejected_id = inject(env, coverage)
    with svc.sessions.begin() as s:
        record = s.get(SandboxClaimTransaction, rejected_id)
        record.request_json = '{"fill_id":"fabricated"}'
    with pytest.raises(WorkflowError, match="integrity"):
        ledger.list_for_fill(a["AUDITOR"], fill)


def test_canonical_payer_profile_applies_to_coverage_linked_claim(env):
    svc, a, outside, patient, rx, fill, directory, ledger = env
    payer, coverage = cover(env)
    billing = BillingService(svc)
    pid = billing.update_profile(a["PHARMACIST"], "Synthetic Test Insurance",
        payer_id=payer, max_physical_sources=1,
        billing_ndc_strategy="FIRST_SCANNED",
        reason="Linked synthetic canonical payer profile")
    profiles = billing.profiles(a["AUDITOR"])
    assert profiles[0]["payer_id"] == payer
    assert profiles[0]["id"] == pid
    with pytest.raises(WorkflowError, match="Linked payer"):
        billing.update_profile(a["PHARMACIST"], "Name mismatch",
            payer_id=payer, max_physical_sources=2, reason="Should fail")
    with pytest.raises(WorkflowError, match="Linked payer"):
        billing.update_profile(outside["PHARMACIST"], "Synthetic Test Insurance",
            payer_id=payer, max_physical_sources=2, reason="Should fail")
    svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[coverage])
    records = ledger.list_for_fill(a["AUDITOR"], fill)
    assert records[0]["request"]["billing_profile"]["profile_id"] == pid
    assert records[0]["request"]["billing_profile"]["version"] == 1
    with svc.sessions() as s:
        assert s.scalar(select(PayerBillingProfile)).payer_id == payer


def test_legacy_name_only_sandbox_claim_records_unlinked_source(env):
    svc, a, outside, patient, rx, fill, directory, ledger = env
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Legacy Test Plan"])
    tx = ledger.list_for_fill(a["AUDITOR"], fill)[0]
    assert tx["request"]["standard"] == "SANDBOX_LEGACY"
    assert tx["payer_id"] is None
    assert tx["coverage_id"] is None


def test_rejection_workspace_api_is_synthetic_gated_and_role_authorized(env):
    svc, a, outside, patient, rx, fill, directory, ledger = env
    payer, coverage = cover(env)
    cli = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    pharm = {"x-demo-staff-id": a["PHARMACIST"].id}
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    audit = {"x-demo-staff-id": a["AUDITOR"].id}
    payload = {"fill_id": fill, "coverage_id": coverage, "reject_code": "TEST_79",
        "idempotency_key": "API-TEST-REJECT-ONE",
        "reason": "Synthetic early refill rejection for test"}
    assert cli.post("/api/third-party/test-rejections", headers=tech,
        json=payload).status_code == 403
    assert cli.post("/api/third-party/test-rejections", headers=pharm,
        json=payload).status_code == 201
    assert disabled.get("/api/third-party/test-rejections", headers=audit).status_code == 503
    queue = cli.get("/api/third-party/test-rejections", headers=audit)
    assert queue.status_code == 200 and queue.json()["rejections"][0]["code"] == "TEST_79"
    test_id = queue.json()["rejections"][0]["id"]
    assert cli.get(f"/api/fills/{fill}/claim-transactions", headers=audit).status_code == 200
    assert cli.post(f"/api/third-party/test-rejections/{test_id}/clear",
        headers=tech, json={"note": "Technician cannot clear the test hold"}).status_code == 403
    result = cli.post(f"/api/third-party/test-rejections/{test_id}/clear",
        headers=pharm, json={"note": "Reviewed and cleared simulated hold only"})
    assert result.status_code == 200
    assert result.json()["external_approval"] is False
    assert cli.get("/api/third-party/test-rejections", headers=audit).json()[
        "rejections"][0]["status"] == "CLEARED_TEST_HOLD"
