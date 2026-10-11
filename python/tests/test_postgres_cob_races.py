"""PostgreSQL-specific cross-workstation competing-operation safety regressions.

Run only against disposable migrated PostgreSQL CI database, never real PHI.
"""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Barrier

import pytest
from sqlalchemy import select

from pharmacy1os.claim_rebilling import ClaimRebillService, SyntheticRebillLink
from pharmacy1os.cob_attempts import CobAttemptRegistry
from pharmacy1os.cob_selective_correction import SyntheticCobCorrectionService
from pharmacy1os.db_cli import revision_at_head
from pharmacy1os.models import Claim, Fill, FillSource, Prescription, Stock
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def scenario(request):
    # The demo model enforces globally unique NDCs and barcodes across sites.
    suffix = "1" if "verify_vs_full" in request.node.name else "2"
    ndc = "99061-3333-2" + suffix
    barcode = "INC61-TEST-BAR-" + suffix
    url = os.getenv("PHARMACY1OS_PG_CI_URL")
    if not url:
        pytest.skip("Requires a disposable migrated PostgreSQL CI service")
    if not url.startswith("postgresql+psycopg://"):
        pytest.fail("Concurrency smoke requires PostgreSQL + psycopg")
    svc = PharmacyService(url)
    try:
        assert revision_at_head(svc.engine)
        a = svc.bootstrap_demo()["actors"]
        tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
        person = svc.add_patient(tech, "Simulated", "MultiWorkstation")
        prescriber = svc.add_prescriber(tech, "Simulated", "Prescriber", "MD")
        drug = svc.add_drug(pharm, "Increment 61 synthetic concurrency", "2 mg", "tablet")
        product = svc.add_product(pharm, drug, ndc,
                                  "Local test manufacturer", "Mock pills")
        svc.register_barcode(tech, product, barcode)
        expiry = (date.today() + timedelta(days=200)).isoformat()
        stock = svc.receive(tech, barcode, "INC61-LOT", expiry, "100")
        rx = svc.add_prescription(tech, person, prescriber, drug,
            "INC61-CI-RX", "One synthetic tablet daily", "50")
        svc.advance_to_dur(tech, rx)
        fill = svc.start_fill(tech, rx, days_supply=50)
        svc.scan_source(tech, fill, barcode, "INC61-LOT", expiry, "50")
        svc.prepare_for_review(tech, fill, ["Test Primary", "Test Secondary", "Test Third"])
        yield svc, a, rx, fill, stock, expiry, ndc
    finally:
        svc.engine.dispose()


def _current_ids(svc, actor, fill):
    ledger = CobAttemptRegistry(svc).history(actor, fill)
    return [p["attempts"][-1]["paid_transaction_id"]
            for p in reversed(ledger["claim_positions"])]


def test_pg_verify_vs_full_reversal_cannot_both_win(scenario):
    """Pharmacist verification vs cancellation/rebill races for the same reserved stock."""
    svc, a, rx, fill, stock, expiry, ndc = scenario
    pharmacist = a["PHARMACIST"]
    expected = _current_ids(svc, pharmacist, fill)
    barrier = Barrier(2)

    def verify():
        barrier.wait(timeout=20)
        try:
            svc.verify(pharmacist, fill)
            return ("verified", None)
        except WorkflowError as exc:
            return ("blocked", str(exc))

    def reverse():
        barrier.wait(timeout=20)
        try:
            outcome = ClaimRebillService(svc).reverse_current_cob(
                pharmacist, fill,
                "Pharmacist reverses a competing locally simulated COB chain for rescan",
                expected_active_paid_transaction_ids=expected)
            return ("reversed", outcome)
        except WorkflowError as exc:
            return ("blocked", str(exc))

    with ThreadPoolExecutor(max_workers=2) as pool:
        future_verify = pool.submit(verify)
        future_reverse = pool.submit(reverse)
        v, r = future_verify.result(timeout=60), future_reverse.result(timeout=60)
    assert sorted([v[0], r[0]]) in (
        ["blocked", "reversed"], ["blocked", "verified"]), (v, r)
    with svc.sessions() as s:
        original = s.get(Fill, fill)
        inventory = s.get(Stock, stock)
        links = s.scalars(select(SyntheticRebillLink).where(
            SyntheticRebillLink.original_fill_id == fill)).all()
        assert inventory.reserved == 0
        assert len(links) == (1 if r[0] == "reversed" else 0)
        if v[0] == "verified":
            assert original.status == "READY"
            assert s.get(Prescription, rx).status == "READY"
            assert inventory.on_hand == 50
        else:
            assert original.status == "RETURNED"
            assert inventory.on_hand == 100
            replacement = s.get(Fill, r[1]["replacement_fill_id"])
            assert replacement.status == "PRODUCT_FILL"
            assert s.scalars(select(FillSource).where(
                FillSource.fill_id == replacement.id)).all() == []
            assert s.scalars(select(Claim).where(
                Claim.fill_id == replacement.id)).all() == []
    old_ledger = CobAttemptRegistry(svc).history(pharmacist, fill)
    assert old_ledger["active_local_paid_positions"] == (3 if v[0] == "verified" else 0)


