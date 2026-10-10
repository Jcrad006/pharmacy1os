"""Claim reversal and fresh-rescan replacement preserve synthetic history and stock."""
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
from pharmacy1os.fill_completion import FillObligation
from pharmacy1os.inventory_allocations import InventoryAllocationService
from pharmacy1os.inventory_locations import InventoryLocationService
from pharmacy1os.label_printing import LabelPrintEvent, LabelPrintJob, LabelPrintService
from pharmacy1os.models import Audit, Claim, Fill, FillSource, Label, Prescription, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    drug = svc.add_drug(pharm, "Test rebill product", "5mg", "tablet")
    expiry = (date.today() + timedelta(days=300)).isoformat()
    for index in (1, 2):
        pid = svc.add_product(pharm, drug, f"40000-8000{index}-09",
                              f"Synthetic Mfg {index}", f"Synthetic {index}")
        svc.register_barcode(tech, pid, f"RESTART-BAR-{index}")
        svc.receive(tech, f"RESTART-BAR-{index}", f"LOT-RESTART-{index}", expiry, "100")
    person = svc.add_patient(tech, "Synthetic", "Rebill")
    prescriber = svc.add_prescriber(tech, "Demo", "RebillDoctor", "MD")
    rx = svc.add_prescription(tech, person, prescriber, drug,
        "RESTART-RX-001", "Take once per day", "90", refills=0)
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, "90", days_supply=30)
    svc.scan_source(tech, fill, "RESTART-BAR-1", "LOT-RESTART-1", expiry, "65")
    svc.scan_source(tech, fill, "RESTART-BAR-2", "LOT-RESTART-2", expiry, "25")
    return svc, a, outside, rx, fill, expiry


def original_claim_ids(svc, fill_id):
    with svc.sessions() as s:
        return [c.id for c in s.scalars(select(Claim).where(
            Claim.fill_id == fill_id).order_by(Claim.sequence)).all()]


def prepare(case, payers=None):
    svc, a, outside, rx, fill, expiry = case
    svc.prepare_for_review(a["TECHNICIAN"], fill, payers or ["Synthetic A", "Synthetic B"])
    return original_claim_ids(svc, fill)


def test_rebill_restarts_new_attempt_without_reusing_paid_claims_or_labels(case):
    svc, a, outside, rx, fill, expiry = case
    original_ids = prepare(case)
    old_jobs = LabelPrintService(svc).list(a["PHARMACIST"], fill)
    assert len(old_jobs) == 2
    result = ClaimRebillService(svc).restart(a["PHARMACIST"], fill,
        "Wrong billed manufacturer discovered before pharmacist verification",
        expected_claim_ids=original_ids)
    new_id = result["replacement_fill_id"]
    assert result["reversed_claim_ids"] == original_ids
    assert result["fill_number"] == 0 and result["replacement_attempt"] == 2
    assert result["requires_fresh_scans"] and result["requires_new_claim_preparation"]
    assert result["payer_intended_quantity"] == "90.000"
    assert new_id != fill
    assert svc.scanned_sources(a["TECHNICIAN"], new_id) == []
    assert all(x["status"] == "VOIDED" for x in LabelPrintService(svc).list(a["TECHNICIAN"], fill))
    assert len(LabelPrintService(svc).list(a["TECHNICIAN"], new_id)) == 0
    old_tx = SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
    assert [x["operation"] for x in old_tx] == ["BILL", "BILL", "REVERSE", "REVERSE"]
    assert {x["claim_id"] for x in old_tx} == set(original_ids)
    assert all(x["original_transaction_id"] for x in old_tx[2:])
    ops = BillingService(svc).history(a["AUDITOR"], fill)
    assert len(ops) == 4
    assert all(x["billed_quantity"] == "90.000" for x in ops)
    assert {x["operation"] for x in ops} == {"SYNTHETIC_PAID", "SYNTHETIC_REVERSED"}
    lineage = ClaimRebillService(svc).lineage(a["AUDITOR"], new_id)["links"]
    assert len(lineage) == 1 and lineage[0]["original_fill_id"] == fill
    assert lineage[0]["reversed_claim_ids"] == original_ids
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "RETURNED"
        fresh = s.get(Fill, new_id)
        assert fresh.status == "PRODUCT_FILL"
        assert fresh.days_supply == 30 and fresh.billing_product_id is None
        assert s.get(Prescription, rx).status == "PRODUCT_FILL"
        assert [x.status for x in s.scalars(select(Claim).where(Claim.fill_id == fill))] == [
            "REVERSED_SYNTHETIC", "REVERSED_SYNTHETIC"]
        assert all(x.reserved == 0 for x in s.scalars(select(Stock)).all())
        assert s.scalars(select(Claim).where(Claim.fill_id == new_id)).all() == []
        assert s.scalars(select(Label).where(Label.fill_id == fill)).all()
        assert s.scalar(select(Audit.id).where(
            Audit.kind == "SYNTHETIC_REBILL_RESTARTED")) is not None
    # New majority product can differ; original payer snapshots remain immutable.
    svc.scan_source(a["TECHNICIAN"], new_id, "RESTART-BAR-2", "LOT-RESTART-2", expiry, "90")
    svc.prepare_for_review(a["TECHNICIAN"], new_id, ["Synthetic A"])
    new_ids = original_claim_ids(svc, new_id)
    assert len(new_ids) == 1 and new_ids[0] not in original_ids
    assert BillingService(svc).history(a["AUDITOR"], new_id)[0]["selected_ndc"] == "40000-80002-09"
    svc.verify(a["PHARMACIST"], new_id)
    with svc.sessions() as s:
        assert s.get(Fill, new_id).status == "READY"
        assert s.get(Prescription, rx).refills_used == 0


