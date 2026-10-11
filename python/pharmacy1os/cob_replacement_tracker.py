"""Read-only progress tracker for local synthetic COB replacement fills.

Never contacts a payer or scanner and cannot authorize a dispensing event.
"""
from __future__ import annotations

import json
from decimal import Decimal
from sqlalchemy import select

from .claim_rebilling import ClaimRebillService, SyntheticRebillLink
from .cob_attempts import CobAttemptRegistry
from .models import Fill, FillSource, Prescription, Stock
from .service import Actor, PharmacyService, WorkflowError


class CobReplacementTracker:
    def __init__(self, service: PharmacyService):
        self.service = service

    def detail(self, actor: Actor, fill_id: str) -> dict:
        if not isinstance(fill_id, str) or not fill_id.strip():
            raise WorkflowError("Original/replacement fill ID is required")
        history = ClaimRebillService(self.service).lineage(actor, fill_id)
        if not history["links"]:
            raise WorkflowError("Fill has no synthetic rebill replacement")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            latest = s.get(Fill, history["latest_fill_id"])
            if latest is None:
                raise WorkflowError("Synthetic replacement references absent fill")
            rx = self.service._site(s, Prescription, latest.prescription_id, actor)
            # Do not accept a healthy newest replacement if an earlier
            # multi-attempt rebill link was altered. All historical originals
            # must have an intact site-local, fully reversed versioned COB.
            prior = None
            payers = []
            previous_id = history["root_fill_id"]
            registry = CobAttemptRegistry(self.service)
            for link_info in history["links"]:
                old = s.get(Fill, link_info["original_fill_id"])
                replacement = s.get(Fill, link_info["replacement_fill_id"])
                if (old is None or replacement is None
                        or old.id != previous_id
                        or old.prescription_id != rx.id
                        or replacement.prescription_id != rx.id
                        or old.status != "RETURNED"
                        or old.fill_number != replacement.fill_number
                        or old.attempt + 1 != replacement.attempt):
                    raise WorkflowError("Synthetic replacement ancestry inconsistent")
                link = s.scalar(select(SyntheticRebillLink).where(
                    SyntheticRebillLink.site_id == actor.site_id,
                    SyntheticRebillLink.original_fill_id == old.id,
                    SyntheticRebillLink.replacement_fill_id == replacement.id))
                if link is None or link.id != link_info["id"]:
                    raise WorkflowError("Replacement has no site-local link")
                original = registry._history_tx(s, actor, old.id)
                positions = original["claim_positions"]
                try:
                    expected = json.loads(link.reversed_claim_ids_json)
                except (TypeError, ValueError) as exc:
                    raise WorkflowError("Replacement has invalid reversed claim snapshot") from exc
                if (not positions or [p["claim_id"] for p in positions] != expected
                        or original["active_local_paid_positions"] != 0
                        or any(not p["attempts"] or
                               p["attempts"][-1]["reversal_transaction_id"] is None
                               for p in positions)):
                    raise WorkflowError("Replacement prior COB reversal is incomplete")
                prior, payers = old, positions
                previous_id = replacement.id
            if previous_id != latest.id or prior is None:
                raise WorkflowError("Synthetic rebill latest attempt does not match its ancestry")
            scanned = s.scalars(select(FillSource).where(
                FillSource.fill_id == latest.id)).all()
            quantity = Decimal("0")
            for item in scanned:
                stock = s.get(Stock, item.stock_id)
                if (stock is None or stock.site_id != actor.site_id
                        or item.quantity <= 0):
                    raise WorkflowError("Replacement source references invalid site stock")
                quantity += item.quantity
            if quantity > latest.quantity:
                raise WorkflowError("Replacement scanned quantity exceeds required quantity")
            if latest.status == "PRODUCT_FILL":
                stage = ("AWAITING_PHYSICAL_RESCAN" if quantity < latest.quantity
                         else "AWAITING_SYNTHETIC_CLAIM_PREPARATION")
            elif latest.status == "PHARMACIST_REVIEW":
                if quantity != latest.quantity:
                    raise WorkflowError("Prepared replacement is missing source scans")
                stage = "AWAITING_PHARMACIST_VERIFICATION"
            elif latest.status == "READY":
                stage = "PHARMACIST_VERIFIED_READY"
            elif latest.status == "SOLD":
                stage = "SYNTHETIC_PICKUP_RECORDED"
            else:
                stage = "NON_ACTIVE_RECONCILIATION_REQUIRED"
            return {
                "rx_number": rx.rx_number,
                "root_fill_id": history["root_fill_id"],
                "original_fill_id": prior.id,
                "latest_fill_id": latest.id,
                "replacement_attempt": latest.attempt,
                "attempt_count": len(history["attempts"]),
                "prior_payer_positions_reversed": len(payers),
                "prior_local_paid_positions_remaining": 0,
                "fill_status": latest.status,
                "workflow_stage": stage,
                "scanned_source_count": len(scanned),
                "scanned_physical_quantity": str(quantity),
                "required_physical_quantity": str(latest.quantity),
                "payer_intended_quantity": str(latest.billed_quantity),
                "requires_fresh_scans": stage == "AWAITING_PHYSICAL_RESCAN",
                "requires_pharmacist_verification": stage == "AWAITING_PHARMACIST_VERIFICATION",
                "synthetic_only": True,
                "external_payer_contact": False,
                "warning": "LOCAL_SYNTHETIC_REBILL_ONLY_NO_REAL_PAYER_OR_DISPENSE_AUTHORIZATION",
            }
