"""Read-only, fail-closed dependency plan for selective synthetic COB correction.

Original TS parity target: correcting position N requires reversal of every
active paid downstream position first, and replay starts upstream -> downstream.
The Python claim schema does not yet support repeat payment/reversal cycles,
so this preflight MUST NOT mutate a claim or imply that one can be submitted.
"""
from __future__ import annotations

from sqlalchemy import select

from .claim_rebilling import SyntheticRebillLink
from .claim_transactions import _view
from .claim_transactions_models import SandboxClaimTransaction
from .label_printing import LabelPrintEvent, LabelPrintJob
from .models import Claim, Fill, Prescription
from .service import Actor, PharmacyService, WorkflowError


class CobCorrectionPlanner:
    def __init__(self, service: PharmacyService):
        self.service = service

    def plan(self, actor: Actor, fill_id: str, *, target_position: int) -> dict:
        if (not isinstance(target_position, int) or isinstance(target_position, bool)
                or not 1 <= target_position <= 4):
            raise WorkflowError("Target COB position must be an integer between 1 and 4")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            rx = self.service._site(s, Prescription, fill.prescription_id, actor)
            if fill.status != "PHARMACIST_REVIEW" or rx.status != "PHARMACIST_REVIEW":
                raise WorkflowError("COB correction preflight requires a pre-verification fill")
            claims = s.scalars(select(Claim).where(
                Claim.fill_id == fill.id).order_by(Claim.sequence)).all()
            count = len(claims)
            if (not 2 <= count <= 4 or target_position > count
                    or [c.sequence for c in claims] != list(range(1, count + 1))):
                raise WorkflowError("COB correction requires an intact two-to-four-position chain")
            if any(c.status != "PAID_SYNTHETIC" for c in claims):
                raise WorkflowError("Correction cannot be planned from a partially reversed COB chain")
            if s.scalar(select(SyntheticRebillLink.id).where(
                SyntheticRebillLink.site_id == actor.site_id,
                SyntheticRebillLink.original_fill_id == fill.id)):
                raise WorkflowError("Claim chain has already been replaced")
            history = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill.id,
                SandboxClaimTransaction.operation.in_(("BILL", "REVERSE")))).all()
            if len(history) != count or any(tx.operation != "BILL" for tx in history):
                raise WorkflowError("Unreconciled or duplicate payer transaction history")
            by_claim = {tx.claim_id: tx for tx in history}
            if len(by_claim) != count or None in by_claim:
                raise WorkflowError("Ambiguous original claim linkage")
            chain = []
            for claim in claims:
                tx = by_claim.get(claim.id)
                if tx is None:
                    raise WorkflowError("Original synthetic payer evidence is missing")
                entry = _view(tx)  # Verifies canonical SHA-256 request hash.
                request = entry["request"]
                if (tx.outcome != "PAID_SYNTHETIC" or tx.original_transaction_id is not None
                        or request.get("coverage_position") != claim.sequence
                        or request.get("fill_id") != fill.id
                        or request.get("payer_name") != claim.payer
                        or request.get("payer_intended_quantity") != str(claim.billed_quantity)
                        or request.get("physical_part_quantity") != str(fill.quantity)):
                    raise WorkflowError("Inconsistent payer snapshot blocks selective correction")
                chain.append({
                    "position": claim.sequence, "claim_id": claim.id,
                    "original_paid_transaction_id": tx.id,
                    "payer_name": claim.payer,
                    "payer_id": tx.payer_id, "coverage_id": tx.coverage_id,
                    "status": claim.status,
                })
            jobs = s.scalars(select(LabelPrintJob).where(
                LabelPrintJob.site_id == actor.site_id,
                LabelPrintJob.fill_id == fill.id)).all()
            if not jobs or any(job.status != "QUEUED" for job in jobs):
                raise WorkflowError("Correction preflight requires intact unused test labels")
            if s.scalar(select(LabelPrintEvent.id).join(
                LabelPrintJob, LabelPrintEvent.print_job_id == LabelPrintJob.id).where(
                LabelPrintJob.site_id == actor.site_id,
                LabelPrintJob.fill_id == fill.id)):
                raise WorkflowError("Previously printed labels require manual reconciliation")
            selected = chain[target_position - 1:]
            return {
                "fill_id": fill.id, "rx_number": rx.rx_number,
                "target_position": target_position,
                "payer_count": count, "payer_intended_quantity": str(fill.billed_quantity),
                "physical_quantity": str(fill.quantity),
                "full_chain": chain,
                "reverse_positions": [x["position"] for x in reversed(selected)],
                "reverse_transaction_ids": [x["original_paid_transaction_id"]
                                            for x in reversed(selected)],
                "then_reprocess_positions": [x["position"] for x in selected],
                "upstream_positions_unchanged": [x["position"]
                                                 for x in chain[:target_position - 1]],
                "action_enabled": False,
                "requires_new_claim_event_generation": True,
                "warning": (
                    "READ_ONLY_SYNTHETIC_PREFLIGHT; per-position resubmission is not yet "
                    "implemented in Python; use full-chain reversal and fresh rescan "
                    "for correction; no payer contacted"
                ),
            }
