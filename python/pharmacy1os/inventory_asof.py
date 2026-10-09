"""Fail-closed historical projections from the synthetic stock movement ledger.

The legacy Prisma implementation sums movement deltas by timestamp. This port
additionally verifies that the *entire* Python movement chain is consecutive,
zero-origin and agrees with the current stock before trusting a past projection.
There is no historical acquisition-cost ledger in the current Python model.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select

from .models import InventoryMovement, Stock
from .service import Actor, PharmacyService, WorkflowError

ZERO = Decimal("0")


def _utc(value: str | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if not isinstance(value, str) or not value.strip() or len(value) > 50:
        raise WorkflowError("As-of time must be an ISO 8601 timestamp with UTC offset")
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise WorkflowError("Invalid historical timestamp") from exc
    if stamp.tzinfo is None or stamp.utcoffset() is None:
        raise WorkflowError("Historical time must carry a timezone offset")
    return stamp.astimezone(timezone.utc)


def _aware(value: datetime) -> datetime:
    # SQLite drops timezone information for DateTime(timezone=True); the
    # movement writer always uses utcnow, so SQLite's naive values are UTC.
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None
            else value.astimezone(timezone.utc))


def _snapshot(value: str, name: str) -> tuple[Decimal, Decimal, Decimal]:
    try:
        parsed = json.loads(value)
        a, b, c = (Decimal(str(parsed[key]))
                   for key in ("on_hand", "reserved", "quarantined"))
    except (KeyError, ValueError, TypeError, ArithmeticError) as exc:
        raise WorkflowError(f"Invalid {name} movement snapshot") from exc
    if (any(not v.is_finite() or v < 0 for v in (a, b, c))
            or b + c > a):
        raise WorkflowError(f"Unsafe {name} movement snapshot")
    return a, b, c


class HistoricalInventoryService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def as_of(self, actor: Actor, stock_id: str, at: str | None = None) -> dict[str, Any]:
        timestamp = _utc(at)
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            stock = self.service._site(s, Stock, stock_id, actor)
            movements = s.scalars(select(InventoryMovement).where(
                InventoryMovement.site_id == actor.site_id,
                InventoryMovement.stock_id == stock.id).order_by(
                InventoryMovement.created_at, InventoryMovement.id)).all()
            current = (stock.on_hand, stock.reserved, stock.quarantined)
            state = (ZERO, ZERO, ZERO)
            projection = state
            prev_date: datetime | None = None
            for movement in movements:
                occurred = _aware(movement.created_at)
                if prev_date is not None and occurred < prev_date:
                    raise WorkflowError("Inventory ledger timestamp ordering is invalid")
                prev_date = occurred
                before = _snapshot(movement.before_snapshot, "before")
                after = _snapshot(movement.after_snapshot, "after")
                deltas = (movement.on_hand_delta, movement.reserved_delta,
                          movement.quarantined_delta)
                if (before != state or after != tuple(x + y for x, y in zip(state, deltas))):
                    raise WorkflowError("Inventory movement chain is incomplete or inconsistent")
                state = after
                if occurred <= timestamp:
                    projection = state
            if state != current:
                raise WorkflowError("Inventory history does not reconcile to current balance")
            on_hand, reserved, quarantined = projection
            return {
                "stock_id": stock.id, "site_id": actor.site_id,
                "product_id": stock.product_id, "lot": stock.lot, "expires": stock.expires,
                "as_of": timestamp.isoformat(), "on_hand_quantity": str(on_hand),
                "reserved_quantity": str(reserved),
                "quarantined_quantity": str(quarantined),
                "available_quantity": str(on_hand - reserved - quarantined),
                "movements_as_of": sum(1 for m in movements if _aware(m.created_at) <= timestamp),
                "recorded_acquisition_cost": None,
                "warning": "HISTORICAL_QUANTITY_ONLY_COST_AND_PRE_LEDGER_STOCK_UNAVAILABLE",
            }
