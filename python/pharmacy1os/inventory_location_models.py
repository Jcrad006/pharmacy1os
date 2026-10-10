"""Opt-in, location-aware inventory tables for the synthetic pharmacy.

Locations/positions are distinct from legacy aggregate py_stock. A stock lot is
not considered reconciled until explicitly activated at a known location.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from sqlalchemy import (Boolean, CheckConstraint, DateTime, ForeignKey, Numeric, String, Text,
                        UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow, uuid

LOCATION_TYPES = frozenset({
    "SHELF", "BIN", "REFRIGERATOR", "FREEZER", "SAFE",
    "RECEIVING", "QUARANTINE", "RETURN_TO_VENDOR", "WILL_CALL", "OTHER",
})


class InventoryLocation(Base):
    __tablename__ = "py_inventory_locations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(48), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    type: Mapped[str] = mapped_column(String(30), nullable=False)
    barcode: Mapped[str | None] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    is_default_receiving: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                      default=False, server_default="false")
    is_default_dispensing: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                       default=False, server_default="false")
    is_quarantine: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                               default=False, server_default="false")
    temperature_min_c: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    temperature_max_c: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("site_id", "code", name="uq_py_location_site_code"),
        UniqueConstraint("site_id", "barcode", name="uq_py_location_site_barcode"),
        CheckConstraint(
            "type IN ('SHELF','BIN','REFRIGERATOR','FREEZER','SAFE','RECEIVING',"
            "'QUARANTINE','RETURN_TO_VENDOR','WILL_CALL','OTHER')",
            name="ck_py_location_type"),
        CheckConstraint("temperature_min_c IS NULL OR temperature_max_c IS NULL "
                        "OR temperature_min_c <= temperature_max_c",
                        name="ck_py_location_temp_range"),
    )


class InventoryStockPosition(Base):
    __tablename__ = "py_inventory_stock_positions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"), nullable=False, index=True)
    location_id: Mapped[str] = mapped_column(
        ForeignKey("py_inventory_locations.id"), nullable=False, index=True)
    available: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False,
                                               default=Decimal("0"), server_default="0")
    reserved: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False,
                                              default=Decimal("0"), server_default="0")
    quarantined: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False,
                                                 default=Decimal("0"), server_default="0")
    __table_args__ = (
        UniqueConstraint("stock_id", "location_id", name="uq_py_position_stock_location"),
        CheckConstraint("available >= 0 AND reserved >= 0 AND quarantined >= 0",
                        name="ck_py_position_nonnegative"),
    )


class InventoryPositionEvent(Base):
    """Append-only changes in physical locations and position quantities."""
    __tablename__ = "py_inventory_position_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"), nullable=False, index=True)
    from_location_id: Mapped[str | None] = mapped_column(
        ForeignKey("py_inventory_locations.id"))
    to_location_id: Mapped[str | None] = mapped_column(
        ForeignKey("py_inventory_locations.id"))
    event_type: Mapped[str] = mapped_column(String(35), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    state: Mapped[str] = mapped_column(String(25), nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                   nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_py_pos_event_positive"),
        CheckConstraint("state IN ('AVAILABLE','RESERVED','QUARANTINED')",
                        name="ck_py_pos_event_state"),
    )


class InventoryAllocation(Base):
    """Fill-specific reservation from an explicitly reconciled physical position."""
    __tablename__ = "py_inventory_allocations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, index=True)
    stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"), nullable=False, index=True)
    fill_source_id: Mapped[str | None] = mapped_column(
        ForeignKey("py_fill_sources.id", ondelete="SET NULL"), nullable=True, index=True)
    position_id: Mapped[str] = mapped_column(
        ForeignKey("py_inventory_stock_positions.id"), nullable=False, index=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="ACTIVE", server_default="ACTIVE")
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 nullable=False, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolution_reason: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("fill_source_id", name="uq_py_allocation_fill_source"),
        CheckConstraint("quantity > 0", name="ck_py_allocation_positive"),
        CheckConstraint("status IN ('ACTIVE','CONSUMED','RELEASED')",
                        name="ck_py_allocation_status"),
    )


class InventoryAllocationEvent(Base):
    """Append-only status-change ledger; old source may be unlinked after partial interruption."""
    __tablename__ = "py_inventory_allocation_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    allocation_id: Mapped[str] = mapped_column(
        ForeignKey("py_inventory_allocations.id"), nullable=False, index=True)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20), nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                  nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("to_status IN ('ACTIVE','CONSUMED','RELEASED')",
                        name="ck_py_allocation_event_status"),
    )
