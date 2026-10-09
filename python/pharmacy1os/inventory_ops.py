"""Python port of the synthetic stock movement ledger and quarantine domain.

All movements and audit records are committed with the balance mutation. This
is NOT equivalent to the full original inventory subsystem or DSCSA tracking.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select

from .models import InventoryHold, InventoryMovement, Stock
from .service import Actor, PharmacyService, WorkflowError, positive

ZERO = Decimal("0")


def snapshot(stock: Stock) -> dict[str, str]:
    return {field: str(getattr(stock, field)) for field in ("on_hand", "reserved", "quarantined")}


def record_movement(s, actor: Actor, stock: Stock, kind: str,
                    *, on_hand: Decimal = ZERO, reserved: Decimal = ZERO,
                    quarantined: Decimal = ZERO, reason: str | None = None,
                    location_id: str | None = None) -> str:
    """Adjust a site-owned balance and stage an append-only movement atomically."""
    if stock.site_id != actor.site_id:
        raise WorkflowError("Stock is outside the actor's pharmacy site")
    before = snapshot(stock)
    next_hand = stock.on_hand + on_hand
    next_reserved = stock.reserved + reserved
    next_quarantine = stock.quarantined + quarantined
    if (next_hand < 0 or next_reserved < 0 or next_quarantine < 0
            or next_reserved + next_quarantine > next_hand):
        raise WorkflowError("Inventory movement violates balance/availability constraints")
    if on_hand == reserved == quarantined == ZERO:
        raise WorkflowError("Zero-quantity inventory movement is not permitted")
    stock.on_hand = next_hand
    stock.reserved = next_reserved
    stock.quarantined = next_quarantine
    from .inventory_locations import mirror_movement
    mirror_movement(s, actor, stock, on_hand=on_hand, reserved=reserved,
                    quarantined=quarantined, kind=kind, reason=reason,
                    location_id=location_id)
    movement = InventoryMovement(site_id=actor.site_id, stock_id=stock.id,
            actor_id=actor.id, kind=kind, on_hand_delta=on_hand,
            reserved_delta=reserved, quarantined_delta=quarantined,
            before_snapshot=json.dumps(before, sort_keys=True),
            after_snapshot=json.dumps(snapshot(stock), sort_keys=True), reason=reason)
    s.add(movement)
    s.flush()
    return movement.id


class InventoryService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def ledger(self, actor: Actor, stock_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            self.service._site(s, Stock, stock_id, actor)
            rows = s.scalars(select(InventoryMovement).where(
                InventoryMovement.stock_id == stock_id, InventoryMovement.site_id == actor.site_id)
                .order_by(InventoryMovement.created_at, InventoryMovement.id)).all()
            return [{"id": m.id, "kind": m.kind, "on_hand_delta": str(m.on_hand_delta),
                     "reserved_delta": str(m.reserved_delta),
                     "quarantined_delta": str(m.quarantined_delta),
                     "before": json.loads(m.before_snapshot), "after": json.loads(m.after_snapshot),
                     "reason": m.reason, "actor_id": m.actor_id} for m in rows]

    def create_hold(self, actor: Actor, stock_id: str, quantity: str, reason: str) -> str:
        qty = positive(quantity)
        if not reason.strip():
            raise WorkflowError("Quarantine requires a written reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            stock = self.service._site(s, Stock, stock_id, actor)
            # Lock stock for PostgreSQL; SQLite remains development only.
            stock = s.scalar(select(Stock).where(Stock.id == stock.id).with_for_update())
            movement = record_movement(s, actor, stock, "QUARANTINE", quarantined=qty,
                                       reason=reason.strip())
            hold = InventoryHold(site_id=actor.site_id, stock_id=stock.id,
                                 quantity=qty, reason=reason.strip(), status="ACTIVE",
                                 created_by_id=actor.id)
            s.add(hold); s.flush()
            self.service._audit(s, actor, "STOCK_QUARANTINED", hold.id,
                                {"stock_id": stock.id, "movement_id": movement,
                                 "quantity": str(qty), "reason": reason.strip()})
            return hold.id

    def resolve_hold(self, actor: Actor, hold_id: str, disposition: str,
                     reason: str) -> None:
        if disposition not in {"RELEASED", "DISPOSED"} or not reason.strip():
            raise WorkflowError("Release/dispose choice and documented reason required")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            hold = self.service._site(s, InventoryHold, hold_id, actor)
            if hold.status != "ACTIVE":
                raise WorkflowError("Hold already resolved")
            stock = s.scalar(select(Stock).where(Stock.id == hold.stock_id).with_for_update())
            if stock is None or stock.site_id != actor.site_id:
                raise WorkflowError("Hold stock is outside the pharmacy site")
            if disposition == "RELEASED":
                from .inventory_advanced import assert_not_recalled
                assert_not_recalled(s, stock)
            movement = record_movement(s, actor, stock, disposition,
                    on_hand=-hold.quantity if disposition == "DISPOSED" else ZERO,
                    quarantined=-hold.quantity, reason=reason.strip())
            hold.status = disposition
            hold.resolution_reason = reason.strip()
            hold.resolved_by_id = actor.id
            hold.resolved_at = datetime.now(timezone.utc)
            self.service._audit(s, actor, "STOCK_HOLD_RESOLVED", hold.id,
                                {"disposition": disposition, "movement_id": movement,
                                 "quantity": str(hold.quantity), "reason": reason.strip()})

    def adjust(self, actor: Actor, stock_id: str, delta: str, reason: str) -> None:
        if not reason.strip():
            raise WorkflowError("Manual stock adjustment requires a reason")
        try:
            number = Decimal(delta)
        except Exception as exc:
            raise WorkflowError("Invalid inventory adjustment quantity") from exc
        if not number.is_finite() or number == 0 or number.as_tuple().exponent < -3:
            raise WorkflowError("Adjustment must be nonzero and use at most three decimals")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            stock = self.service._site(s, Stock, stock_id, actor)
            stock = s.scalar(select(Stock).where(Stock.id == stock.id).with_for_update())
            movement = record_movement(s, actor, stock, "MANUAL_ADJUST", on_hand=number, reason=reason.strip())
            if number > 0:
                from .inventory_advanced import quarantine_recalled_receipt
                quarantine_recalled_receipt(s, actor, stock, number)
            self.service._audit(s, actor, "STOCK_ADJUSTED", stock.id,
                                {"delta": str(number), "reason": reason.strip(), "movement_id": movement})

    def active_holds(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            holds = s.scalars(select(InventoryHold).where(
                 InventoryHold.site_id == actor.site_id).order_by(InventoryHold.created_at, InventoryHold.id)).all()
            return [{"id": h.id, "stock_id": h.stock_id, "quantity": str(h.quantity),
                     "reason": h.reason, "status": h.status,
                     "resolution_reason": h.resolution_reason} for h in holds]
