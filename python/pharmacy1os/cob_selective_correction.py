"""Atomic selective COB reversal/resubmission for *local synthetic claims only*.

A pharmacist may correct a previously paid payer position and all downstream
positions. Every suffix reversal and new simulated payment is one DB
transaction. There is no claim switch, remote payer, real money, print or
physical stock mutation. Legacy ClaimOperation is the original snapshot;
new payer attempts are in the immutable versioned COB ledger.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date
from typing import Any

from sqlalchemy import select

from .claim_transactions import _record, _view, require_no_open_test_rejections
from .claim_transactions_models import SandboxClaimTransaction
from .cob_attempts import (
    CobAttemptRegistry, SyntheticCobAttempt,
    append_paid_correction_tx, mirror_reversal_tx,
)
from .claim_rebilling import SyntheticRebillLink
from .emergency_supply import EmergencySupply
from .fill_completion import FillCompletion
from .label_printing import LabelPrintEvent, LabelPrintJob
from .models import Claim, Fill, FillSource, Label, Prescription, Product, Stock
from .product_selection import require_fill_sources_eligible
from .service import Actor, PharmacyService, WorkflowError


class SyntheticCobCorrectionService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def correct(self, actor: Actor, fill_id: str, reason: str, *,
                target_position: int, expected_active_paid_transaction_ids: list[str],
                corrected_billing_ndc: str) -> dict[str, Any]:
        note = reason.strip() if isinstance(reason, str) else ""
        ndc = corrected_billing_ndc.strip() if isinstance(corrected_billing_ndc, str) else ""
        expected = expected_active_paid_transaction_ids
        if not 12 <= len(note) <= 1000:
            raise WorkflowError("Pharmacist selective COB correction requires a 12-1000 character reason")
        if (not isinstance(target_position, int) or isinstance(target_position, bool)
                or not 1 <= target_position <= 4):
            raise WorkflowError("COB target must be a payer position between 1 and 4")
        if not ndc or len(ndc) > 30:
            raise WorkflowError("Corrected billing NDC must be 1-30 characters")
        if (not isinstance(expected, list) or not 1 <= len(expected) <= 4
                or any(not isinstance(x, str) or not x.strip() for x in expected)
                or len(set(expected)) != len(expected)):
            raise WorkflowError("Unique ordered active payer transaction IDs are required")
        key_source = json.dumps({
            "fill_id": fill_id, "target": target_position, "expected": expected,
            "corrected_ndc": ndc, "reason": note,
        }, sort_keys=True, separators=(",", ":"))
        correction_key = hashlib.sha256(key_source.encode("utf-8")).hexdigest()

        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            fill = s.scalar(select(Fill).where(Fill.id == fill_id).with_for_update())
            if fill is None:
                raise WorkflowError("Fill not found")
            rx = s.scalar(select(Prescription).where(
                Prescription.id == fill.prescription_id,
                Prescription.site_id == actor.site_id).with_for_update())
            if rx is None:
                raise WorkflowError("Fill is outside this pharmacy site")
            if fill.status != "PHARMACIST_REVIEW" or rx.status != "PHARMACIST_REVIEW":
                raise WorkflowError("Only pre-verification prepared fills may correct local COB")
            if s.scalar(select(SyntheticRebillLink.id).where(
                    SyntheticRebillLink.original_fill_id == fill.id)):
                raise WorkflowError("A retired/restarted fill may not selectively reprocess payers")
            if (s.scalar(select(FillCompletion.id).where(FillCompletion.fill_id == fill.id))
                    or s.scalar(select(EmergencySupply.id).where(EmergencySupply.fill_id == fill.id))):
                raise WorkflowError("Completion or emergency supply requires professional reconciliation")
            claims = s.scalars(select(Claim).where(
                Claim.fill_id == fill.id).order_by(Claim.sequence).with_for_update()).all()
            if (not 2 <= len(claims) <= 4 or target_position > len(claims)
                    or [c.sequence for c in claims] != list(range(1, len(claims) + 1))
                    or len(expected) != len(claims) - target_position + 1):
                raise WorkflowError("COB correction must include target and every downstream payer")
            if any(c.status != "PAID_SYNTHETIC" for c in claims):
                raise WorkflowError("Unpaid or partly reversed payer chain requires manual reconciliation")
            ledger = CobAttemptRegistry(self.service)._history_tx(s, actor, fill.id)
            if ledger["active_local_paid_positions"] != len(claims):
                raise WorkflowError("COB payer ledger is not fully locally paid")
            entries = ledger["claim_positions"]
            suffix = entries[target_position - 1:]
            suffix_claims = claims[target_position - 1:]
            active_desc = [entry["attempts"][-1]["paid_transaction_id"]
                           for entry in reversed(suffix)]
            if any(entry["attempts"][-1]["state"] != "PAID_SYNTHETIC_LOCAL_ONLY"
                   for entry in entries):
                raise WorkflowError("Latest COB payer attempt must be active")
            # Stale submissions may be legitimate idempotent replays of a
            # previously committed correction, but never another mutation.
            if expected != active_desc:
                reversed_events = []
                new_events = []
                for entry, old_id in zip(reversed(suffix), expected):
                    versions = entry["attempts"]
                    old_index = next((i for i, attempt in enumerate(versions)
                                      if attempt["paid_transaction_id"] == old_id), None)
                    if old_index is None or old_index + 1 >= len(versions):
                        raise WorkflowError("Stale or unordered COB payer transaction list; refresh")
                    old, new = versions[old_index:old_index + 2]
                    if (old["reversal_transaction_id"] is None
                            or new["corrected_from_paid_transaction_id"] != old_id
                            or new["correction_key"] != correction_key):
                        raise WorkflowError("COB retry differs from committed correction; refresh")
                    reversed_events.append(old["reversal_transaction_id"])
                    new_events.append(new["paid_transaction_id"])
                return {
                    "fill_id": fill.id, "target_position": target_position,
                    "positions_reversed": list(range(len(claims), target_position - 1, -1)),
                    "positions_reprocessed": list(range(target_position, len(claims) + 1)),
                    "original_active_paid_transaction_ids": expected,
                    "reversal_transaction_ids": reversed_events,
                    "new_paid_transaction_ids": list(reversed(new_events)),
                    "corrected_billing_ndc": ndc, "replayed": True,
                    "external_payer_contact": False, "stock_moved": False,
                    "synthetic_only": True,
                }
            # Refuse to alter already printed labels or unverified physical
            # stock/packaging. No part of the correction moves a prescription.
            jobs = s.scalars(select(LabelPrintJob).where(
                LabelPrintJob.site_id == actor.site_id,
                LabelPrintJob.fill_id == fill.id)).all()
            label_count = len(s.scalars(select(Label).where(Label.fill_id == fill.id)).all())
            if not jobs or len(jobs) != label_count or any(j.status != "QUEUED" for j in jobs):
                raise WorkflowError("Unused queued labels are required for selective correction")
            if s.scalar(select(LabelPrintEvent.id).join(
                    LabelPrintJob, LabelPrintEvent.print_job_id == LabelPrintJob.id).where(
                    LabelPrintJob.site_id == actor.site_id,
                    LabelPrintJob.fill_id == fill.id)):
                raise WorkflowError("Printed test labels require manual reconciliation")
            require_no_open_test_rejections(s, actor, fill)
            require_fill_sources_eligible(s, rx, fill)
            sources = s.scalars(select(FillSource).where(
                FillSource.fill_id == fill.id)).all()
            if not sources or sum((src.quantity for src in sources), 0) != fill.quantity:
                raise WorkflowError("Physical fill source quantities no longer match")
            available_ndcs = set()
            for source in sorted(sources, key=lambda src: src.stock_id):
                stock = s.scalar(select(Stock).where(
                    Stock.id == source.stock_id, Stock.site_id == actor.site_id).with_for_update())
                if (stock is None or stock.reserved < source.quantity
                        or stock.expires <= date.today().isoformat()):
                    raise WorkflowError("Physical source expired or reservation no longer valid")
                product = s.get(Product, stock.product_id)
                if product is None or product.drug_id != rx.drug_id:
                    raise WorkflowError("Scanned billing source is not the prescribed drug")
                available_ndcs.add(product.ndc)
            if ndc not in available_ndcs:
                raise WorkflowError("Corrected NDC must be present among scanned physical sources")

            current = {}
            for claim, entry in zip(claims, entries):
                last = entry["attempts"][-1]
                attempt = s.get(SyntheticCobAttempt, last["attempt_id"])
                tx = s.get(SandboxClaimTransaction, last["paid_transaction_id"])
                if (attempt is None or tx is None or tx.claim_id != claim.id
                        or attempt.paid_transaction_id != tx.id):
                    raise WorkflowError("Latest paid attempt was replaced during correction")
                current[claim.sequence] = (claim, attempt, tx)

            reversed_ids = []
            for claim in reversed(suffix_claims):
                previous, paid = current[claim.sequence][1:]
                request = {
                    "claim_id": claim.id, "original_transaction_id": paid.id,
                    "prior_attempt_number": previous.attempt_number,
                    "correction_key": correction_key, "reason": note,
                    "coverage_position": claim.sequence,
                    "external_submission": False,
                }
                ev = _record(s, actor, fill.id, "REVERSE", "REVERSED_SYNTHETIC",
                    f"synthetic-cob-correct-reverse:{paid.id}", request,
                    {"outcome": "REVERSED_SYNTHETIC",
                     "message": "Local mock reversal; no insurer contacted",
                     "transaction_reference": None},
                    claim_id=claim.id, payer_id=paid.payer_id,
                    coverage_id=paid.coverage_id, original_id=paid.id)
                mirror_reversal_tx(s, actor, claim, paid, ev)
                claim.status = "REVERSED_SYNTHETIC"
                reversed_ids.append(ev.id)
            s.flush()

            new_ids = []
            active_upstream = []
            for claim in claims[:target_position - 1]:
                active_upstream.append(current[claim.sequence][2].id)
            for claim in suffix_claims:
                previous, paid = current[claim.sequence][1:]
                request = dict(_view(paid)["request"])
                request.update({
                    "attempt_number": previous.attempt_number + 1,
                    "corrected_from_paid_transaction_id": paid.id,
                    "correction_key": correction_key,
                    "correction_reason": note,
                    "prior_payer_paid_transaction_ids": list(active_upstream),
                    "external_submission": False,
                })
                if claim.sequence == target_position:
                    request["billed_ndc"] = ndc
                    request["documented_test_ndc_correction"] = True
                response = {
                    "outcome": "PAID_SYNTHETIC",
                    "adapter": "LOCAL_TEST_ONLY",
                    "authorization_number": None,
                    "transaction_reference": None,
                    "amount_paid": None, "patient_responsibility": None,
                    "messages": ["Reprocessed in memory for test only; no real claim adjudication"],
                }
                new_tx = _record(s, actor, fill.id, "BILL", "PAID_SYNTHETIC",
                    f"synthetic-cob-correct-bill:{claim.id}:{previous.attempt_number + 1}",
                    request, response, claim_id=claim.id,
                    payer_id=paid.payer_id, coverage_id=paid.coverage_id)
                append_paid_correction_tx(s, actor, claim, new_tx, previous)
                claim.status = "PAID_SYNTHETIC"
                new_ids.append(new_tx.id)
                active_upstream.append(new_tx.id)
            s.flush()
            complete = CobAttemptRegistry(self.service)._history_tx(s, actor, fill.id)
            if complete["active_local_paid_positions"] != len(claims):
                raise WorkflowError("Post-correction COB ledger incomplete; rollback")
            self.service._audit(s, actor, "SYNTHETIC_SELECTIVE_COB_REPROCESSED", fill.id, {
                "target_position": target_position,
                "reverse_positions": [c.sequence for c in reversed(suffix_claims)],
                "reprocess_positions": [c.sequence for c in suffix_claims],
                "original_paid_transaction_ids": expected,
                "reversal_transaction_ids": reversed_ids,
                "new_paid_transaction_ids": new_ids,
                "corrected_billing_ndc": ndc,
                "correction_key": correction_key,
                "reason": note,
                "stock_moved": False, "external_payer_contact": False,
            })
            return {
                "fill_id": fill.id, "target_position": target_position,
                "positions_reversed": [c.sequence for c in reversed(suffix_claims)],
                "positions_reprocessed": [c.sequence for c in suffix_claims],
                "original_active_paid_transaction_ids": expected,
                "reversal_transaction_ids": reversed_ids,
                "new_paid_transaction_ids": new_ids,
                "corrected_billing_ndc": ndc, "replayed": False,
                "external_payer_contact": False, "stock_moved": False,
                "synthetic_only": True,
            }
