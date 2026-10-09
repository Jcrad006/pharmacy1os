"""Fill-specific, location-pinned physical allocations for the synthetic pharmacy.

Historical untracked fills deliberately have no fabricated allocation records.
Tracked scans create one allocation for each FillSource; verification consumes
and a cancelled/partially interrupted reservation releases that exact location.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .inventory_location_models import (
    InventoryAllocation, InventoryAllocationEvent,
    InventoryLocation, InventoryStockPosition,
)
from .models import Fill, FillSource, Prescription, Stock
from .service import Actor, PharmacyService, WorkflowError

ZERO = Decimal("0")


def record_scan_allocation(s: Session, actor: Actor, fill: Fill, stock: Stock,
                           source: FillSource, location_id: str | None) -> None:
    if not stock.location_tracking_enabled:
        if location_id is not None:
            raise WorkflowError("Location tracking must be activated before allocating a stock lot")
        return
    if not location_id:
        raise WorkflowError("Tracked stock requires an explicitly confirmed physical source location")
    location = s.scalar(select(InventoryLocation).where(
        InventoryLocation.id == location_id,
        InventoryLocation.site_id == actor.site_id,
        InventoryLocation.active.is_(True),
        InventoryLocation.is_quarantine.is_(False)))
    if location is None:
        raise WorkflowError("Selected physical pick location is missing, inactive or quarantined")
    pos = s.scalar(select(InventoryStockPosition).where(
        InventoryStockPosition.stock_id == stock.id,
        InventoryStockPosition.location_id == location.id).with_for_update())
    if pos is None or pos.reserved < source.quantity:
        raise WorkflowError("Physical source reservation was not established at the scanned location")
    if s.scalar(select(InventoryAllocation.id).where(
            InventoryAllocation.fill_source_id == source.id)):
        raise WorkflowError("Scanned FillSource already has an inventory allocation")
    row = InventoryAllocation(site_id=actor.site_id, fill_id=fill.id,
        stock_id=stock.id, fill_source_id=source.id, position_id=pos.id,
        quantity=source.quantity, status="ACTIVE", actor_id=actor.id)
    s.add(row)
    s.flush()
    s.add(InventoryAllocationEvent(site_id=actor.site_id, allocation_id=row.id,
        from_status=None, to_status="ACTIVE", actor_id=actor.id,
        reason="Explicit scanned product/location physical reservation"))
    PharmacyService._audit(s, actor, "PHYSICAL_FILL_SOURCE_ALLOCATED", row.id, {
        "fill_id": fill.id, "stock_id": stock.id, "location_id": location.id,
        "quantity": str(source.quantity), "status": "ACTIVE",
    })


def source_allocation(s: Session, actor: Actor, fill: Fill,
                      stock: Stock, source: FillSource) -> InventoryAllocation | None:
    row = s.scalar(select(InventoryAllocation).where(
        InventoryAllocation.site_id == actor.site_id,
        InventoryAllocation.fill_id == fill.id,
        InventoryAllocation.fill_source_id == source.id).with_for_update())
    if not stock.location_tracking_enabled:
        if row is not None:
            raise WorkflowError("Untracked lot unexpectedly has a physical allocation")
        return None
    if row is None or row.status != "ACTIVE":
        raise WorkflowError("Tracked source is missing an ACTIVE physical allocation")
    if row.stock_id != stock.id or row.quantity != source.quantity:
        raise WorkflowError("Allocation stock or physical quantity differs from source")
    pos = s.get(InventoryStockPosition, row.position_id)
    if pos is None or pos.stock_id != stock.id or pos.reserved < row.quantity:
        raise WorkflowError("Allocated physical bin no longer has sufficient reserved units")
    loc = s.get(InventoryLocation, pos.location_id)
    if loc is None or loc.site_id != actor.site_id or not loc.active:
        raise WorkflowError("Allocated location is no longer active at the site")
    return row


def allocation_location_id(s: Session, allocation: InventoryAllocation | None) -> str | None:
    if allocation is None:
        return None
    pos = s.get(InventoryStockPosition, allocation.position_id)
    if pos is None:
        raise WorkflowError("Physical allocation position no longer exists")
    return pos.location_id


def transition_allocation(s: Session, actor: Actor,
                          allocation: InventoryAllocation | None,
                          target: str, reason: str, *,
                          release_source_link: bool = False) -> None:
    if allocation is None:
        return
    if allocation.status != "ACTIVE" or target not in {"CONSUMED", "RELEASED"}:
        raise WorkflowError("Invalid or repeated physical allocation transition")
    allocation.status = target
    allocation.resolved_at = datetime.now(timezone.utc)
    allocation.resolution_reason = reason
    if release_source_link:
        # Partial interruptions delete the FillSource and preserve our original
        # allocation by unlinking just the optional foreign-key relationship.
        allocation.fill_source_id = None
    s.add(InventoryAllocationEvent(site_id=actor.site_id, allocation_id=allocation.id,
        from_status="ACTIVE", to_status=target, actor_id=actor.id, reason=reason))
    PharmacyService._audit(s, actor, "PHYSICAL_ALLOCATION_" + target, allocation.id, {
        "fill_id": allocation.fill_id, "stock_id": allocation.stock_id,
        "quantity": str(allocation.quantity), "status": target,
    })


class InventoryAllocationService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def for_fill(self, actor: Actor, fill_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            self.service._site(s, Prescription, fill.prescription_id, actor)
            rows = s.scalars(select(InventoryAllocation).where(
                InventoryAllocation.site_id == actor.site_id,
                InventoryAllocation.fill_id == fill.id)
                .order_by(InventoryAllocation.created_at, InventoryAllocation.id)).all()
            result = []
            for item in rows:
                pos = s.get(InventoryStockPosition, item.position_id)
                if pos is None:
                    raise WorkflowError("Allocation references a missing physical position")
                loc = s.get(InventoryLocation, pos.location_id)
                if loc is None or loc.site_id != actor.site_id:
                    raise WorkflowError("Physical allocation site mismatch")
                events = s.scalars(select(InventoryAllocationEvent).where(
                    InventoryAllocationEvent.allocation_id == item.id,
                    InventoryAllocationEvent.site_id == actor.site_id)
                    .order_by(InventoryAllocationEvent.occurred_at,
                              InventoryAllocationEvent.id)).all()
                result.append({
                    "id": item.id, "fill_id": fill.id,
                    "stock_id": item.stock_id, "source_id": item.fill_source_id,
                    "location_id": loc.id, "location_code": loc.code,
                    "quantity": str(item.quantity), "status": item.status,
                    "actor_id": item.actor_id,
                    "created_at": item.created_at.isoformat(),
                    "resolved_at": item.resolved_at.isoformat() if item.resolved_at else None,
                    "events": [{
                        "id": event.id, "from": event.from_status,
                        "to": event.to_status, "actor_id": event.actor_id,
                        "reason": event.reason,
                        "occurred_at": event.occurred_at.isoformat(),
                    } for event in events],
                    "warning": "SYNTHETIC_PHYSICAL_ALLOCATION_NOT_PRODUCTION_CUSTODY",
                })
            return result
