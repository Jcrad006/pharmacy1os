"""Versioned Python-native future-fill scheduling metadata (synthetic only)."""
from __future__ import annotations

from datetime import datetime
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column
from .models import Base, utcnow, uuid


class ScheduledFill(Base):
    __tablename__ = "py_scheduled_fills"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), nullable=False, index=True)
    due_date: Mapped[str] = mapped_column(String(10), nullable=False)
    quantity: Mapped[str | None] = mapped_column(String(30), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    idempotency_key: Mapped[str] = mapped_column(String(100), nullable=False)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    started_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"), nullable=True)
    cancelled_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"), nullable=True)
    fill_id: Mapped[str | None] = mapped_column(ForeignKey("py_fills.id"), nullable=True, unique=True)
    cancelled_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __table_args__ = (
        UniqueConstraint("site_id", "idempotency_key", name="uq_py_scheduled_fills_key"),
        CheckConstraint("status IN ('PENDING', 'STARTED', 'CANCELLED')", name="ck_py_scheduled_fills_status"),
        Index("ux_py_scheduled_fills_one_pending_rx", "prescription_id", unique=True,
              sqlite_where=text("status = 'PENDING'"),
              postgresql_where=text("status = 'PENDING'")),
    )
