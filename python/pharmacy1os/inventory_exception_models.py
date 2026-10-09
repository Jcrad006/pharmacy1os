"""Persistent site-scoped stock exceptions and append-only reviewer event history."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow, uuid


class InventoryExceptionRecord(Base):
    __tablename__ = "py_inventory_exceptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fingerprint: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="OPEN", server_default="OPEN")
    severity: Mapped[str] = mapped_column(String(10), nullable=False, default="WARNING", server_default="WARNING")
    entity_type: Mapped[str] = mapped_column(String(40), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(36))
    title: Mapped[str] = mapped_column(String(250), nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    first_detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    acknowledged_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"))
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolution_note: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("site_id", "fingerprint", name="uq_py_inventory_exception_fingerprint"),
        CheckConstraint("status IN ('OPEN','ACKNOWLEDGED','RESOLVED')", name="ck_py_exception_status"),
        CheckConstraint("severity IN ('INFO','WARNING','HIGH')", name="ck_py_exception_severity"),
        CheckConstraint("type IN ('BELOW_REORDER_POINT','EXPIRING_SOON','STALE_RESERVATION',"
                        "'TRANSFER_STUCK','PURCHASE_ORDER_OVERDUE','UNALLOCATED_DEMAND',"
                        "'POSITION_IMBALANCE','MISSING_ACQUISITION_COST',"
                        "'PHYSICAL_STOCK_SHORTAGE')", name="ck_py_exception_type"),
    )


class InventoryExceptionEvent(Base):
    __tablename__ = "py_inventory_exception_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    exception_id: Mapped[str] = mapped_column(ForeignKey("py_inventory_exceptions.id"),
                                              nullable=False, index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    operation: Mapped[str] = mapped_column(String(25), nullable=False)
    previous_status: Mapped[str | None] = mapped_column(String(16))
    next_status: Mapped[str] = mapped_column(String(16), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("next_status IN ('OPEN','ACKNOWLEDGED','RESOLVED')",
                        name="ck_py_exception_event_status"),
    )
