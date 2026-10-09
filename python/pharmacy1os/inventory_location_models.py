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
