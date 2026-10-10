"""Versioned, append-only synthetic payer attempts and reversal associations.

Attempt 1 mirrors each old local BILL event. Attempt numbers are per logical
Claim (COB position); future attempts can be appended without overwriting the
original paid and reversal snapshots. This model does NOT perform adjudication.
"""
from __future__ import annotations

from datetime import datetime
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, Claim, Fill, Prescription, utcnow, uuid
from .claim_transactions_models import SandboxClaimTransaction
from .service import Actor, PharmacyService, WorkflowError


class SyntheticCobAttempt(Base):
    __tablename__ = "py_synthetic_cob_attempts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, index=True)
    claim_id: Mapped[str] = mapped_column(ForeignKey("py_claims.id"), nullable=False, index=True)
    coverage_position: Mapped[int] = mapped_column(Integer, nullable=False)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    paid_transaction_id: Mapped[str] = mapped_column(
        ForeignKey("py_sandbox_claim_transactions.id"), nullable=False, unique=True)
    request_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("claim_id", "attempt_number", name="uq_py_cob_claim_attempt"),
        CheckConstraint("coverage_position BETWEEN 1 AND 4", name="ck_py_cob_attempt_position"),
        CheckConstraint("attempt_number >= 1", name="ck_py_cob_attempt_positive"),
        Index("ix_py_cob_attempt_site_fill_position",
              "site_id", "fill_id", "coverage_position"),
    )


class SyntheticCobAttemptReversal(Base):
    __tablename__ = "py_synthetic_cob_attempt_reversals"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    attempt_id: Mapped[str] = mapped_column(
        ForeignKey("py_synthetic_cob_attempts.id"), nullable=False, unique=True)
    reversal_transaction_id: Mapped[str] = mapped_column(
        ForeignKey("py_sandbox_claim_transactions.id"), nullable=False, unique=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 nullable=False, default=utcnow)


def mirror_paid_attempt_tx(s, actor: Actor, claim: Claim,
                           paid: SandboxClaimTransaction) -> SyntheticCobAttempt:
    """Must share the same transaction as the synthetic claim and BILL event."""
    if (paid.operation != "BILL" or paid.outcome != "PAID_SYNTHETIC"
            or paid.site_id != actor.site_id or paid.claim_id != claim.id
            or paid.fill_id != claim.fill_id or not 1 <= claim.sequence <= 4):
        raise WorkflowError("Cannot mirror mismatched local paid claim")
    if s.scalar(select(SyntheticCobAttempt.id).where(
            SyntheticCobAttempt.claim_id == claim.id)):
        raise WorkflowError("Legacy billing path cannot append a repeat payer attempt")
    row = SyntheticCobAttempt(
        site_id=actor.site_id, fill_id=claim.fill_id, claim_id=claim.id,
        coverage_position=claim.sequence, attempt_number=1,
        paid_transaction_id=paid.id, request_sha256=paid.request_sha256,
        actor_id=actor.id)
    s.add(row)
    s.flush()
    return row


def mirror_reversal_tx(s, actor: Actor, claim: Claim,
                       paid: SandboxClaimTransaction,
                       reversed_tx: SandboxClaimTransaction) -> None:
    """Create a single immutable reversal association for the original attempt."""
    if (reversed_tx.operation != "REVERSE"
            or reversed_tx.outcome != "REVERSED_SYNTHETIC"
            or reversed_tx.site_id != actor.site_id
            or reversed_tx.original_transaction_id != paid.id
            or reversed_tx.claim_id != claim.id
            or paid.claim_id != claim.id):
        raise WorkflowError("Cannot mirror mismatched local reversal")
    attempt = s.scalar(select(SyntheticCobAttempt).where(
        SyntheticCobAttempt.site_id == actor.site_id,
        SyntheticCobAttempt.claim_id == claim.id,
        SyntheticCobAttempt.paid_transaction_id == paid.id))
    if attempt is None:
        raise WorkflowError("Original payer attempt missing; migrate synthetic history before reversal")
    if s.scalar(select(SyntheticCobAttemptReversal.id).where(
            SyntheticCobAttemptReversal.attempt_id == attempt.id)):
        raise WorkflowError("Synthetic claim attempt is already reversed")
    s.add(SyntheticCobAttemptReversal(
        site_id=actor.site_id, attempt_id=attempt.id,
        reversal_transaction_id=reversed_tx.id, actor_id=actor.id))


