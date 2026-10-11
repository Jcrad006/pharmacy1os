"""Synthetic per-fill claim/label report and multi-attempt rebill audit."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.claim_rebilling import ClaimRebillService
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.fill_claim_review import FillClaimReview
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.label_printing import LabelPrintJob, LabelPrintService
from pharmacy1os.models import Claim
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    drug = svc.add_drug(pharm, "Claim audit sample", "10mg", "tablet")
    exp = (date.today() + timedelta(days=320)).isoformat()
    for i in (1, 2):
        product = svc.add_product(pharm, drug, f"66666-0777{i}-01",
                                  f"Sample Mfg {i}", f"white tablet Mfg {i}")
        svc.register_barcode(tech, product, f"AUDIT-CODE-{i}")
        svc.receive(tech, f"AUDIT-CODE-{i}", f"AUDIT-LOT-{i}", exp, "150")
    patient = svc.add_patient(tech, "Synthetic", "ClaimAudit")
    prescriber = svc.add_prescriber(tech, "Synthetic", "Physician", "MD")
    rx = svc.add_prescription(tech, patient, prescriber, drug,
                              "RX-CLAIM-HISTORY", "Take one tablet daily", "90")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, days_supply=30)
    svc.scan_source(tech, fill, "AUDIT-CODE-1", "AUDIT-LOT-1", exp, "65")
    svc.scan_source(tech, fill, "AUDIT-CODE-2", "AUDIT-LOT-2", exp, "25")
    return svc, a, outside, patient, rx, fill, exp


def _ids(svc, fill_id):
    with svc.sessions() as s:
        return [c.id for c in s.scalars(select(Claim).where(
            Claim.fill_id == fill_id).order_by(Claim.sequence)).all()]


def test_unified_claim_report_reconciles_multi_payer_and_two_physical_labels(case):
    svc, a, outside, person, rx, fill, exp = case
    insurer = InsuranceDirectory(svc)
    payer1 = insurer.create_payer(a["PHARMACIST"], "Insurance A")
    payer2 = insurer.create_payer(a["PHARMACIST"], "Insurance B")
    cover1 = insurer.upsert_coverage(
        a["PHARMACIST"], person, 1, payer1, "SECRET-MEMBER-A-2881")
    cover2 = insurer.upsert_coverage(
        a["PHARMACIST"], person, 2, payer2, "SECRET-MEMBER-B-8173")
    svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[cover1, cover2])
    report = FillClaimReview(svc).detail(a["AUDITOR"], fill)
    assert report["fill_number"] == 0 and report["attempt"] == 1
    assert report["status"] == "PHARMACIST_REVIEW"
    assert report["physical_quantity"] == "90.000"
    assert report["payer_intended_quantity"] == "90.000"
    assert len(report["claims"]) == 2
    assert [x["position"] for x in report["claims"]] == [1, 2]
    assert [x["payer"] for x in report["claims"]] == ["Insurance A", "Insurance B"]
    assert all(x["selected_ndc"] == "66666-07771-01" for x in report["claims"])
    assert all(x["source_count"] == 2 for x in report["claims"])
    assert all(x["days_supply"] == 30 for x in report["claims"])
    assert all(x["billed_quantity"] == "90.000" for x in report["claims"])
    assert all(x["coverage"]["member_id_masked"].startswith("*")
               for x in report["claims"])
    assert [len(x["claim_transactions"]) for x in report["claims"]] == [1, 1]
    assert [x["bottle_number"] for x in report["labels"]] == [1, 2]
    assert [x["physical_quantity"] for x in report["labels"]] == ["65.000", "25.000"]
    assert all(x["print_job"]["status"] == "QUEUED" for x in report["labels"])
    assert all(x["print_job"]["test_output_attempted"] is False for x in report["labels"])
    assert "SECRET-MEMBER-A-2881" not in str(report)
    assert "SECRET-MEMBER-B-8173" not in str(report)
    assert report["standalone_test_events"] == []


def test_original_voided_labels_and_paid_reversal_history_remain_unchanged(case):
    svc, a, outside, person, rx, fill, exp = case
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Demo A", "Demo B"])
    original = FillClaimReview(svc).detail(a["AUDITOR"], fill)
    ids = _ids(svc, fill)
    replacement = ClaimRebillService(svc).restart(
        a["PHARMACIST"], fill,
        "Incorrect test manufacturer required claim reversal and rescan",
        expected_claim_ids=ids)["replacement_fill_id"]
    old = FillClaimReview(svc).detail(a["AUDITOR"], fill)
    new = FillClaimReview(svc).detail(a["AUDITOR"], replacement)
    assert old["status"] == "RETURNED"
    assert [c["status"] for c in old["claims"]] == [
        "REVERSED_SYNTHETIC", "REVERSED_SYNTHETIC"]
    assert all(len(c["claim_transactions"]) == 2 for c in old["claims"])
    assert all(c["claim_transactions"][-1]["operation"] == "REVERSE"
               for c in old["claims"])
    assert all(x["print_job"]["status"] == "VOIDED" for x in old["labels"])
    assert [x["ndc"] for x in old["labels"]] == [x["ndc"] for x in original["labels"]]
    assert new["claims"] == [] and new["labels"] == []
    assert new["physical_quantity"] == "90.000"
    assert new["payer_intended_quantity"] == "90.000"


def test_output_event_is_recorded_without_claiming_hardware_success(case):
    svc, a, outside, person, rx, fill, exp = case
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Test Plan"])
    label_job = LabelPrintService(svc).list(a["PHARMACIST"], fill)[0]
    LabelPrintService(svc).record_output_attempt(
        a["PHARMACIST"], label_job["id"], "TEST-PRINT-ATTEMPT-AUDIT",
        "Sent a synthetic label to the local demonstration print dialog",
        dialog_accepted=True)
    result = FillClaimReview(svc).detail(a["AUDITOR"], fill)
    first = result["labels"][0]["print_job"]
    assert first["test_output_attempted"] is True
    assert first["output_events"][0]["event_kind"] == "NATIVE_DIALOG_ACCEPTED"
    assert first["output_events"][0]["hardware_success_confirmed"] is False
    assert result["warnings"]


def test_prepared_claim_and_print_integrity_checks_reject_tampering(case):
    svc, a, outside, person, rx, fill, exp = case
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Test Plan"])
    viewer = FillClaimReview(svc)
    with svc.sessions.begin() as s:
        tx = s.scalar(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.fill_id == fill,
            SandboxClaimTransaction.operation == "BILL"))
        original = tx.request_json
        tx.request_json = '{"product":"invented"}'
    with pytest.raises(WorkflowError, match="integrity"):
        viewer.detail(a["AUDITOR"], fill)
    with svc.sessions.begin() as s:
        tx = s.scalar(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.fill_id == fill,
            SandboxClaimTransaction.operation == "BILL"))
        tx.request_json = original
        job = s.scalar(select(LabelPrintJob).where(LabelPrintJob.fill_id == fill))
        previous = job.snapshot_json
        job.snapshot_json = '{"fake":"reprint"}'
    with pytest.raises(WorkflowError, match="checksum"):
        viewer.detail(a["AUDITOR"], fill)
    with svc.sessions.begin() as s:
        job = s.scalar(select(LabelPrintJob).where(LabelPrintJob.fill_id == fill))
        job.snapshot_json = previous
    assert len(viewer.detail(a["AUDITOR"], fill)["labels"]) == 2


def test_unbilled_product_fill_and_site_isolation_api(case):
    svc, a, outside, person, rx, fill, exp = case
    reviewer = FillClaimReview(svc)
    empty = reviewer.detail(a["AUDITOR"], fill)
    assert empty["claims"] == [] and empty["labels"] == []
    with pytest.raises(WorkflowError):
        reviewer.detail(outside["AUDITOR"], fill)
    live_off = TestClient(create_app(svc, synthetic_enabled=False))
    enabled = TestClient(create_app(svc, synthetic_enabled=True))
    route = f"/api/fills/{fill}/claims"
    headers = {"x-demo-staff-id": a["AUDITOR"].id}
    assert live_off.get(route, headers=headers).status_code == 503
    assert enabled.get(route).status_code == 403
    assert enabled.get(route, headers=headers).status_code == 200
    assert enabled.get(route, headers={"x-demo-staff-id": outside["AUDITOR"].id}).status_code == 409


def test_unlinked_simulated_rejection_is_listed_without_payer_approval(case):
    svc, a, outside, patient, rx, fill, exp = case
    directory = InsuranceDirectory(svc)
    payer = directory.create_payer(a["PHARMACIST"], "Development payer")
    coverage = directory.upsert_coverage(
        a["PHARMACIST"], patient, 1, payer, "NOT-REAL-1234")
    rejected = SandboxClaimService(svc).inject_rejection(
        a["PHARMACIST"], fill, coverage, "TEST_79",
        "AUDIT-REJECT-12345", "Synthetic refill too soon rejection test")
    detail = FillClaimReview(svc).detail(a["AUDITOR"], fill)
    assert detail["claims"] == [] and detail["labels"] == []
    assert len(detail["standalone_test_events"]) == 1
    assert detail["standalone_test_events"][0]["id"] == rejected
    assert detail["standalone_test_events"][0]["operation"] == "TEST_REJECT"
    assert detail["standalone_test_events"][0]["real_payment_or_patient_responsibility"] is False


def test_three_attempt_rebill_lineage_from_every_generation(case):
    svc, a, outside, person, rx, first, exp = case
    rebill = ClaimRebillService(svc)
    svc.prepare_for_review(a["TECHNICIAN"], first, ["Test Plan"])
    middle = rebill.restart(
        a["PHARMACIST"], first,
        "First synthetic correction of scanned manufacturer before verification",
        expected_claim_ids=_ids(svc, first))["replacement_fill_id"]
    svc.scan_source(a["TECHNICIAN"], middle, "AUDIT-CODE-2",
                    "AUDIT-LOT-2", exp, "90")
    svc.prepare_for_review(a["TECHNICIAN"], middle, ["Test Plan"])
    last = rebill.restart(
        a["PHARMACIST"], middle,
        "Second manufacturer correction still required full source rescan",
        expected_claim_ids=_ids(svc, middle))["replacement_fill_id"]
    for fid in (first, middle, last):
        lineage = rebill.lineage(a["AUDITOR"], fid)
        assert lineage["fill_id"] == fid
        assert lineage["root_fill_id"] == first
        assert lineage["latest_fill_id"] == last
        assert [(x["original_fill_id"], x["replacement_fill_id"])
                for x in lineage["links"]] == [(first, middle), (middle, last)]
        assert [x["fill_id"] for x in lineage["attempts"]] == [first, middle, last]
        assert [x["attempt"] for x in lineage["attempts"]] == [1, 2, 3]
        assert [x["status"] for x in lineage["attempts"]] == [
            "RETURNED", "RETURNED", "PRODUCT_FILL"]
    svc.scan_source(a["TECHNICIAN"], last, "AUDIT-CODE-1",
                    "AUDIT-LOT-1", exp, "90")
    svc.prepare_for_review(a["TECHNICIAN"], last, ["Test Plan"])
    svc.verify(a["PHARMACIST"], last)
    with svc.sessions() as s:
        assert len(s.scalars(select(Claim).where(Claim.fill_id == first)).all()) == 1
        assert len(s.scalars(select(Claim).where(Claim.fill_id == middle)).all()) == 1
        assert len(s.scalars(select(Claim).where(Claim.fill_id == last)).all()) == 1
    assert rebill.lineage(a["AUDITOR"], first)["attempts"][-1]["status"] == "READY"
