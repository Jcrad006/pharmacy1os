"""Synthetic inventory demand and backorder workflow with conservative coverage.

- READY means *advisory* coverage at the time of reconciliation, never a
  physical stock hold, a FEFO pick, a payer approval or an Rx fill authorization.
- All quantities are Decimal; stocked products must be active, unexpired and
  without an active lot/product recall.
- Shared hypothetical stock is never counted twice across fill demands.
- A product-specific demand cannot draw from an unrelated NDC.
- Prior Prisma demand records are not fabricated or silently backfilled.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .inventory_demand_models import InventoryDemand, InventoryDemandEvent
from .models import Drug, Fill, Product, Prescription, RecallCase, Site, Stock, utcnow
from .service import Actor, PharmacyService, WorkflowError, positive

ZERO = Decimal("0")
SOURCES = {"FILL", "COMPLETION", "REORDER", "MANUAL"}
OPEN = {"OPEN", "READY"}


def _note(value: str, *, minimum: int = 1) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= 1000:
        raise WorkflowError(f"Inventory demand note must be {minimum}–1000 characters")
    return value.strip()


def _day(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) != 10:
        raise WorkflowError("Needed-by date must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise WorkflowError("Invalid needed-by calendar date") from exc
    if parsed.isoformat() != value:
        raise WorkflowError("Needed-by date must be YYYY-MM-DD")
    return value


def _event(s: Session, actor: Actor, row: InventoryDemand, operation: str,
           previous: str | None, reason: str) -> None:
    s.add(InventoryDemandEvent(
        site_id=actor.site_id, demand_id=row.id, actor_id=actor.id,
        operation=operation, previous_status=previous, next_status=row.status,
        required_quantity=row.required_quantity,
        available_quantity=row.available_quantity, reason=reason))


def _stock_pool(s: Session, actor: Actor, drug_id: str) -> list[tuple[Stock, Product, Decimal]]:
    """Only structurally usable (active, unexpired, un-recalled) stock is counted."""
    today = date.today().isoformat()
    results = s.execute(select(Stock, Product).join(Product, Stock.product_id == Product.id)
        .where(Stock.site_id == actor.site_id, Product.drug_id == drug_id,
               Product.active.is_(True), Stock.expires > today)
        .order_by(Stock.expires, Product.ndc, Stock.lot, Stock.id)).all()
    recs = s.scalars(select(RecallCase).where(
        RecallCase.site_id == actor.site_id,
        RecallCase.status == "ACTIVE")).all()
    recalled = {(r.product_id, r.lot) for r in recs}
    output = []
    for stock, product in results:
        if (product.id, None) in recalled or (product.id, stock.lot) in recalled:
            continue
        usable = stock.on_hand - stock.reserved - stock.quarantined
        if usable > ZERO:
            output.append((stock, product, usable))
    return output


def reconcile_tx(s: Session, actor: Actor, drug_id: str, *,
                 reason: str = "Inventory availability recalculated") -> dict[str, Any]:
    """Reconcile open demand snapshots within the current SQL transaction.

    This records *advisory* stock cover, not inventory reservation. Future
    product scanning still independently enforces quantity/eligibility.
    """
    drug = s.get(Drug, drug_id)
    if drug is None:
        raise WorkflowError("Cannot reconcile an unknown drug")
    pool = _stock_pool(s, actor, drug_id)
    initial = sum((units for _, _, units in pool), ZERO)
    remaining = {stock.id: units for stock, _, units in pool}
    rows = s.scalars(select(InventoryDemand).where(
        InventoryDemand.site_id == actor.site_id,
        InventoryDemand.drug_id == drug_id,
        InventoryDemand.status.in_(("OPEN", "READY")))
        .order_by(InventoryDemand.needed_by.asc(),
                  InventoryDemand.created_at.asc(), InventoryDemand.id.asc())
        .with_for_update()).all()
    for row in rows:
        if row.source == "REORDER":
            # Reorders assess coverage but do not consume hypothetical patient stock.
            coverable = min(row.required_quantity, sum(
                (units for stock, product, units in pool
                 if row.product_id is None or product.id == row.product_id), ZERO))
        else:
            coverable = ZERO
            for stock, product, _ in pool:
                if row.product_id is not None and row.product_id != product.id:
                    continue
                if coverable == row.required_quantity:
                    break
                take = min(remaining[stock.id], row.required_quantity - coverable)
                if take > ZERO:
                    coverable += take
                    remaining[stock.id] -= take
        target = "READY" if coverable >= row.required_quantity else "OPEN"
        if row.available_quantity != coverable or row.status != target:
            previous = row.status
            row.status = target
            row.available_quantity = coverable
            row.updated_at = utcnow()
            _event(s, actor, row, "RECONCILED", previous, reason)
    s.flush()
    return {
        "drug_id": drug_id,
        "available_quantity": str(initial),
        "uncommitted_advisory_quantity": str(sum(remaining.values(), ZERO)),
        "demand_count": len(rows),
        "warning": "ADVISORY_SNAPSHOT_ONLY_NOT_RESERVED_OR_GUARANTEED",
    }


def record_fill_demand_tx(s: Session, actor: Actor, fill: Fill, rx: Prescription,
                          *, source: str = "FILL", note: str | None = None) -> str:
    """Automatically create a new synthetic fill demand exactly once."""
    if source not in {"FILL", "COMPLETION"}:
        raise WorkflowError("Invalid fill inventory demand source")
    previous = s.scalar(select(InventoryDemand).where(InventoryDemand.fill_id == fill.id))
    if previous is not None:
        raise WorkflowError("Inventory demand is already linked to this fill")
    row = InventoryDemand(
        site_id=actor.site_id, drug_id=rx.drug_id,
        product_id=rx.prescribed_product_id if rx.product_selection_directive == "DISPENSE_AS_WRITTEN" else None,
        fill_id=fill.id, source=source,
        required_quantity=fill.quantity, available_quantity=ZERO,
        needed_by=rx.do_not_fill_before,
        note=note, created_by_id=actor.id)
    s.add(row); s.flush()
    _event(s, actor, row, "CREATED", None, "Fill entered Product Fill workspace")
    reconcile_tx(s, actor, rx.drug_id, reason="New synthetic fill inventory demand")
    PharmacyService._audit(s, actor, "INVENTORY_DEMAND_CREATED", row.id, {
        "fill_id": fill.id, "drug_id": rx.drug_id,
        "required_quantity": str(row.required_quantity), "source": source,
    })
    return row.id


def update_fill_demand_tx(s: Session, actor: Actor, fill: Fill, rx: Prescription,
                          *, reason: str) -> None:
    row = s.scalar(select(InventoryDemand).where(
        InventoryDemand.site_id == actor.site_id,
        InventoryDemand.fill_id == fill.id).with_for_update())
    if row is None:
        return  # Legacy fill: never silently fabricate a historical demand.
    if row.status not in OPEN:
        raise WorkflowError("Cannot amend a fulfilled or cancelled inventory demand")
    if fill.quantity <= 0:
        raise WorkflowError("Inventory demand must have a positive physical fill target")
    previous = row.status
    row.required_quantity = fill.quantity
    row.available_quantity = ZERO
    row.status = "OPEN"
    row.updated_at = utcnow()
    _event(s, actor, row, "FILL_TARGET_CHANGED", previous, _note(reason))
    reconcile_tx(s, actor, rx.drug_id, reason="Partial fill target updated")


def fulfill_fill_demand_tx(s: Session, actor: Actor, fill: Fill,
                           rx: Prescription, *, product_id: str | None = None) -> None:
    row = s.scalar(select(InventoryDemand).where(
        InventoryDemand.site_id == actor.site_id,
        InventoryDemand.fill_id == fill.id).with_for_update())
    if row is None:
        return  # Explicit migration compatibility.
    if row.status not in OPEN:
        raise WorkflowError("Demand must be OPEN/READY to be marked fulfilled")
    if product_id is not None:
        product = s.get(Product, product_id)
        if product is None or product.drug_id != rx.drug_id:
            raise WorkflowError("Cannot fulfill demand with an unrelated product")
        if row.product_id is None:
            row.product_id = product_id
    old = row.status
    row.status = "FULFILLED"
    row.available_quantity = row.required_quantity
    row.fulfilled_at = utcnow()
    row.updated_at = utcnow()
    _event(s, actor, row, "FULFILLED", old,
           "Pharmacist verified physical source consumption, not a patient sale")
    PharmacyService._audit(s, actor, "INVENTORY_DEMAND_FULFILLED", row.id, {
        "fill_id": fill.id, "physical_quantity": str(row.required_quantity),
    })
    reconcile_tx(s, actor, rx.drug_id, reason="Pharmacist fill verification reconciled demand")


def cancel_fill_demand_tx(s: Session, actor: Actor, fill: Fill, rx: Prescription,
                          reason: str) -> None:
    row = s.scalar(select(InventoryDemand).where(
        InventoryDemand.site_id == actor.site_id,
        InventoryDemand.fill_id == fill.id).with_for_update())
    if row is None or row.status not in OPEN:
        return
    old = row.status
    row.status = "CANCELLED"
    row.updated_at = utcnow()
    _event(s, actor, row, "CANCELLED", old, _note(reason))
    PharmacyService._audit(s, actor, "INVENTORY_DEMAND_CANCELLED", row.id,
                            {"fill_id": fill.id, "reason": reason.strip()[:500]})
    reconcile_tx(s, actor, rx.drug_id, reason="Cancelled fill freed advisory demand")


class InventoryDemandService:
    def __init__(self, service: PharmacyService):
        self.service = service

    @staticmethod
    def _serialize(row: InventoryDemand) -> dict[str, Any]:
        return {
            "id": row.id, "site_id": row.site_id, "drug_id": row.drug_id,
            "product_id": row.product_id, "fill_id": row.fill_id,
            "source": row.source, "required_quantity": str(row.required_quantity),
            "available_quantity": str(row.available_quantity), "status": row.status,
            "needed_by": row.needed_by, "note": row.note,
            "updated_at": row.updated_at.isoformat(),
            "fulfilled_at": row.fulfilled_at.isoformat() if row.fulfilled_at else None,
            "warning": "ADVISORY_SNAPSHOT_NOT_PHYSICALLY_RESERVED",
        }

    def list(self, actor: Actor, *, drug_id: str | None = None) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            query = select(InventoryDemand).where(InventoryDemand.site_id == actor.site_id)
            if drug_id is not None:
                query = query.where(InventoryDemand.drug_id == drug_id)
            rows = s.scalars(query.order_by(InventoryDemand.status,
                InventoryDemand.needed_by, InventoryDemand.created_at, InventoryDemand.id)).all()
            return [self._serialize(row) for row in rows]

    def history(self, actor: Actor, demand_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            row = s.scalar(select(InventoryDemand).where(
                InventoryDemand.id == demand_id, InventoryDemand.site_id == actor.site_id))
            if row is None:
                raise WorkflowError("Inventory demand not found at this site")
            events = s.scalars(select(InventoryDemandEvent).where(
                InventoryDemandEvent.demand_id == row.id,
                InventoryDemandEvent.site_id == actor.site_id)
                .order_by(InventoryDemandEvent.created_at,
                          InventoryDemandEvent.id)).all()
            return [{
                "id": e.id, "operation": e.operation,
                "previous_status": e.previous_status, "next_status": e.next_status,
                "required_quantity": str(e.required_quantity),
                "available_quantity": str(e.available_quantity),
                "actor_id": e.actor_id, "reason": e.reason,
                "created_at": e.created_at.isoformat(),
            } for e in events]

    def create_manual(self, actor: Actor, drug_id: str, quantity: str, *,
                      source: str = "MANUAL", product_id: str | None = None,
                      needed_by: str | None = None, note: str) -> str:
        if source not in {"MANUAL", "REORDER"}:
            raise WorkflowError("Only manual or reorder requests may be created here")
        required = positive(quantity)
        written_note = _note(note, minimum=12)
        day = _day(needed_by)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            if s.get(Drug, drug_id) is None:
                raise WorkflowError("Drug does not exist")
            if product_id is not None:
                product = s.get(Product, product_id)
                if product is None or product.drug_id != drug_id or not product.active:
                    raise WorkflowError("Selected product does not belong to the active drug")
            row = InventoryDemand(
                site_id=actor.site_id, drug_id=drug_id, product_id=product_id,
                source=source, required_quantity=required, available_quantity=ZERO,
                needed_by=day, note=written_note, created_by_id=actor.id)
            s.add(row); s.flush()
            _event(s, actor, row, "CREATED", None, written_note)
            reconcile_tx(s, actor, drug_id, reason="Manual stock demand created")
            self.service._audit(s, actor, "INVENTORY_DEMAND_CREATED", row.id, {
                "source": source, "drug_id": drug_id,
                "product_id": product_id, "quantity": str(required),
                "needed_by": day, "note": written_note,
            })
            return row.id

    def cancel(self, actor: Actor, demand_id: str, reason: str) -> None:
        why = _note(reason)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            row = s.scalar(select(InventoryDemand).where(
                InventoryDemand.id == demand_id, InventoryDemand.site_id == actor.site_id)
                .with_for_update())
            if row is None:
                raise WorkflowError("Demand not found at pharmacy site")
            if row.source not in {"MANUAL", "REORDER"}:
                raise WorkflowError("Prescription-linked demands can only be cancelled with their fill")
            if row.status not in OPEN:
                raise WorkflowError("Only OPEN/READY requests can be cancelled")
            before = row.status
            row.status = "CANCELLED"
            row.updated_at = utcnow()
            _event(s, actor, row, "CANCELLED", before, why)
            self.service._audit(s, actor, "INVENTORY_DEMAND_CANCELLED", row.id, {
                "reason": why, "source": row.source,
            })
            reconcile_tx(s, actor, row.drug_id, reason="Manual inventory demand cancelled")

    def reconcile(self, actor: Actor, drug_id: str) -> dict[str, Any]:
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            s.scalar(select(Site).where(Site.id == actor.site_id).with_for_update())
            result = reconcile_tx(s, actor, drug_id)
            self.service._audit(s, actor, "INVENTORY_DEMAND_RECONCILED", drug_id,
                                {"count": result["demand_count"],
                                 "available": result["available_quantity"]})
            return result
