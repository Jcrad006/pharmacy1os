"""Pre-verification synthetic claim reversal and explicit replacement fill lineage.

Every old claim and label survives untouched. A fresh fill attempt is created
ONLY after all payer events have been locally reversed and physical reservations
released. This is not a live rebill or external insurer reversal.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, Claim, Fill, FillSource, Label, Prescription, Stock, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError


class SyntheticRebillLink(Base):
    __tablename__ = "py_synthetic_rebill_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    original_fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False)
    replacement_fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False)
    reversed_claim_ids_json: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("original_fill_id", name="uq_py_rebill_original_fill"),
        UniqueConstraint("replacement_fill_id", name="uq_py_rebill_replacement_fill"),
    )


class ClaimRebillService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def restart(self, actor: Actor, fill_id: str, reason: str, *,
                expected_claim_ids: list[str]) -> dict[str, Any]:
        """Atomically retire one pre-verified billed attempt and start a new one.

        Optimistic claim-id check protects operators from stale payer lists;
        PostgreSQL row locks serialize the old fill, Rx, claims and stock.
        The new attempt has no scanned sources, billing selection, payer claims,
        labels or pharmacist verification: each must be performed again.
        """
        note = reason.strip() if isinstance(reason, str) else ""
        if not 12 <= len(note) <= 1000:
            raise WorkflowError("Pharmacist rebill restart requires a 12-1000 character reason")
        if (not isinstance(expected_claim_ids, list)
                or not 1 <= len(expected_claim_ids) <= 4
                or any(not isinstance(x, str) or not x for x in expected_claim_ids)
                or len(set(expected_claim_ids)) != len(expected_claim_ids)):
            raise WorkflowError("Provide the unique expected IDs of one to four paid claims")
        with self.service.sessions.begin() as s:
            return self._restart_tx(s, actor, fill_id, note, expected_claim_ids=expected_claim_ids)

    def _restart_tx(self, s, actor: Actor, fill_id: str, note: str, *,
                    expected_claim_ids: list[str]) -> dict[str, Any]:
        """Atomic internals shared by full-COB and one-payer transaction action."""
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
            raise WorkflowError("Only a pre-verification prepared fill can restart for rebilling")
        if s.scalar(select(SyntheticRebillLink.id).where(
                SyntheticRebillLink.original_fill_id == fill.id)):
            raise WorkflowError("Fill has already been replaced for synthetic rebilling")
        from .fill_completion import FillCompletion, FillObligation
        from .emergency_supply import EmergencySupply
        if (s.scalar(select(FillCompletion.id).where(FillCompletion.fill_id == fill.id))
                or s.scalar(select(EmergencySupply.id).where(EmergencySupply.fill_id == fill.id))):
            raise WorkflowError("Completion or emergency fills require separate professional reconciliation")
        claims = s.scalars(select(Claim).where(
            Claim.fill_id == fill.id).order_by(Claim.sequence).with_for_update()).all()
        if [c.id for c in claims] != expected_claim_ids:
            raise WorkflowError("Synthetic payer list changed; refresh expected claim IDs")
        if any(c.status != "PAID_SYNTHETIC" for c in claims):
            raise WorkflowError("Every synthetic claim must be paid and not previously reversed")
        from .claim_transactions_models import SandboxClaimTransaction
        from .billing_models import ClaimOperation
        for claim in claims:
            paid_op = s.scalar(select(ClaimOperation.id).where(
                ClaimOperation.claim_id == claim.id,
                ClaimOperation.operation == "SYNTHETIC_PAID"))
            paid_tx = s.scalar(select(SandboxClaimTransaction.id).where(
                SandboxClaimTransaction.claim_id == claim.id,
                SandboxClaimTransaction.operation == "BILL"))
            if paid_op is None or paid_tx is None:
                raise WorkflowError("Missing original synthetic payer evidence; manual review required")
        from .label_printing import LabelPrintJob, LabelPrintEvent
        labels = s.scalars(select(Label).where(Label.fill_id == fill.id)).all()
        jobs = s.scalars(select(LabelPrintJob).where(
            LabelPrintJob.site_id == actor.site_id, LabelPrintJob.fill_id == fill.id)).all()
        if len(labels) != len(jobs) or not labels or any(
                job.status != "QUEUED" for job in jobs):
            raise WorkflowError("All original synthetic labels must be unused and queued")
        if s.scalar(select(LabelPrintEvent.id).join(
                LabelPrintJob, LabelPrintEvent.print_job_id == LabelPrintJob.id).where(
                LabelPrintJob.fill_id == fill.id, LabelPrintJob.site_id == actor.site_id).limit(1)):
            raise WorkflowError("Previously printed test labels require manual reconciliation")
        sources = s.scalars(select(FillSource).where(
            FillSource.fill_id == fill.id).order_by(FillSource.stock_id)).all()
        if not sources or sum((src.quantity for src in sources), 0) != fill.quantity:
            raise WorkflowError("Physical fill sources are inconsistent; cannot restart")
        if any(f.id != fill.id and f.status in {"PRODUCT_FILL", "PHARMACIST_REVIEW", "READY"}
               for f in s.scalars(select(Fill).where(Fill.prescription_id == rx.id))):
            raise WorkflowError("Other active fill prevents correction restart")

        from .cob_attempts import SyntheticCobAttempt
        if s.scalar(select(SyntheticCobAttempt.id).where(
                SyntheticCobAttempt.fill_id == fill.id,
                SyntheticCobAttempt.attempt_number > 1)):
            raise WorkflowError(
                "Versioned selective COB corrections require dedicated payer reconciliation before full rebill")
        from .billing import record_reversal
        # COB reversals are downstream-to-upstream (4,3,2,1), matching
        # the original claim adapter's dependency ordering.
        for claim in reversed(claims):
            record_reversal(s, actor, claim, note)
            claim.status = "REVERSED_SYNTHETIC"
        from .inventory_allocations import (
            source_allocation, allocation_location_id, transition_allocation,
        )
        from .inventory_ops import record_movement
        for source in sources:
            stock = s.scalar(select(Stock).where(
                Stock.id == source.stock_id, Stock.site_id == actor.site_id).with_for_update())
            if stock is None or stock.reserved < source.quantity:
                raise WorkflowError("Physical stock reservation inconsistent during rebill")
            allocation = source_allocation(s, actor, fill, stock, source)
            record_movement(s, actor, stock, "REBILL_SOURCE_RELEASE",
                            reserved=-source.quantity, reason=note,
                            location_id=allocation_location_id(s, allocation))
            transition_allocation(s, actor, allocation, "RELEASED",
                "Synthetic rebill restart released original scanned reservation")
        from .label_printing import void_label_jobs
        void_label_jobs(s, actor, fill.id, note)
        from .fill_completion import void_unissued_obligation
        void_unissued_obligation(s, actor, fill, note)
        from .inventory_demands import cancel_fill_demand_tx
        cancel_fill_demand_tx(s, actor, fill, rx, note)
        old_quantity, old_days_supply = fill.quantity, fill.days_supply
        fill.status = "RETURNED"
        rx.status = "DUR_REVIEW"
        replacement_id = self.service._start_fill_tx(
            s, actor, rx, str(old_quantity), days_supply=old_days_supply)
        replacement = s.get(Fill, replacement_id)
        if (replacement is None or replacement.fill_number != fill.fill_number
                or replacement.attempt != fill.attempt + 1):
            raise WorkflowError("Fresh rebill did not preserve original fill attempt lineage")
        s.add(SyntheticRebillLink(
            site_id=actor.site_id, original_fill_id=fill.id,
            replacement_fill_id=replacement_id,
            reversed_claim_ids_json=json.dumps(expected_claim_ids),
            actor_id=actor.id, reason=note))
        self.service._audit(s, actor, "SYNTHETIC_REBILL_RESTARTED", fill.id, {
            "replacement_fill_id": replacement_id,
            "reversed_claim_ids": expected_claim_ids,
            "original_fill_number": fill.fill_number,
            "replacement_attempt": replacement.attempt,
            "original_source_count": len(sources),
            "quantity_released": str(old_quantity),
            "requires_fresh_scans": True,
            "external_payer_contact": False, "reason": note,
        })
        return {
            "original_fill_id": fill.id, "replacement_fill_id": replacement_id,
            "reversed_claim_ids": expected_claim_ids,
            "fill_number": replacement.fill_number, "replacement_attempt": replacement.attempt,
            "physical_quantity": str(replacement.quantity),
            "payer_intended_quantity": str(replacement.billed_quantity),
            "days_supply": replacement.days_supply,
            "requires_fresh_scans": True, "requires_new_claim_preparation": True,
            "requires_pharmacist_verification": True, "synthetic_only": True,
        }




    def reverse_cob_transactions(self, actor: Actor, fill_id: str, reason: str, *,
                                 expected_paid_transaction_ids: list[str]) -> dict[str, Any]:
        """Reverse the complete 2-4 payer *local* COB chain in reverse order.

        All source transactions must be exact, unique, in descending coverage
        position, and each one must still be locally paid. On first invocation
        all reversals, label voids, reservation releases and fresh attempt start
        commit atomically. A repeat is an immutable, validated read-only replay.
        """
        note = reason.strip() if isinstance(reason, str) else ""
        if not 12 <= len(note) <= 1000:
            raise WorkflowError("Full COB reversal requires a 12-1000 character pharmacist reason")
        ids = expected_paid_transaction_ids
        if (not isinstance(ids, list) or not 2 <= len(ids) <= 4
                or any(not isinstance(x, str) or not x.strip() for x in ids)
                or len(set(ids)) != len(ids)):
            raise WorkflowError("Provide two to four unique original paid transaction IDs in reverse COB order")
        from .claim_transactions_models import SandboxClaimTransaction
        from .claim_transactions import _view
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
            claims = s.scalars(select(Claim).where(
                Claim.fill_id == fill.id).order_by(Claim.sequence).with_for_update()).all()
            if len(claims) != len(ids) or [c.sequence for c in claims] != list(range(1, len(ids) + 1)):
                raise WorkflowError("COB claim positions are incomplete or changed; refresh the complete chain")
            paid_tx = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill.id,
                SandboxClaimTransaction.operation == "BILL")).all()
            if len(paid_tx) != len(claims):
                raise WorkflowError("Ambiguous or missing original synthetic paid transactions")
            tx_by_claim = {tx.claim_id: tx for tx in paid_tx}
            if (len(tx_by_claim) != len(claims) or None in tx_by_claim):
                raise WorkflowError("Duplicate or missing original paid-claim identities")
            descending_claims = list(reversed(claims))
            expected_order = [tx_by_claim[c.id].id for c in descending_claims
                              if c.id in tx_by_claim]
            if expected_order != ids:
                raise WorkflowError("Original paid transaction list or descending COB order changed; refresh")
            for claim in descending_claims:
                tx = tx_by_claim[claim.id]
                data = _view(tx)
                req = data["request"]
                if (tx.outcome != "PAID_SYNTHETIC"
                        or tx.original_transaction_id is not None
                        or tx.claim_id != claim.id or tx.fill_id != fill.id
                        or req.get("fill_id") != fill.id
                        or req.get("coverage_position") != claim.sequence
                        or req.get("payer_name") != claim.payer
                        or req.get("payer_intended_quantity") != str(claim.billed_quantity)
                        or req.get("physical_part_quantity") != str(fill.quantity)):
                    raise WorkflowError("Original synthetic payer snapshot is inconsistent")

            # Deterministic idempotency: replay only a *complete* four-way (or
            # two/three-way) reversal with an intact linked replacement. Never
            # accept a partial reversal, inconsistent claim, or broken lineage.
            link = s.scalar(select(SyntheticRebillLink).where(
                SyntheticRebillLink.site_id == actor.site_id,
                SyntheticRebillLink.original_fill_id == fill.id))
            reversed_events = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill.id,
                SandboxClaimTransaction.operation == "REVERSE")).all()
            if (link is not None or reversed_events
                    or any(c.status != "PAID_SYNTHETIC" for c in claims)):
                if (link is None or fill.status != "RETURNED"
                        or any(c.status != "REVERSED_SYNTHETIC" for c in claims)
                        or json.loads(link.reversed_claim_ids_json) != [c.id for c in claims]
                        or len(reversed_events) != len(claims)):
                    raise WorkflowError("Incomplete or inconsistent COB reversal requires manual reconciliation")
                by_original = {tx.original_transaction_id: tx for tx in reversed_events}
                if len(by_original) != len(ids) or set(by_original) != set(ids):
                    raise WorkflowError("COB reversal transaction ancestry is inconsistent")
                reversal_ids = []
                for txid in ids:
                    ev = by_original[txid]
                    if ev.outcome != "REVERSED_SYNTHETIC":
                        raise WorkflowError("COB reverse event is not a completed local reversal")
                    _view(ev)
                    reversal_ids.append(ev.id)
                # A different reversal path may have created this link. Replay
                # is safe so long as the same complete original chain was retired.
                replacement = s.get(Fill, link.replacement_fill_id)
                if (replacement is None or replacement.prescription_id != rx.id
                        or replacement.fill_number != fill.fill_number
                        or replacement.attempt != fill.attempt + 1):
                    raise WorkflowError("COB reversal replacement attempt is inconsistent")
                return {
                    "original_fill_id": fill.id, "replacement_fill_id": replacement.id,
                    "original_paid_transaction_ids": ids,
                    "reversal_transaction_ids": reversal_ids,
                    "coverage_positions_reversed": [c.sequence for c in descending_claims],
                    "replayed": True, "requires_fresh_scans": replacement.status == "PRODUCT_FILL",
                    "external_payer_contact": False, "synthetic_only": True,
                }
            result = self._restart_tx(s, actor, fill.id, note,
                                       expected_claim_ids=[c.id for c in claims])
            # Claims and source snapshots are preserved, and REVERSE references
            # the actual preceding BILL transaction, not a fabricated claim.
            s.flush()
            reversal_events = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill.id,
                SandboxClaimTransaction.operation == "REVERSE")).all()
            by_original = {tx.original_transaction_id: tx for tx in reversal_events}
            if len(by_original) != len(ids) or set(by_original) != set(ids):
                raise WorkflowError("Whole-COB reversal was incomplete; transaction rolled back")
            reversal_ids = []
            for txid in ids:
                ev = by_original[txid]
                if ev.outcome != "REVERSED_SYNTHETIC":
                    raise WorkflowError("Unexpected synthetic COB reversal outcome")
                _view(ev)
                reversal_ids.append(ev.id)
            self.service._audit(s, actor, "SYNTHETIC_COB_CHAIN_REVERSED", fill.id, {
                "original_paid_transaction_ids": ids,
                "reversal_transaction_ids": reversal_ids,
                "coverage_positions_reversed": [c.sequence for c in descending_claims],
                "replacement_fill_id": result["replacement_fill_id"],
                "external_payer_contact": False, "reason": note,
            })
            return {
                **result,
                "original_paid_transaction_ids": ids,
                "reversal_transaction_ids": reversal_ids,
                "coverage_positions_reversed": [c.sequence for c in descending_claims],
                "replayed": False, "external_payer_contact": False,
            }

    def reverse_single_transaction(self, actor: Actor, transaction_id: str,
                                   reason: str, *, expected_claim_id: str) -> dict[str, Any]:
        """Idempotent single-payer synthetic reversal plus safe fresh-rescan restart.

        The original Fastify app can reverse individual paid COB positions;
        this narrowed migration action intentionally rejects multi-payer
        situations until fully ordered COB reversal/re-adjudication is ported.
        No external payer, patient sale, or printer is ever contacted.
        """
        note = reason.strip() if isinstance(reason, str) else ""
        if not 12 <= len(note) <= 1000:
            raise WorkflowError("Synthetic reversal requires a 12-1000 character reason")
        if not isinstance(expected_claim_id, str) or not expected_claim_id:
            raise WorkflowError("Exact expected claim ID is required for reversal")
        from .claim_transactions_models import SandboxClaimTransaction
        from .claim_transactions import _view
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            original = s.scalar(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.id == transaction_id,
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.operation == "BILL"))
            if original is None:
                raise WorkflowError("Original synthetic paid transaction not found at pharmacy site")
            if (original.claim_id is None or original.claim_id != expected_claim_id
                    or original.original_transaction_id is not None):
                raise WorkflowError("Original transaction does not match the expected single payer claim")
            _view(original)  # Detect tampered historical payer request evidence.
            if original.outcome != "PAID_SYNTHETIC":
                raise WorkflowError("Only original locally paid synthetic transactions may be reversed")
            fill = s.scalar(select(Fill).where(Fill.id == original.fill_id).with_for_update())
            if fill is None:
                raise WorkflowError("Paid claim fill no longer exists")
            rx = s.scalar(select(Prescription).where(
                Prescription.id == fill.prescription_id,
                Prescription.site_id == actor.site_id).with_for_update())
            if rx is None:
                raise WorkflowError("Paid claim is outside the pharmacy site")
            claims = s.scalars(select(Claim).where(
                Claim.fill_id == fill.id).order_by(Claim.sequence).with_for_update()).all()
            if len(claims) != 1:
                raise WorkflowError("Multiple payer COB requires the full-fill reversal workflow")
            claim = claims[0]
            if claim.id != original.claim_id or claim.sequence != 1:
                raise WorkflowError("Original payer claim record is inconsistent")
            # A single paid transaction per claim is required; historical
            # duplicates/corruption must not be silently 'resolved'.
            paid_events = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.claim_id == claim.id,
                SandboxClaimTransaction.operation == "BILL")).all()
            if len(paid_events) != 1 or paid_events[0].id != original.id:
                raise WorkflowError("Ambiguous historical paid transaction requires manual reconciliation")
            reversed_tx = s.scalar(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.original_transaction_id == original.id,
                SandboxClaimTransaction.operation == "REVERSE"))
            link = s.scalar(select(SyntheticRebillLink).where(
                SyntheticRebillLink.site_id == actor.site_id,
                SyntheticRebillLink.original_fill_id == fill.id))
            if reversed_tx is not None or link is not None or claim.status == "REVERSED_SYNTHETIC":
                if (reversed_tx is None or link is None
                        or claim.status != "REVERSED_SYNTHETIC"
                        or reversed_tx.outcome != "REVERSED_SYNTHETIC"
                        or json.loads(link.reversed_claim_ids_json) != [claim.id]):
                    raise WorkflowError("Partial or inconsistent historical reversal requires manual review")
                _view(reversed_tx)
                replacement = s.get(Fill, link.replacement_fill_id)
                if replacement is None or replacement.prescription_id != rx.id:
                    raise WorkflowError("Broken replacement fill lineage cannot be replayed")
                return {
                    "original_transaction_id": original.id,
                    "reversal_transaction_id": reversed_tx.id,
                    "original_fill_id": fill.id,
                    "replacement_fill_id": replacement.id,
                    "replayed": True, "synthetic_only": True,
                    "external_payer_contact": False,
                    "requires_fresh_scans": replacement.status == "PRODUCT_FILL",
                }
            # The shared internal operation locks/validates scanned sources,
            # labels, print events, claims, obligations and prescription status.
            # It reverses the one claim and starts a new fill atomically.
            result = self._restart_tx(s, actor, fill.id, note,
                                      expected_claim_ids=[claim.id])
            s.flush()
            reversed_tx = s.scalar(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.original_transaction_id == original.id,
                SandboxClaimTransaction.operation == "REVERSE"))
            if reversed_tx is None or reversed_tx.outcome != "REVERSED_SYNTHETIC":
                raise WorkflowError("Synthetic reversal event missing; rollback required")
            _view(reversed_tx)
            self.service._audit(s, actor, "SYNTHETIC_SINGLE_PAYER_CLAIM_REVERSED",
                                original.id, {
                "original_claim_id": claim.id,
                "reversal_transaction_id": reversed_tx.id,
                "original_fill_id": fill.id,
                "replacement_fill_id": result["replacement_fill_id"],
                "external_contact": False, "reason": note,
            })
            return {**result, "original_transaction_id": original.id,
                    "reversal_transaction_id": reversed_tx.id,
                    "replayed": False, "external_payer_contact": False}

    def lineage(self, actor: Actor, fill_id: str) -> dict[str, Any]:
        """Traverse every historical rescan/rebill attempt in the same Rx chain.

        Starting at the oldest original fill avoids returning a misleading
        one-link history when the selected fill has been corrected repeatedly.
        Only links for this pharmacy/prescription are eligible for traversal.
        """
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            rx = self.service._site(s, Prescription, fill.prescription_id, actor)
            links = s.scalars(select(SyntheticRebillLink).where(
                SyntheticRebillLink.site_id == actor.site_id)).all()
            by_original = {link.original_fill_id: link for link in links}
            by_replacement = {link.replacement_fill_id: link for link in links}

            def validate_member(ident: str) -> Fill:
                member = s.get(Fill, ident)
                if member is None or member.prescription_id != rx.id:
                    raise WorkflowError("Synthetic rebill lineage contains a broken or cross-Rx link")
                return member

            root = fill_id
            seen: set[str] = set()
            while root in by_replacement:
                if root in seen or len(seen) >= 64:
                    raise WorkflowError("Cyclic or excessive synthetic rebill lineage")
                seen.add(root)
                prior = by_replacement[root].original_fill_id
                validate_member(prior)
                root = prior

            chain = []
            attempts = []
            current = root
            seen = set()
            while True:
                if current in seen or len(seen) >= 64:
                    raise WorkflowError("Cyclic or excessive synthetic rebill lineage")
                seen.add(current)
                member = validate_member(current)
                attempts.append({
                    "fill_id": member.id, "fill_number": member.fill_number,
                    "attempt": member.attempt, "status": member.status,
                    "physical_quantity": str(member.quantity),
                    "payer_intended_quantity": str(member.billed_quantity),
                })
                edge = by_original.get(current)
                if edge is None:
                    break
                nxt = validate_member(edge.replacement_fill_id)
                if (nxt.fill_number != member.fill_number or
                        nxt.attempt != member.attempt + 1):
                    raise WorkflowError("Rebill lineage attempt numbers are inconsistent")
                chain.append({
                    "id": edge.id, "original_fill_id": edge.original_fill_id,
                    "replacement_fill_id": edge.replacement_fill_id,
                    "reversed_claim_ids": json.loads(edge.reversed_claim_ids_json),
                    "reason": edge.reason, "actor_id": edge.actor_id,
                    "created_at": edge.created_at.isoformat(),
                })
                current = nxt.id
            return {
                "fill_id": fill_id, "root_fill_id": root, "latest_fill_id": current,
                "links": chain, "attempts": attempts,
                "warning": "LOCAL_SYNTHETIC_HISTORY_NO_EXTERNAL_PAYER_REVERSAL",
            }
