"""Increment 46: transaction-selected single-payer synthetic reversal/rescan safety."""
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
from pharmacy1os.label_printing import LabelPrintService
from pharmacy1os.models import Audit, Claim, Fill, Label, Prescription, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def demo():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    drug = svc.add_drug(pharm, "Transaction reversal demo", "10mg", "tablet")
    product = svc.add_product(pharm, drug, "66666-0808-01", "Synthetic", "White test tablet")
    svc.register_barcode(tech, product, "REVERSE-TXN-BC")
    expiry = (date.today() + timedelta(days=300)).isoformat()
    stock = svc.receive(tech, "REVERSE-TXN-BC", "SYN-REVERSE-LOT", expiry, "100")
    patient = svc.add_patient(tech, "Reversal", "Test")
    prescriber = svc.add_prescriber(tech, "Reversal", "Physician", "MD")
    rx = svc.add_prescription(tech, patient, prescriber, drug,
                              "TXN-REVERSAL-RX", "one daily", "40")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, days_supply=30)
    svc.scan_source(tech, fill, "REVERSE-TXN-BC", "SYN-REVERSE-LOT", expiry, "40")
    return svc, a, outside, rx, fill, stock, expiry


def _billed(demo, names=("Synthetic Payer",)):
    svc, a, outside, rx, fill, stock, exp = demo
    svc.prepare_for_review(a["TECHNICIAN"], fill, list(names))
    txs = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    bills = [tx for tx in txs if tx["operation"] == "BILL"]
    return bills


def test_reverse_by_transaction_and_idempotent_replay_preserves_claim_and_label_history(demo):
    svc, a, outside, rx, fill, stock, exp = demo
    bill = _billed(demo)[0]
    subject = ClaimRebillService(svc)
    reason = "Incorrect synthetic payer claim requires fresh manufacturer scanning"
    result = subject.reverse_single_transaction(a["PHARMACIST"], bill["id"],
        reason, expected_claim_id=bill["claim_id"])
    new_id = result["replacement_fill_id"]
    assert result["replayed"] is False and new_id != fill
    assert result["original_transaction_id"] == bill["id"]
    assert result["reversal_transaction_id"] != bill["id"]
    assert result["requires_fresh_scans"]
    assert result["external_payer_contact"] is False
    assert svc.scanned_sources(a["TECHNICIAN"], new_id) == []
    history = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    assert [x["operation"] for x in history] == ["BILL", "REVERSE"]
    assert history[1]["id"] == result["reversal_transaction_id"]
    assert history[1]["original_transaction_id"] == bill["id"]
    assert len(BillingService(svc).history(a["AUDITOR"], fill)) == 2
    labels = LabelPrintService(svc).list(a["AUDITOR"], fill)
    assert len(labels) == 1 and labels[0]["status"] == "VOIDED"
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "RETURNED"
        assert s.get(Fill, new_id).status == "PRODUCT_FILL"
        assert s.get(Prescription, rx).status == "PRODUCT_FILL"
        assert s.get(Stock, stock).reserved == Decimal("0")
        assert s.get(Stock, stock).on_hand == Decimal("100")
        assert s.scalars(select(Label).where(Label.fill_id == fill)).all()
        assert s.scalars(select(Claim).where(Claim.fill_id == new_id)).all() == []
        assert s.scalar(select(Audit.id).where(Audit.kind ==
            "SYNTHETIC_SINGLE_PAYER_CLAIM_REVERSED")) is not None
    replay = subject.reverse_single_transaction(a["PHARMACIST"], bill["id"],
        "Retry of an already processed synthetic claim reversal",
        expected_claim_id=bill["claim_id"])
    assert replay["replayed"] is True
    assert replay["replacement_fill_id"] == new_id
    assert replay["reversal_transaction_id"] == result["reversal_transaction_id"]
    with svc.sessions() as s:
        assert len(s.scalars(select(SyntheticRebillLink)).all()) == 1
        assert len(s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "REVERSE")).all()) == 1
    # Newly scanned fill still requires a completely new claim and verification.
    svc.scan_source(a["TECHNICIAN"], new_id, "REVERSE-TXN-BC",
                    "SYN-REVERSE-LOT", exp, "40")
    svc.prepare_for_review(a["TECHNICIAN"], new_id, ["Synthetic Payer"])
    svc.verify(a["PHARMACIST"], new_id)
    assert subject.reverse_single_transaction(a["PHARMACIST"], bill["id"],
        "Repeated request must not tamper with already reversed original history",
        expected_claim_id=bill["claim_id"])["replayed"] is True


def test_reverse_blocks_multiple_cob_and_preserves_every_paid_position(demo):
    svc, a, outside, rx, fill, stock, exp = demo
    bills = _billed(demo, ("Primary", "Secondary"))
    with pytest.raises(WorkflowError, match="Multiple payer COB"):
        ClaimRebillService(svc).reverse_single_transaction(
            a["PHARMACIST"], bills[-1]["id"],
            "One of two coordination of benefit positions needs complete reversal",
            expected_claim_id=bills[-1]["claim_id"])
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert [c.status for c in s.scalars(select(Claim).order_by(Claim.sequence))] == [
            "PAID_SYNTHETIC", "PAID_SYNTHETIC"]
        assert s.get(Stock, stock).reserved == Decimal("40")
        assert s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "REVERSE")).all() == []
    # Batch reversal remains available for COB chains (highest-to-lowest ordering
    # is a future parity item; synthetic operation here is one DB transaction).
    result = ClaimRebillService(svc).restart(a["PHARMACIST"], fill,
        "Restart both synthetic payers for correction before verification",
        expected_claim_ids=[b["claim_id"] for b in bills])
    assert len(result["reversed_claim_ids"]) == 2


