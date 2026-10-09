"""Opt-in location-aware stock positions with aggregate-stock reconciliation.

Available/reserved/quarantined are PHYSICAL quantities whose sum equals the
original py_stock.on_hand. This is deliberately different from the legacy
Prisma inventory state model and does not yet implement per-fill allocations.

No old stock is silently assigned to a location. A pharmacist must explicitly
activate tracking from a verified site/location with zero reserved/quarantined
units. All later inventory movements for the lot are mirrored atomically.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .inventory_location_models import (
    LOCATION_TYPES, InventoryLocation, InventoryPositionEvent, InventoryStockPosition
)
from .models import Product, Stock, Site
from .service import Actor, PharmacyService, WorkflowError, positive

STATES = ("available", "reserved", "quarantined")
ZERO = Decimal("0")


def _text(value: str, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= maximum:
        raise WorkflowError(f"{label} is required (up to {maximum} characters)")
    return value.strip()


def _event(s: Session, actor: Actor, stock: Stock, *,
           kind: str, state: str, quantity: Decimal,
           from_id: str | None = None, to_id: str | None = None,
           reason: str) -> None:
    if quantity <= 0:
        raise WorkflowError("Physical location audit quantity must be positive")
    s.add(InventoryPositionEvent(
        site_id=actor.site_id, stock_id=stock.id, from_location_id=from_id,
        to_location_id=to_id, event_type=kind, state=state.upper(),
        quantity=quantity, actor_id=actor.id, reason=reason))


def _positions(s: Session, stock: Stock) -> list[tuple[InventoryStockPosition, InventoryLocation]]:
    rows = s.execute(select(InventoryStockPosition, InventoryLocation)
        .join(InventoryLocation, InventoryStockPosition.location_id == InventoryLocation.id)
        .where(InventoryStockPosition.stock_id == stock.id,
               InventoryLocation.site_id == stock.site_id)
        .with_for_update(of=InventoryStockPosition)).all()
    return sorted(rows, key=lambda row: (
        not row[1].is_default_dispensing, row[1].code, row[0].id))


def _ensure_position(s: Session, stock: Stock, location: InventoryLocation,
                     positions: list[tuple[InventoryStockPosition, InventoryLocation]]
                     ) -> InventoryStockPosition:
    for pos, loc in positions:
        if loc.id == location.id:
            return pos
    position = InventoryStockPosition(stock_id=stock.id, location_id=location.id,
        available=ZERO, reserved=ZERO, quarantined=ZERO)
    s.add(position)
    positions.append((position, location))
    return position


def _default_location(s: Session, site_id: str) -> InventoryLocation:
    default = s.scalar(select(InventoryLocation).where(
        InventoryLocation.site_id == site_id, InventoryLocation.active.is_(True),
        InventoryLocation.is_default_receiving.is_(True),
        InventoryLocation.is_quarantine.is_(False)).order_by(InventoryLocation.code).limit(1))
    if default is None:
        raise WorkflowError("Create an active default receiving inventory location first")
    return default


def _verify(s: Session, stock: Stock) -> None:
    positions = _positions(s, stock)
    sums = {name: sum((getattr(p, name) for p, _ in positions), ZERO)
            for name in STATES}
    expected = {
        "available": stock.on_hand - stock.reserved - stock.quarantined,
        "reserved": stock.reserved,
        "quarantined": stock.quarantined,
    }
    for key in STATES:
        if sums[key] != expected[key]:
            raise WorkflowError(
                f"Physical inventory location discrepancy for {key}: "
                f"location {sums[key]}, aggregate {expected[key]}")
    if stock.location_tracking_enabled and stock.on_hand > 0 and not positions:
        raise WorkflowError("Tracked stock has no physical location")


def mirror_movement(s: Session, actor: Actor, stock: Stock, *,
                    on_hand: Decimal, reserved: Decimal, quarantined: Decimal,
                    kind: str, reason: str | None = None,
                    location_id: str | None = None) -> None:
    """Called inside record_movement, after aggregate fields mutate.

    The movements' aggregate delta is distributed across existing physical
    positions. Reserved and quarantined units cannot be relocated as available
    units. Both ledgers must sum exactly before commit or the entire transaction
    raises and rolls back.
    """
    if not stock.location_tracking_enabled:
        if location_id is not None:
            raise WorkflowError("Choose a stock location only after position tracking is activated")
        return

    rows = _positions(s, stock)
    if not rows:
        raise WorkflowError("Tracked stock has no reconciled position")
    initial = {
        "available": stock.on_hand - on_hand - (stock.reserved - reserved)
                     - (stock.quarantined - quarantined),
        "reserved": stock.reserved - reserved,
        "quarantined": stock.quarantined - quarantined,
    }
    for state in STATES:
        observed = sum((getattr(p, state) for p, _ in rows), ZERO)
        if observed != initial[state]:
            raise WorkflowError("Stock position and aggregate balance differ before movement")

    delta = {
        "available": on_hand - reserved - quarantined,
        "reserved": reserved,
        "quarantined": quarantined,
    }
    preferred = None
    if location_id is not None:
        preferred = s.scalar(select(InventoryLocation).where(
            InventoryLocation.id == location_id,
            InventoryLocation.site_id == actor.site_id,
            InventoryLocation.active.is_(True)))
        if preferred is None:
            raise WorkflowError("Selected stock location is unavailable at the pharmacy site")
    consumed: list[list[Any]] = []  # location, remaining physical units consumed
    for state in STATES:
        remaining = -delta[state]
        if remaining <= 0:
            continue
        ordered = rows
        if preferred is not None and state == "available":
            ordered = [(p, loc) for p, loc in rows if loc.id == preferred.id]
        for pos, loc in ordered:
            if remaining <= 0:
                break
            if not loc.active:
                # A location may be retired only when empty.
                if getattr(pos, state) > 0:
                    raise WorkflowError("Inactive inventory location still contains physical stock")
                continue
            n = min(getattr(pos, state), remaining)
            if n > 0:
                setattr(pos, state, getattr(pos, state) - n)
                consumed.append([loc, n])
                remaining -= n
                _event(s, actor, stock, kind=kind, state=state, quantity=n,
                       from_id=loc.id, reason=reason or kind)
        if remaining > 0:
            raise WorkflowError("Insufficient stock in the selected physical location")

    for state in STATES:
        remaining = delta[state]
        if remaining <= 0:
            continue
        for entry in consumed:
            if remaining <= 0:
                break
            loc, available = entry
            if available <= 0:
                continue
            n = min(available, remaining)
            pos = _ensure_position(s, stock, loc, rows)
            setattr(pos, state, getattr(pos, state) + n)
            entry[1] -= n
            remaining -= n
            _event(s, actor, stock, kind=kind, state=state, quantity=n,
                   to_id=loc.id, reason=reason or kind)
        if remaining > 0:
            default = _default_location(s, actor.site_id)
            pos = _ensure_position(s, stock, default, rows)
            setattr(pos, state, getattr(pos, state) + remaining)
            _event(s, actor, stock, kind=kind, state=state, quantity=remaining,
                   to_id=default.id, reason=reason or kind)

    s.flush()
    _verify(s, stock)


class InventoryLocationService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def locations(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rows = s.scalars(select(InventoryLocation).where(
                InventoryLocation.site_id == actor.site_id)
                .order_by(InventoryLocation.code)).all()
            return [{
                "id": l.id, "code": l.code, "name": l.name, "type": l.type,
                "barcode": l.barcode, "active": l.active,
                "is_default_receiving": l.is_default_receiving,
                "is_default_dispensing": l.is_default_dispensing,
                "is_quarantine": l.is_quarantine,
                "temperature_min_c": str(l.temperature_min_c) if l.temperature_min_c is not None else None,
                "temperature_max_c": str(l.temperature_max_c) if l.temperature_max_c is not None else None,
            } for l in rows]

    def create(self, actor: Actor, code: str, name: str, type: str, *,
               barcode: str | None = None, is_default_receiving: bool = False,
               is_default_dispensing: bool = False, is_quarantine: bool = False,
               temperature_min_c: str | None = None,
               temperature_max_c: str | None = None) -> str:
        location_code = _text(code, "Location code", 48).upper()
        location_name = _text(name, "Location name", 160)
        if type not in LOCATION_TYPES:
            raise WorkflowError("Invalid physical location type")
        if (any(not isinstance(v, bool) for v in
                (is_default_receiving, is_default_dispensing, is_quarantine))
            or is_quarantine and (is_default_receiving or is_default_dispensing)):
            raise WorkflowError("Quarantine cannot be a regular receiving/dispensing location")
        if is_quarantine and type != "QUARANTINE":
            raise WorkflowError("Quarantine location must have type QUARANTINE")
        if type == "QUARANTINE" and not is_quarantine:
            raise WorkflowError("QUARANTINE type requires quarantine flag")
        bar = _text(barcode, "Location barcode", 100).upper() if barcode else None
        try:
            minimum = Decimal(temperature_min_c) if temperature_min_c is not None else None
            maximum = Decimal(temperature_max_c) if temperature_max_c is not None else None
        except (InvalidOperation, TypeError) as exc:
            raise WorkflowError("Invalid location temperature range") from exc
        for value in (minimum, maximum):
            if value is not None and (not value.is_finite() or value.as_tuple().exponent < -2
                                       or abs(value) >= 10000):
                raise WorkflowError("Temperature must be finite and use two decimals at most")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise WorkflowError("Temperature minimum cannot exceed maximum")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            site = s.scalar(select(Site).where(Site.id == actor.site_id).with_for_update())
            if site is None:
                raise WorkflowError("Pharmacy site not found")
            existing = s.scalars(select(InventoryLocation).where(
                InventoryLocation.site_id == actor.site_id)).all()
            if any(x.code == location_code for x in existing):
                raise WorkflowError("Duplicate location code at this site")
            if bar and any(x.barcode == bar for x in existing):
                raise WorkflowError("Duplicate location barcode at this site")
            for row in existing:
                if is_default_receiving:
                    row.is_default_receiving = False
                if is_default_dispensing:
                    row.is_default_dispensing = False
                # Multiple designated quarantine locations may coexist.
                # Never silently demote a location holding quarantined stock.
            row = InventoryLocation(site_id=actor.site_id, code=location_code,
                name=location_name, type=type, barcode=bar,
                is_default_receiving=is_default_receiving,
                is_default_dispensing=is_default_dispensing,
                is_quarantine=is_quarantine,
                temperature_min_c=minimum, temperature_max_c=maximum)
            s.add(row); s.flush()
            self.service._audit(s, actor, "INVENTORY_LOCATION_CREATED", row.id,
                {"code": row.code, "type": type, "default_receiving": is_default_receiving,
                 "default_dispensing": is_default_dispensing, "quarantine": is_quarantine})
            return row.id

    def activate_stock(self, actor: Actor, stock_id: str,
                       location_id: str, attestation: str) -> None:
        note = _text(attestation, "Physical stock reconciliation attestation", 2000)
        if len(note) < 12:
            raise WorkflowError("Physical reconciliation attestation requires at least 12 characters")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            stock = s.scalar(select(Stock).where(
                Stock.id == stock_id, Stock.site_id == actor.site_id).with_for_update())
            location = s.scalar(select(InventoryLocation).where(
                InventoryLocation.id == location_id,
                InventoryLocation.site_id == actor.site_id,
                InventoryLocation.active.is_(True)))
            if stock is None or location is None or location.is_quarantine:
                raise WorkflowError("Active nonquarantine location and site stock are required")
            if stock.location_tracking_enabled:
                raise WorkflowError("Location tracking is already enabled for this lot")
            if stock.reserved != 0 or stock.quarantined != 0:
                raise WorkflowError("Resolve all reserved/quarantined stock before reconciling locations")
            if s.scalar(select(InventoryStockPosition.id).where(
                    InventoryStockPosition.stock_id == stock.id)) is not None:
                raise WorkflowError("Physical stock location records already exist")
            position = InventoryStockPosition(stock_id=stock.id, location_id=location.id,
                available=stock.on_hand, reserved=ZERO, quarantined=ZERO)
            s.add(position)
            stock.location_tracking_enabled = True
            if stock.on_hand > 0:
                _event(s, actor, stock, kind="INITIAL_RECONCILIATION", state="available",
                    quantity=stock.on_hand, to_id=location.id, reason=note)
            s.flush()
            _verify(s, stock)
            self.service._audit(s, actor, "LOCATION_RECONCILIATION_ACTIVATED", stock.id,
                {"location_id": location.id, "quantity": str(stock.on_hand),
                 "attestation": note})

    def positions(self, actor: Actor, stock_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            stock = self.service._site(s, Stock, stock_id, actor)
            if stock.location_tracking_enabled:
                _verify(s, stock)
            rows = _positions(s, stock)
            return [{
                "location_id": loc.id, "code": loc.code,
                "available": str(pos.available), "reserved": str(pos.reserved),
                "quarantined": str(pos.quarantined),
                "location_tracking_enabled": stock.location_tracking_enabled,
            } for pos, loc in rows]

    def move(self, actor: Actor, stock_id: str, from_location_id: str,
             to_location_id: str, quantity: str, reason: str) -> None:
        qty = positive(quantity)
        note = _text(reason, "Physical move reason", 2000)
        if from_location_id == to_location_id:
            raise WorkflowError("Physical move requires different source and destination locations")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            stock = s.scalar(select(Stock).where(
                Stock.id == stock_id, Stock.site_id == actor.site_id).with_for_update())
            if stock is None or not stock.location_tracking_enabled:
                raise WorkflowError("Stock has not been reconciled to physical locations")
            rows = _positions(s, stock)
            locations = {loc.id: loc for _, loc in rows}
            dest = s.scalar(select(InventoryLocation).where(
                InventoryLocation.id == to_location_id,
                InventoryLocation.site_id == actor.site_id,
                InventoryLocation.active.is_(True)))
            src = locations.get(from_location_id)
            if src is None or not src.active or src.is_quarantine:
                raise WorkflowError("Source location is unavailable for moving free stock")
            if dest is None or dest.is_quarantine:
                raise WorkflowError("Destination must be an active nonquarantine location")
            src_position = next(pos for pos, loc in rows if loc.id == src.id)
            if src_position.available < qty:
                raise WorkflowError("Cannot move stock reserved, quarantined, or absent from source location")
            dest_position = _ensure_position(s, stock, dest, rows)
            src_position.available -= qty
            dest_position.available += qty
            _event(s, actor, stock, kind="LOCATION_MOVE", state="available",
                   quantity=qty, from_id=src.id, to_id=dest.id, reason=note)
            s.flush()
            _verify(s, stock)
            self.service._audit(s, actor, "INVENTORY_LOCATION_MOVED", stock.id,
                {"from_location_id": src.id, "to_location_id": dest.id,
                 "quantity": str(qty), "reason": note})

    def fefo_recommendations(self, actor: Actor, product_id: str, *,
                             minimum_shelf_life_days: int = 0) -> list[dict[str, Any]]:
        """Read-only FEFO advisory; does not allocate, reserve or override pharmacist."""
        if isinstance(minimum_shelf_life_days, bool) or not isinstance(
                minimum_shelf_life_days, int) or not 0 <= minimum_shelf_life_days <= 3650:
            raise WorkflowError("Minimum shelf-life days must be 0–3650")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            product = s.get(Product, product_id)
            if product is None or not product.active:
                raise WorkflowError("Active product required for FEFO lookup")
            rows = s.execute(select(Stock, InventoryStockPosition, InventoryLocation)
                .join(InventoryStockPosition, InventoryStockPosition.stock_id == Stock.id)
                .join(InventoryLocation, InventoryStockPosition.location_id == InventoryLocation.id)
                .where(Stock.site_id == actor.site_id,
                       Stock.product_id == product_id,
                       Stock.location_tracking_enabled.is_(True),
                       InventoryLocation.site_id == actor.site_id,
                       InventoryLocation.active.is_(True),
                       InventoryLocation.is_quarantine.is_(False),
                       InventoryStockPosition.available > ZERO)).all()
            available = []
            for stock, pos, loc in rows:
                expires = date.fromisoformat(stock.expires)
                if (expires <= date.today() or
                        (expires - date.today()).days < minimum_shelf_life_days):
                    continue
                available.append({
                    "stock_id": stock.id, "location_id": loc.id, "location_code": loc.code,
                    "lot": stock.lot, "expires": stock.expires,
                    "ndc": product.ndc, "available": str(pos.available),
                    "default_dispensing": loc.is_default_dispensing,
                    "warning": "FEFO_ADVISORY_ONLY_NOT_AN_ALLOCATED_OR_VERIFIED_PICK",
                })
            return sorted(available, key=lambda item: (
                item["expires"], not item["default_dispensing"],
                item["location_code"], item["lot"], item["stock_id"]))