def test_partial_quantity_is_physical_while_entire_authorization_is_rebilled(case):
    svc, a, outside, rx, fill, expiry = case
    # New original partial at Product Fill; the previous reserved source total is 90.
    # This fixture replaces one source to get 60 physically scanned units.
    sources = svc.scanned_sources(a["TECHNICIAN"], fill)
    svc.correct_scanned_source_quantity(a["TECHNICIAN"], fill, sources[0]["id"], "40",
        "Recount physical manufacturer quantity from sixty-five to forty units")
    svc.correct_scanned_source_quantity(a["TECHNICIAN"], fill, sources[1]["id"], "20",
        "Recount physical manufacturer quantity from twenty-five to twenty")
    with svc.sessions.begin() as s:
        old = s.get(Fill, fill)
        old.quantity = Decimal("60")
        s.add(FillObligation(site_id=a["TECHNICIAN"].site_id,
            prescription_id=rx, anchor_fill_id=fill, intended=Decimal("90"),
            remaining=Decimal("90"), dispensed=Decimal("0"), status="OPEN"))
    ids = prepare(case, ["Synthetic A"])
    result = ClaimRebillService(svc).restart(a["PHARMACIST"], fill,
        "Original synthetic partial insurance billed manufacturer incorrectly",
        expected_claim_ids=ids)
    new_id = result["replacement_fill_id"]
    assert result["physical_quantity"] == "60.000"
    assert result["payer_intended_quantity"] == "90.000"
    with svc.sessions() as s:
        obligations = s.scalars(select(FillObligation).order_by(
            FillObligation.anchor_fill_id)).all()
        assert len(obligations) == 2
        assert {x.status for x in obligations} == {"VOID_UNSOLD", "OPEN"}
        assert s.get(Fill, new_id).billed_quantity == Decimal("90")
        assert s.get(Fill, new_id).quantity == Decimal("60")


def test_tracked_bin_reservation_and_allocation_are_released(case):
    svc, a, outside, rx, fill, expiry = case
    # The existing scan occurred before location tracking; use a different fresh Rx
    # to verify that tracked allocations release from their actual physical bin.
    tech, pharm = a["TECHNICIAN"], a["PHARMACIST"]
    with svc.sessions() as s:
        stock_id = s.scalar(select(Stock.id).where(Stock.lot == "LOT-RESTART-1"))
    # Existing reservations prevent tracking activation, so remove and then enable.
    old = svc.scanned_sources(tech, fill)
    for source in old:
        svc.remove_scanned_source(tech, fill, source["id"],
            "Reconfigure synthetic physical lot picking workflow before rescan")
    locs = InventoryLocationService(svc)
    a_loc = locs.create(pharm, "RE-A", "Receiving stock shelf", "SHELF")
    b_loc = locs.create(pharm, "RE-B", "Active dispensing bin", "BIN")
    locs.activate_stock(pharm, stock_id, a_loc,
        "Physically counted all one hundred source units before location activation")
    locs.move(tech, stock_id, a_loc, b_loc, "80",
        "Transfer eighty units into synthetic dispensing bin")
    svc.scan_source(tech, fill, "RESTART-BAR-1", "LOT-RESTART-1", expiry, "65",
        location_id=b_loc)
    svc.scan_source(tech, fill, "RESTART-BAR-2", "LOT-RESTART-2", expiry, "25")
    ids = prepare(case, ["Synthetic A"])
    ClaimRebillService(svc).restart(pharm, fill,
        "Incorrect synthetic billing source needs fresh verified scans",
        expected_claim_ids=ids)
    allocs = InventoryAllocationService(svc).for_fill(tech, fill)
    assert len(allocs) == 1
    assert allocs[0]["status"] == "RELEASED"
    assert [e["to"] for e in allocs[0]["events"]] == ["ACTIVE", "RELEASED"]
    pos = next(p for p in locs.positions(tech, stock_id) if p["location_id"] == b_loc)
    assert pos["reserved"] == "0.000"
    assert pos["available"] == "80.000"


