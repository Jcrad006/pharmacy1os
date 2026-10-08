"""Python billing profile revisions and append-only synthetic claim operations."""
from __future__ import annotations
from datetime import datetime
from decimal import Decimal
from sqlalchemy import (CheckConstraint, DateTime, ForeignKey, Index, Integer,
                        Numeric, String, Text, UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column
from .models import Base, uuid, utcnow


class PayerBillingProfile(Base):
    __tablename__ = "py_payer_billing_profiles"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    payer_name: Mapped[str] = mapped_column(String(120), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    max_physical_sources: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    billing_ndc_strategy: Mapped[str] = mapped_column(String(30), nullable=False, default="MAJORITY_NDC")
    full_authorized_quantity: Mapped[bool] = mapped_column(nullable=False, default=True)
    effective: Mapped[bool] = mapped_column(nullable=False, default=True)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("site_id", "payer_name", "version", name="uq_py_billing_profile_version"),
        CheckConstraint("version >= 1", name="ck_py_billing_version"),
        CheckConstraint("max_physical_sources BETWEEN 1 AND 4", name="ck_py_billing_max_sources"),
        CheckConstraint("billing_ndc_strategy IN ('MAJORITY_NDC', 'FIRST_SCANNED')",
                        name="ck_py_billing_strategy"),
        Index("ix_py_billing_site_payer", "site_id", "payer_name"),
    )


class ClaimOperation(Base):
    """Append-only event record; never overwrites a previous synthetic operation."""
    __tablename__ = "py_claim_operations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    claim_id: Mapped[str] = mapped_column(ForeignKey("py_claims.id"), nullable=False, index=True)
    profile_id: Mapped[str | None] = mapped_column(ForeignKey("py_payer_billing_profiles.id"), nullable=True)
    operation: Mapped[str] = mapped_column(String(20), nullable=False)
    payer_name: Mapped[str] = mapped_column(String(120), nullable=False)
    selected_ndc: Mapped[str] = mapped_column(String(30), nullable=False)
    billed_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    source_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("claim_id", "operation", name="uq_py_claim_operation_kind"),
        CheckConstraint("operation IN ('SYNTHETIC_PAID', 'SYNTHETIC_REVERSED')",
                        name="ck_py_claim_op_type"),
        CheckConstraint("billed_quantity > 0", name="ck_py_claim_positive"),
    )
