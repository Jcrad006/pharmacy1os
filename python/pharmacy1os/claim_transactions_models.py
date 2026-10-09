"""Append-only synthetic insurance operation requests, results and test rejects.

This is a deterministic local simulation ONLY. No eligibility, payer switch,
payment authorization, external transmission, or real COB occurs.
"""
from __future__ import annotations
from datetime import datetime
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow, uuid


class SandboxClaimTransaction(Base):
    __tablename__ = "py_sandbox_claim_transactions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, index=True)
    claim_id: Mapped[str | None] = mapped_column(ForeignKey("py_claims.id"), nullable=True, index=True)
    payer_id: Mapped[str | None] = mapped_column(ForeignKey("py_insurance_payers.id"), nullable=True)
    coverage_id: Mapped[str | None] = mapped_column(ForeignKey("py_patient_coverages.id"), nullable=True)
    original_transaction_id: Mapped[str | None] = mapped_column(
        ForeignKey("py_sandbox_claim_transactions.id"), nullable=True)
    operation: Mapped[str] = mapped_column(String(24), nullable=False)
    outcome: Mapped[str] = mapped_column(String(26), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    request_json: Mapped[str] = mapped_column(Text, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    request_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                   nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("operation IN ('BILL','REVERSE','TEST_REJECT','TEST_RESOLVE')",
                        name="ck_py_sandbox_claim_operation"),
        CheckConstraint("outcome IN ('PAID_SYNTHETIC','REVERSED_SYNTHETIC',"
                        "'REJECTED_SYNTHETIC','CLEARED_TEST_HOLD')",
                        name="ck_py_sandbox_claim_outcome"),
        UniqueConstraint("original_transaction_id", "operation",
                         name="uq_py_sandbox_claim_original_operation"),
        Index("ix_py_sandbox_claim_site_operation", "site_id", "operation"),
    )