def test_guards_replay_stale_claims_cross_site_and_print_attempt(case):
    svc, a, outside, rx, fill, expiry = case
    ids = prepare(case)
    rebill = ClaimRebillService(svc)
    note = "Incorrect synthetic claim selection needs documented correction"
    with pytest.raises(AccessDenied):
        rebill.restart(a["TECHNICIAN"], fill, note, expected_claim_ids=ids)
    with pytest.raises(WorkflowError, match="outside"):
        rebill.restart(outside["PHARMACIST"], fill, note, expected_claim_ids=ids)
    with pytest.raises(WorkflowError, match="changed"):
        rebill.restart(a["PHARMACIST"], fill, note,
            expected_claim_ids=list(reversed(ids)))
    with pytest.raises(WorkflowError, match="unique expected"):
        rebill.restart(a["PHARMACIST"], fill, note, expected_claim_ids=[ids[0], ids[0]])
    with pytest.raises(WorkflowError, match="12"):
        rebill.restart(a["PHARMACIST"], fill, "short", expected_claim_ids=ids)
    job = LabelPrintService(svc).list(a["PHARMACIST"], fill)[0]
    with svc.sessions.begin() as s:
        s.add(LabelPrintEvent(site_id=a["PHARMACIST"].site_id,
            print_job_id=job["id"], request_key="TEST-SPOOL-001",
            event_kind="NATIVE_DIALOG_ACCEPTED", note="Printed synthetic copy",
            actor_id=a["PHARMACIST"].id))
    with pytest.raises(WorkflowError, match="printed test labels"):
        rebill.restart(a["PHARMACIST"], fill, note, expected_claim_ids=ids)
    with svc.sessions.begin() as s:
        e = s.scalar(select(LabelPrintEvent).where(
            LabelPrintEvent.request_key == "TEST-SPOOL-001"))
        s.delete(e)
    result = rebill.restart(a["PHARMACIST"], fill, note, expected_claim_ids=ids)
    with pytest.raises(WorkflowError, match="pre-verification"):
        rebill.restart(a["PHARMACIST"], fill, note, expected_claim_ids=ids)
    with svc.sessions() as s:
        assert len(s.scalars(select(SyntheticRebillLink)).all()) == 1
        assert len(s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.operation == "REVERSE")).all()) == 2
    with pytest.raises(WorkflowError):
        rebill.lineage(outside["AUDITOR"], result["replacement_fill_id"])


def test_restart_atomic_rollback_if_new_fill_cannot_start(case):
    svc, a, outside, rx, fill, expiry = case
    ids = prepare(case, ["Synthetic A"])
    with patch.object(svc, "_start_fill_tx", side_effect=WorkflowError(
            "Simulated new attempt failure after reversal and stock release")):
        with pytest.raises(WorkflowError, match="Simulated new attempt"):
            ClaimRebillService(svc).restart(a["PHARMACIST"], fill,
                "Test atomicity of an unexpected replacement preparation failure",
                expected_claim_ids=ids)
    with svc.sessions() as s:
        assert s.get(Fill, fill).status == "PHARMACIST_REVIEW"
        assert s.get(Prescription, rx).status == "PHARMACIST_REVIEW"
        assert s.scalars(select(SyntheticRebillLink)).all() == []
        assert all(x.status == "PAID_SYNTHETIC" for x in s.scalars(select(Claim)).all())
        assert sum((x.reserved for x in s.scalars(select(Stock)).all()), Decimal("0")) == 90
        assert all(job.status == "QUEUED" for job in s.scalars(select(LabelPrintJob)))
        assert s.scalar(select(SandboxClaimTransaction.id).where(
            SandboxClaimTransaction.operation == "REVERSE")) is None


def test_api_is_synthetic_only_and_requires_fresh_claim_ids(case):
    svc, a, outside, rx, fill, expiry = case
    ids = prepare(case, ["Synthetic A"])
    cli = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    path = f"/api/billing/fills/{fill}/restart-for-rebill"
    payload = {"reason": "Correct incorrect test billing source before verification",
               "expected_claim_ids": ids}
    pharm = {"x-demo-staff-id": a["PHARMACIST"].id}
    assert disabled.post(path, headers=pharm, json=payload).status_code == 503
    assert cli.post(path, json=payload).status_code == 403
    assert cli.post(path, headers={"x-demo-staff-id": a["TECHNICIAN"].id},
                    json=payload).status_code == 403
    assert cli.post(path, headers={"x-demo-staff-id": outside["PHARMACIST"].id},
                    json=payload).status_code == 409
    assert cli.post(path, headers=pharm, json={
        "reason": payload["reason"], "expected_claim_ids": []
    }).status_code == 422
    response = cli.post(path, headers=pharm, json=payload)
    assert response.status_code == 200, response.text
    new_id = response.json()["replacement_fill_id"]
    detail = cli.get(f"/api/billing/fills/{new_id}/rebill-lineage",
                     headers={"x-demo-staff-id": a["AUDITOR"].id})
    assert detail.status_code == 200
    assert detail.json()["links"][0]["original_fill_id"] == fill
