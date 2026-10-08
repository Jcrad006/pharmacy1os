"""Append-only synthetic POS accounting for a Python-only workstation.

Amounts are manually supplied synthetic quotes; nothing in these tables is a
bank-card authorization, payment-processor receipt, or live payer settlement.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from sqlalchemy import (Boolean, CheckConstraint, DateTime, ForeignKey, Index,
                        Integer, Numeric, String, Text, UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column
from .models import Base, uuid, utcnow


class PosTransaction(Base):
    __tablename__ = "py_pos_transactions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("py_patients.id"), nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(120), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    mode: Mapped[str] = mapped_column(String(20), nullable=False)
    recipient_name: Mapped[str] = mapped_column(String(150), nullable=False)
    relationship: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    identity_method: Mapped[str] = mapped_column(String(30), nullable=False)
    signature_method: Mapped[str] = mapped_column(String(30), nullable=False)
    signature_attested: Mapped[bool] = mapped_column(Boolean, nullable=False)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(25), nullable=False, default="POSTED")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("site_id", "idempotency_key", name="uq_py_pos_idempotency"),
        CheckConstraint("subtotal >= 0", name="ck_py_pos_nonnegative"),
        CheckConstraint("mode IN ('WILL_CALL','IMMEDIATE')", name="ck_py_pos_mode"),
        CheckConstraint("status IN ('POSTED','PARTIAL_REFUND','REFUNDED','VOIDED')", name="ck_py_pos_status"),
    )


class PosLine(Base):
    __tablename__ = "py_pos_lines"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    transaction_id: Mapped[str] = mapped_column(ForeignKey("py_pos_transactions.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, unique=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    scanned_bag: Mapped[str | None] = mapped_column(String(100), nullable=True)
    __table_args__ = (CheckConstraint("amount >= 0", name="ck_py_pos_line_nonnegative"),)


class PosTender(Base):
    __tablename__ = "py_pos_tenders"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    transaction_id: Mapped[str] = mapped_column(ForeignKey("py_pos_transactions.id"), nullable=False, index=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    method: Mapped[str] = mapped_column(String(15), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    reference: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    __table_args__ = (
        UniqueConstraint("transaction_id", "sequence", name="uq_py_pos_tender_sequence"),
        CheckConstraint("amount > 0", name="ck_py_pos_tender_positive"),
        CheckConstraint("method IN ('CASH','CARD','CHECK','OTHER')", name="ck_py_pos_tender_method"),
    )


class PosFinancialEvent(Base):
    """Financial activity is never deleted, even if the sale status changes."""
    __tablename__ = "py_pos_financial_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    transaction_id: Mapped[str] = mapped_column(ForeignKey("py_pos_transactions.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    method: Mapped[str] = mapped_column(String(15), nullable=False)
    request_key: Mapped[str] = mapped_column(String(120), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("site_id", "request_key", name="uq_py_pos_financial_event_idempotency"),
        CheckConstraint("amount >= 0", name="ck_py_pos_event_nonnegative"),
        CheckConstraint("kind IN ('CAPTURE_SIMULATED','REFUND_SIMULATED','VOID_SIMULATED')", name="ck_py_pos_event_kind"),
        Index("ix_py_pos_events_tx_kind", "transaction_id", "kind"),
    )