class CobAttemptRegistry:
    def __init__(self, service: PharmacyService):
        self.service = service

    def history(self, actor: Actor, fill_id: str) -> dict:
        """Validate provenance and expose the full read-only COB version timeline.

        Never infer a payer acceptance from Claim.status alone. Missing mirrors,
        broken original references, or changed request snapshots fail closed.
        """
        from .claim_transactions import _view
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            self.service._site(s, Prescription, fill.prescription_id, actor)
            claims = s.scalars(select(Claim).where(
                Claim.fill_id == fill.id).order_by(Claim.sequence)).all()
            transactions = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill.id,
                SandboxClaimTransaction.operation.in_(("BILL", "REVERSE")))).all()
            rows = s.scalars(select(SyntheticCobAttempt).where(
                SyntheticCobAttempt.site_id == actor.site_id,
                SyntheticCobAttempt.fill_id == fill.id).order_by(
                SyntheticCobAttempt.coverage_position,
                SyntheticCobAttempt.attempt_number)).all()
            reversed_rows = s.scalars(select(SyntheticCobAttemptReversal).where(
                SyntheticCobAttemptReversal.site_id == actor.site_id,
                SyntheticCobAttemptReversal.attempt_id.in_([r.id for r in rows]))).all() if rows else []
            reversals = {rev.attempt_id: rev for rev in reversed_rows}
            bill_ids = {tx.id for tx in transactions if tx.operation == "BILL"}
            reversal_ids = {tx.id for tx in transactions if tx.operation == "REVERSE"}
            if (bill_ids != {r.paid_transaction_id for r in rows}
                    or reversal_ids != {r.reversal_transaction_id for r in reversed_rows}
                    or len(bill_ids) != sum(tx.operation == "BILL" for tx in transactions)
                    or len(reversal_ids) != sum(tx.operation == "REVERSE" for tx in transactions)):
                raise WorkflowError("Versioned COB payer attempt lineage is incomplete; review migration")
            claims_by_id = {claim.id: claim for claim in claims}
            tx_by_id = {tx.id: tx for tx in transactions}
            grouped = {claim.id: [] for claim in claims}
            for attempt in rows:
                claim = claims_by_id.get(attempt.claim_id)
                tx = tx_by_id.get(attempt.paid_transaction_id)
                if (claim is None or tx is None or tx.claim_id != claim.id
                        or tx.operation != "BILL" or tx.outcome != "PAID_SYNTHETIC"
                        or tx.fill_id != fill.id or tx.original_transaction_id is not None
                        or attempt.coverage_position != claim.sequence
                        or attempt.request_sha256 != tx.request_sha256
                        or attempt.site_id != actor.site_id):
                    raise WorkflowError("COB payer attempt does not match immutable claim history")
                data = _view(tx)
                request = data["request"]
                if (request.get("fill_id") != fill.id
                        or request.get("coverage_position") != claim.sequence
                        or request.get("payer_name") != claim.payer
                        or request.get("payer_intended_quantity") != str(claim.billed_quantity)
                        or request.get("physical_part_quantity") != str(fill.quantity)):
                    raise WorkflowError("COB attempt's paid request snapshot is inconsistent")
                rev = reversals.get(attempt.id)
                if rev is not None:
                    original_reversal = tx_by_id.get(rev.reversal_transaction_id)
                    if (original_reversal is None or original_reversal.operation != "REVERSE"
                            or original_reversal.outcome != "REVERSED_SYNTHETIC"
                            or original_reversal.claim_id != claim.id
                            or original_reversal.fill_id != fill.id
                            or original_reversal.original_transaction_id != tx.id):
                        raise WorkflowError("COB payer attempt reversal ancestry is inconsistent")
                    _view(original_reversal)
                grouped[claim.id].append({
                    "attempt_id": attempt.id, "attempt_number": attempt.attempt_number,
                    "coverage_position": attempt.coverage_position,
                    "paid_transaction_id": attempt.paid_transaction_id,
                    "reversal_transaction_id": (rev.reversal_transaction_id if rev else None),
                    "state": "REVERSED_SYNTHETIC" if rev else "PAID_SYNTHETIC_LOCAL_ONLY",
                    "request_sha256": attempt.request_sha256,
                    "created_at": attempt.created_at.isoformat(),
                    "external_submission": False,
                })
            result_claims = []
            for claim in claims:
                history = grouped[claim.id]
                if [a["attempt_number"] for a in history] != list(range(1, len(history) + 1)):
                    raise WorkflowError("COB payer attempt version sequence is not contiguous")
                active = [a for a in history if a["state"] == "PAID_SYNTHETIC_LOCAL_ONLY"]
                if len(active) > 1:
                    raise WorkflowError("More than one active synthetic attempt in COB position")
                # Old Claim.status is only an interim projection; assert it
                # agrees for the single-attempt legacy lifecycle.
                if len(history) <= 1 and ((claim.status == "PAID_SYNTHETIC" and len(active) != 1)
                       or (claim.status == "REVERSED_SYNTHETIC" and len(active) != 0)):
                    raise WorkflowError("Claim status differs from versioned payer attempt ledger")
                result_claims.append({
                    "claim_id": claim.id, "payer_name": claim.payer,
                    "coverage_position": claim.sequence, "claim_status": claim.status,
                    "attempts": history, "current_paid_attempt_id":
                    (active[0]["attempt_id"] if active else None),
                })
            return {
                "fill_id": fill.id, "claim_positions": result_claims,
                "total_attempts": len(rows),
                "active_local_paid_positions": sum(
                    bool(x["current_paid_attempt_id"]) for x in result_claims),
                "warning": "VERSIONED_SYNTHETIC_LEDGER_ONLY_NO_LIVE_ADJUDICATION",
                "selective_reprocessing_enabled": False,
            }
