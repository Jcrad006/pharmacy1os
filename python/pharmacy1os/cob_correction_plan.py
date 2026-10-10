"""Version-aware read-only preflight for selective *synthetic* COB corrections.

Original TypeScript dependencies: undo last payer first, then target; resubmit
from target forward. This projection derives the current attempt identities
from the canonical validated versioned ledger, not original BILL-only events.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select

from .cob_attempts import CobAttemptRegistry
from .claim_rebilling import SyntheticRebillLink
from .claim_transactions import require_no_open_test_rejections
from .emergency_supply import EmergencySupply
from .fill_completion import FillCompletion
from .label_printing import LabelPrintEvent, LabelPrintJob
from .models import Fill, FillSource, Label, Prescription, Product, Stock
from .product_selection import require_fill_sources_eligible
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
            if s.scalar(select(SyntheticRebillLink.id).where(
                    SyntheticRebillLink.site_id == actor.site_id,
                    SyntheticRebillLink.original_fill_id == fill.id)):
                raise WorkflowError("Retired fill cannot undergo selective COB correction")
            if (s.scalar(select(FillCompletion.id).where(FillCompletion.fill_id == fill.id))
                    or s.scalar(select(EmergencySupply.id).where(
                        EmergencySupply.fill_id == fill.id))):
                raise WorkflowError("Completion or emergency supplies need separate reconciliation")

            # Use exactly the same authoritative ledger as the executable
            # synthetic correction and pre-dispense pharmacist verification.
            timeline = CobAttemptRegistry(self.service)._history_tx(s, actor, fill.id)
            entries = timeline["claim_positions"]
            count = len(entries)
            if (not 2 <= count <= 4 or target_position > count
                    or [x["coverage_position"] for x in entries] != list(range(1, count + 1))):
                raise WorkflowError("COB correction requires an intact two-to-four-position chain")
            if (timeline["active_local_paid_positions"] != count
                    or any(x["claim_status"] != "PAID_SYNTHETIC" for x in entries)):
                raise WorkflowError("Correction cannot be planned from a partially reversed COB chain")
            jobs = s.scalars(select(LabelPrintJob).where(
                LabelPrintJob.site_id == actor.site_id,
                LabelPrintJob.fill_id == fill.id)).all()
            label_count = len(s.scalars(select(Label).where(Label.fill_id == fill.id)).all())
            if not jobs or len(jobs) != label_count or any(j.status != "QUEUED" for j in jobs):
                raise WorkflowError("Correction preflight requires intact unused test labels")
            if s.scalar(select(LabelPrintEvent.id).join(
                    LabelPrintJob, LabelPrintEvent.print_job_id == LabelPrintJob.id).where(
                    LabelPrintJob.site_id == actor.site_id,
                    LabelPrintJob.fill_id == fill.id)):
                raise WorkflowError("Previously printed labels require manual reconciliation")
            require_no_open_test_rejections(s, actor, fill)
            require_fill_sources_eligible(s, rx, fill)

            sources = s.scalars(select(FillSource).where(
                FillSource.fill_id == fill.id)).all()
            if not sources or sum((src.quantity for src in sources), 0) != fill.quantity:
                raise WorkflowError("Physical fill source quantities no longer match")
            available_ndcs = set()
            for source in sources:
                stock = s.get(Stock, source.stock_id)
                if (stock is None or stock.site_id != actor.site_id
                        or stock.reserved < source.quantity
                        or stock.expires <= date.today().isoformat()):
                    raise WorkflowError("Source expiration or reservation blocks COB correction")
                product = s.get(Product, stock.product_id)
                if product is None or product.drug_id != rx.drug_id:
                    raise WorkflowError("COB correction source is not the prescribed drug")
                available_ndcs.add(product.ndc)

            chain = []
            for entry in entries:
                attempts = entry["attempts"]
                latest = attempts[-1]
                if latest["state"] != "PAID_SYNTHETIC_LOCAL_ONLY":
                    raise WorkflowError("Current synthetic payer position is not paid")
                original = attempts[0]
                chain.append({
                    "position": entry["coverage_position"],
                    "claim_id": entry["claim_id"], "payer_name": entry["payer_name"],
                    "original_paid_transaction_id": original["paid_transaction_id"],
                    "active_paid_transaction_id": latest["paid_transaction_id"],
                    "active_attempt_number": latest["attempt_number"],
                    "original_billing_ndc": original["billed_ndc"],
                    "current_billing_ndc": latest["billed_ndc"],
                    "status": entry["claim_status"],
                })
            suffix = chain[target_position - 1:]
            return {
                "fill_id": fill.id, "rx_number": rx.rx_number,
                "target_position": target_position,
                "payer_count": count,
                "payer_intended_quantity": str(fill.billed_quantity),
                "physical_quantity": str(fill.quantity),
                "full_chain": chain,
                "reverse_positions": [x["position"] for x in reversed(suffix)],
                # Kept under the existing key to avoid breaking clients; these
                # now reference *current* paid attempts, not original payments.
                "reverse_transaction_ids": [x["active_paid_transaction_id"]
                                            for x in reversed(suffix)],
                "expected_active_paid_transaction_ids": [
                    x["active_paid_transaction_id"] for x in reversed(suffix)],
                "then_reprocess_positions": [x["position"] for x in suffix],
                "upstream_positions_unchanged": [
                    x["position"] for x in chain[:target_position - 1]],
                "available_billing_ndcs": sorted(available_ndcs),
                "action_enabled": True,
                "requires_new_claim_event_generation": True,
                "warning": (
                    "READ_ONLY_SYNTHETIC_PREFLIGHT; executable correction requires "
                    "pharmacist authorization, exact current paid transaction IDs, "
                    "one selected scanned NDC and a documented reason; no real payer"
                ),
            }