def test_reverse_guards_site_roles_stale_claim_bad_transaction_and_prior_print(demo):
    svc, a, outside, rx, fill, stock, exp = demo
    bill = _billed(demo)[0]
    subject = ClaimRebillService(svc)
    note = "Documented wrong synthetic claim requiring new physical rescan"
    with pytest.raises(AccessDenied):
        subject.reverse_single_transaction(a["TECHNICIAN"], bill["id"], note,
                                           expected_claim_id=bill["claim_id"])
    with pytest.raises(WorkflowError, match="not found at pharmacy"):
        subject.reverse_single_transaction(outside["PHARMACIST"], bill["id"], note,
                                           expected_claim_id=bill["claim_id"])
    with pytest.raises(WorkflowError, match="expected single payer claim"):
        subject.reverse_single_transaction(a["PHARMACIST"], bill["id"], note,
                                           expected_claim_id="stale-claim")
    with pytest.raises(WorkflowError, match="not found at pharmacy"):
        subject.reverse_single_transaction(a["PHARMACIST"], "not-a-bill", note,
                                           expected_claim_id=bill["claim_id"])
    with pytest.raises(WorkflowError, match="12-1000"):
        subject.reverse_single_transaction(a["PHARMACIST"], bill["id"], "no",
                                           expected_claim_id=bill["claim_id"])
    print_job = LabelPrintService(svc).list(a["PHARMACIST"], fill)[0]
    LabelPrintService(svc).record_output_attempt(a["PHARMACIST"],
        print_job["id"], "REVERSAL-TEST-PRINT", "Test dialog accepted prior to correction",
        dialog_accepted=True)
    with pytest.raises(WorkflowError, match="printed test labels"):
        subject.reverse_single_transaction(a["PHARMACIST"], bill["id"], note,
                                           expected_claim_id=bill["claim_id"])
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.get(Stock, stock).reserved == 40


def test_reverse_rejects_tampered_paid_request_and_does_not_alter_ledger(demo):
    svc, a, outside, rx, fill, stock, exp = demo
    bill = _billed(demo)[0]
    with svc.sessions.begin() as s:
        tx = s.get(SandboxClaimTransaction, bill["id"])
        tx.request_json = '{"forged":"changed"}'
    with pytest.raises(WorkflowError, match="integrity"):
        ClaimRebillService(svc).reverse_single_transaction(
            a["PHARMACIST"], bill["id"],
            "Do not accept tampered immutable original payer evidence",
            expected_claim_id=bill["claim_id"])
    with svc.sessions() as s:
        assert s.get(Stock, stock).reserved == 40
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "REVERSE")).all() == []


def test_reverse_rolls_back_if_replacement_fill_cannot_start(demo):
    svc, a, outside, rx, fill, stock, exp = demo
    bill = _billed(demo)[0]
    with patch.object(svc, "_start_fill_tx",
            side_effect=WorkflowError("Forced test failure after reversal")):
        with pytest.raises(WorkflowError, match="Forced test failure"):
            ClaimRebillService(svc).reverse_single_transaction(a["PHARMACIST"],
                bill["id"], "Rollback synthetic single-payer correction on failure",
                expected_claim_id=bill["claim_id"])
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.get(Stock, stock).reserved == 40
        assert all(c.status == "PAID_SYNTHETIC" for c in s.scalars(select(Claim)))
        assert s.scalars(select(SyntheticRebillLink)).all() == []
        assert s.scalar(select(SandboxClaimTransaction.id).where(
            SandboxClaimTransaction.operation == "REVERSE")) is None


def test_api_idempotent_reversal_and_demo_mode_only(demo):
    svc, a, outside, rx, fill, stock, exp = demo
    bill = _billed(demo)[0]
    path = f"/api/third-party/claims/{bill['id']}/reverse"
    payload = {
        "expected_claim_id": bill["claim_id"],
        "reason": "Wrong mock insurance claim must be reversed and independently rescanned",
    }
    enabled = TestClient(create_app(svc, synthetic_enabled=True))
    off = TestClient(create_app(svc, synthetic_enabled=False))
    assert off.post(path, headers={"x-demo-staff-id": a["PHARMACIST"].id},
                    json=payload).status_code == 503
    assert enabled.post(path, json=payload).status_code == 403
    assert enabled.post(path, headers={"x-demo-staff-id": a["TECHNICIAN"].id},
                        json=payload).status_code == 403
    assert enabled.post(path, headers={"x-demo-staff-id": outside["PHARMACIST"].id},
                        json=payload).status_code == 409
    assert enabled.post(path, headers={"x-demo-staff-id": a["PHARMACIST"].id},
                        json={**payload, "expected_claim_id": ""}).status_code == 422
    first = enabled.post(path, headers={"x-demo-staff-id": a["PHARMACIST"].id},
                         json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["replayed"] is False
    repeat = enabled.post(path, headers={"x-demo-staff-id": a["PHARMACIST"].id},
                          json=payload)
    assert repeat.status_code == 200 and repeat.json()["replayed"] is True
    assert repeat.json()["reversal_transaction_id"] == first.json()["reversal_transaction_id"]