def test_pg_selective_correction_vs_full_reverse_rejects_stale_operator(scenario):
    """Different workstation commands use the same fill lock and current paid IDs."""
    svc, a, rx, fill, stock, expiry, ndc = scenario
    pharmacist = a["PHARMACIST"]
    initial = CobAttemptRegistry(svc).history(pharmacist, fill)
    full_ids = _current_ids(svc, pharmacist, fill)
    suffix_ids = [p["attempts"][-1]["paid_transaction_id"] for p in
                  reversed(initial["claim_positions"][1:])]
    barrier = Barrier(2)

    def correct():
        barrier.wait(timeout=20)
        try:
            result = SyntheticCobCorrectionService(svc).correct(
                pharmacist, fill,
                "Second payer simulated NDC reprocessing while another operator requests reversal",
                target_position=2, expected_active_paid_transaction_ids=suffix_ids,
                corrected_billing_ndc=ndc)
            return ("corrected", result)
        except WorkflowError as exc:
            return ("blocked", str(exc))

    def reverse():
        barrier.wait(timeout=20)
        try:
            result = ClaimRebillService(svc).reverse_current_cob(
                pharmacist, fill,
                "Reverse three mock payers while another pharmacist edits secondary COB",
                expected_active_paid_transaction_ids=full_ids)
            return ("reversed", result)
        except WorkflowError as exc:
            return ("blocked", str(exc))

    with ThreadPoolExecutor(max_workers=2) as pool:
        c_future = pool.submit(correct)
        r_future = pool.submit(reverse)
        c, r = c_future.result(timeout=60), r_future.result(timeout=60)
    assert sorted([c[0], r[0]]) in (
        ["blocked", "corrected"], ["blocked", "reversed"]), (c, r)
    latest = CobAttemptRegistry(svc).history(pharmacist, fill)
    with svc.sessions() as s:
        f = s.get(Fill, fill)
        rx_row = s.get(Prescription, rx)
        st = s.get(Stock, stock)
        link = s.scalar(select(SyntheticRebillLink).where(
            SyntheticRebillLink.original_fill_id == fill))
        if c[0] == "corrected":
            assert f.status == rx_row.status == "PHARMACIST_REVIEW"
            assert link is None
            assert st.on_hand == 100 and st.reserved == 50
            assert latest["total_attempts"] == 5
            assert latest["active_local_paid_positions"] == 3
            assert [len(p["attempts"]) for p in latest["claim_positions"]] == [1, 2, 2]
        else:
            assert f.status == "RETURNED" and rx_row.status == "PRODUCT_FILL"
            assert link is not None and link.replacement_fill_id == r[1]["replacement_fill_id"]
            assert st.on_hand == 100 and st.reserved == 0
            assert latest["total_attempts"] == 3
            assert latest["active_local_paid_positions"] == 0
            assert s.scalars(select(FillSource).where(
                FillSource.fill_id == link.replacement_fill_id)).all() == []
