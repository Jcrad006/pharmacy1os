"""Synthetic-only receiving discrepancy register and immutable event history."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow, uuid


class ReceivingDiscrepancy(Base):
    __tablename__ = "py_receiving_discrepancies"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="OPEN", server_default="OPEN")
    purchase_order_id: Mapped[str | None] = mapped_column(ForeignKey("py_purchase_orders.id"))
    purchase_order_line_id: Mapped[str | None] = mapped_column(ForeignKey("py_purchase_order_lines.id"))
    receipt_id: Mapped[str | None] = mapped_column(ForeignKey("py_purchase_order_receipts.id"), index=True)
    expected_product_id: Mapped[str | None] = mapped_column(ForeignKey("py_products.id"))
    observed_product_id: Mapped[str | None] = mapped_column(ForeignKey("py_products.id"))
    expected_quantity: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    observed_quantity: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    note: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_reference: Mapped[str | None] = mapped_column(String(250))
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    resolved_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolution_note: Mapped[str | None] = mapped_column(Text)
    adjustment_movement_id: Mapped[str | None] = mapped_column(
        ForeignKey("py_inventory_movements.id"), unique=True)
    __table_args__ = (
        CheckConstraint("status IN ('OPEN','RESOLVED')", name="ck_py_receiving_discrepancy_status"),
        CheckConstraint("type IN ('SHORT_SHIPMENT','OVERAGE','WRONG_PRODUCT','DAMAGED_PRODUCT',"
                        "'LOT_EXPIRATION_MISMATCH','INVOICE_MISMATCH','DUPLICATE_SHIPMENT',"
                        "'UNEXPECTED_PRODUCT','OTHER')", name="ck_py_receiving_discrepancy_type"),
        CheckConstraint("expected_quantity IS NULL OR expected_quantity >= 0",
                        name="ck_py_receiving_expected_nonnegative"),
        CheckConstraint("observed_quantity IS NULL OR observed_quantity >= 0",
                        name="ck_py_receiving_observed_nonnegative"),
    )


class ReceivingDiscrepancyEvent(Base):
    """New events only; no editing or deletion of prior evidence."""
    __tablename__ = "py_receiving_discrepancy_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    discrepancy_id: Mapped[str] = mapped_column(
        ForeignKey("py_receiving_discrepancies.id"), nullable=False, index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    prior_status: Mapped[str | None] = mapped_column(String(12))
    next_status: Mapped[str] = mapped_column(String(12), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    adjustment_movement_id: Mapped[str | None] = mapped_column(ForeignKey("py_inventory_movements.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("next_status IN ('OPEN','RESOLVED')", name="ck_py_receiving_event_status"),
    )
