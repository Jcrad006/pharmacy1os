"""Site-scoped inventory demand/backorder with append-only status history.

Demand is an ADVISORY view of current usable inventory, never an allocation,
a prescription authorization, or a guarantee that units remain available.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow, uuid


class InventoryDemand(Base):
    __tablename__ = "py_inventory_demands"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    drug_id: Mapped[str] = mapped_column(ForeignKey("py_drugs.id"), nullable=False, index=True)
    product_id: Mapped[str | None] = mapped_column(ForeignKey("py_products.id"), index=True)
    fill_id: Mapped[str | None] = mapped_column(
        ForeignKey("py_fills.id"), unique=True, index=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    required_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    available_quantity: Mapped[Decimal] = mapped_column(
        Numeric(12, 3), nullable=False, default=Decimal("0"), server_default="0")
    status: Mapped[str] = mapped_column(
        String(15), nullable=False, default="OPEN", server_default="OPEN")
    needed_by: Mapped[str | None] = mapped_column(String(10))
    note: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow)
    fulfilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("source IN ('FILL','COMPLETION','REORDER','MANUAL')",
                        name="ck_py_demand_source"),
        CheckConstraint("status IN ('OPEN','READY','FULFILLED','CANCELLED')",
                        name="ck_py_demand_status"),
        CheckConstraint("required_quantity > 0 AND available_quantity >= 0",
                        name="ck_py_demand_quantities"),
    )


class InventoryDemandEvent(Base):
    """Append-only events; requests cannot silently rewrite demand history."""
    __tablename__ = "py_inventory_demand_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    demand_id: Mapped[str] = mapped_column(
        ForeignKey("py_inventory_demands.id"), nullable=False, index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    operation: Mapped[str] = mapped_column(String(32), nullable=False)
    previous_status: Mapped[str | None] = mapped_column(String(15))
    next_status: Mapped[str] = mapped_column(String(15), nullable=False)
    required_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    available_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("next_status IN ('OPEN','READY','FULFILLED','CANCELLED')",
                        name="ck_py_demand_event_status"),
    )
