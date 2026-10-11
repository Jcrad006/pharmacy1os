"""Receiving discrepancy investigation and pharmacist sign-off (synthetic only).

Recording or resolving a discrepancy NEVER mutates a stock balance. An already
recorded MANUAL_ADJUST movement can be linked as evidence, but only when the
discrepancy and the movement belong to the same site and receipt stock.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select

from .inventory_discrepancy_models import ReceivingDiscrepancy, ReceivingDiscrepancyEvent
from .models import (
    InventoryMovement, Product, PurchaseOrder, PurchaseOrderLine,
    PurchaseOrderReceipt, Site, Stock, utcnow,
)
from .service import Actor, PharmacyService, WorkflowError

DISCREPANCY_TYPES = frozenset({
    "SHORT_SHIPMENT", "OVERAGE", "WRONG_PRODUCT", "DAMAGED_PRODUCT",
    "LOT_EXPIRATION_MISMATCH", "INVOICE_MISMATCH", "DUPLICATE_SHIPMENT",
    "UNEXPECTED_PRODUCT", "OTHER",
})
MAX_QTY = Decimal("999999999.999")


def _note(value: str | None, name: str, *, max_length: int = 3000) -> str:
    note = value.strip() if isinstance(value, str) else ""
    if len(note) < 12 or len(note) > max_length:
        raise WorkflowError(f"{name} must contain 12-{max_length} characters")
    return note


def _optional_quantity(raw: str | None) -> Decimal | None:
    if raw is None:
        return None
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise WorkflowError("Observed/expected quantity must be a decimal") from exc
    if (not value.is_finite() or value < 0 or value > MAX_QTY
            or value.as_tuple().exponent < -3):
        raise WorkflowError("Discrepancy quantity must be nonnegative, within range and at most 3 decimals")
    return value


def _optional_reference(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if len(trimmed) > 250:
        raise WorkflowError("Evidence reference is too long")
    return trimmed


def _record_event(s, actor: Actor, row: ReceivingDiscrepancy, action: str,
                  prior: str | None, note: str) -> None:
    s.add(ReceivingDiscrepancyEvent(
        site_id=actor.site_id, discrepancy_id=row.id, actor_id=actor.id,
        action=action, prior_status=prior, next_status=row.status, note=note,
        adjustment_movement_id=row.adjustment_movement_id,
    ))


class ReceivingDiscrepancyService:
    def __init__(self, service: PharmacyService):
        self.service = service

    @staticmethod
    def _serial(row: ReceivingDiscrepancy) -> dict[str, Any]:
        return {
            "id": row.id, "site_id": row.site_id, "type": row.type, "status": row.status,
            "purchase_order_id": row.purchase_order_id,
            "purchase_order_line_id": row.purchase_order_line_id,
            "receipt_id": row.receipt_id,
            "expected_product_id": row.expected_product_id,
            "observed_product_id": row.observed_product_id,
            "expected_quantity": str(row.expected_quantity) if row.expected_quantity is not None else None,
            "observed_quantity": str(row.observed_quantity) if row.observed_quantity is not None else None,
            "note": row.note, "evidence_reference": row.evidence_reference,
            "created_by_id": row.created_by_id, "created_at": row.created_at.isoformat(),
            "resolved_by_id": row.resolved_by_id,
            "resolved_at": row.resolved_at.isoformat() if row.resolved_at else None,
            "resolution_note": row.resolution_note,
            "adjustment_movement_id": row.adjustment_movement_id,
            "warning": "RESOLUTION_DOES_NOT_ALTER_PHYSICAL_INVENTORY",
        }

    def list(self, actor: Actor, status: str | None = None) -> list[dict[str, Any]]:
        if status is not None and status not in {"OPEN", "RESOLVED"}:
            raise WorkflowError("Invalid discrepancy status filter")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            query = select(ReceivingDiscrepancy).where(
                ReceivingDiscrepancy.site_id == actor.site_id)
            if status is not None:
                query = query.where(ReceivingDiscrepancy.status == status)
            rows = s.scalars(query.order_by(
                ReceivingDiscrepancy.status, ReceivingDiscrepancy.created_at.desc(),
                ReceivingDiscrepancy.id)).all()
            return [self._serial(r) for r in rows]

    def history(self, actor: Actor, discrepancy_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            self.service._site(s, ReceivingDiscrepancy, discrepancy_id, actor)
            rows = s.scalars(select(ReceivingDiscrepancyEvent).where(
                ReceivingDiscrepancyEvent.site_id == actor.site_id,
                ReceivingDiscrepancyEvent.discrepancy_id == discrepancy_id).order_by(
                    ReceivingDiscrepancyEvent.created_at,
                    ReceivingDiscrepancyEvent.id)).all()
            return [{
                "id": e.id, "actor_id": e.actor_id, "action": e.action,
                "prior_status": e.prior_status, "next_status": e.next_status,
                "note": e.note, "adjustment_movement_id": e.adjustment_movement_id,
                "created_at": e.created_at.isoformat(),
            } for e in rows]

    def open(self, actor: Actor, type: str, *, note: str,
             purchase_order_id: str | None = None, purchase_order_line_id: str | None = None,
             receipt_id: str | None = None, expected_product_id: str | None = None,
             observed_product_id: str | None = None,
             expected_quantity: str | None = None, observed_quantity: str | None = None,
             evidence_reference: str | None = None) -> str:
        if type not in DISCREPANCY_TYPES:
            raise WorkflowError("Invalid receiving discrepancy category")
        description = _note(note, "Discrepancy evidence")
        expected = _optional_quantity(expected_quantity)
        observed = _optional_quantity(observed_quantity)
        evidence = _optional_reference(evidence_reference)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            order = self.service._site(s, PurchaseOrder, purchase_order_id, actor) if purchase_order_id else None
            line = s.get(PurchaseOrderLine, purchase_order_line_id) if purchase_order_line_id else None
            receipt = self.service._site(s, PurchaseOrderReceipt, receipt_id, actor) if receipt_id else None
            if receipt is not None:
                if line is not None and receipt.line_id != line.id:
                    raise WorkflowError("Receipt does not belong to selected order line")
                line = s.get(PurchaseOrderLine, receipt.line_id)
                if line is None:
                    raise WorkflowError("Receipt order line missing")
            if line is not None:
                linked_order = self.service._site(s, PurchaseOrder, line.order_id, actor)
                if order is not None and order.id != linked_order.id:
                    raise WorkflowError("Order line does not belong to selected order")
                order = linked_order
            if expected_product_id is not None and s.get(Product, expected_product_id) is None:
                raise WorkflowError("Expected product does not exist")
            if observed_product_id is not None and s.get(Product, observed_product_id) is None:
                raise WorkflowError("Observed product does not exist")
            if line is not None and expected_product_id is not None and line.product_id != expected_product_id:
                raise WorkflowError("Expected product conflicts with linked purchase order line")
            if not any((order, line, receipt, expected_product_id, observed_product_id, evidence)):
                raise WorkflowError("Reference a shipment, product or evidence identifier")
            row = ReceivingDiscrepancy(
                site_id=actor.site_id, type=type, purchase_order_id=order.id if order else None,
                purchase_order_line_id=line.id if line else None,
                receipt_id=receipt.id if receipt else None,
                expected_product_id=expected_product_id or (line.product_id if line else None),
                observed_product_id=observed_product_id,
                expected_quantity=expected, observed_quantity=observed, note=description,
                evidence_reference=evidence, created_by_id=actor.id,
            )
            s.add(row); s.flush()
            _record_event(s, actor, row, "OPENED", None, description)
            self.service._audit(s, actor, "RECEIVING_DISCREPANCY_OPENED", row.id, {
                "type": type, "purchase_order_id": row.purchase_order_id,
                "line_id": row.purchase_order_line_id, "receipt_id": row.receipt_id,
                "expected_quantity": str(expected) if expected is not None else None,
                "observed_quantity": str(observed) if observed is not None else None,
                "evidence_reference": evidence,
            })
            return row.id

    def resolve(self, actor: Actor, discrepancy_id: str, resolution_note: str,
                *, adjustment_movement_id: str | None = None) -> dict[str, Any]:
        reason = _note(resolution_note, "Pharmacist resolution")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            # Serialize resolution changes on PostgreSQL; no concurrent double sign-off.
            s.scalar(select(Site).where(Site.id == actor.site_id).with_for_update())
            row = s.scalar(select(ReceivingDiscrepancy).where(
                ReceivingDiscrepancy.id == discrepancy_id,
                ReceivingDiscrepancy.site_id == actor.site_id).with_for_update())
            if row is None:
                raise WorkflowError("Receiving discrepancy not found at site")
            if row.status != "OPEN":
                raise WorkflowError("Receiving discrepancy already resolved")
            if adjustment_movement_id is not None:
                if row.receipt_id is None:
                    raise WorkflowError("Stock correction evidence requires an associated receipt")
                movement = s.scalar(select(InventoryMovement).where(
                    InventoryMovement.id == adjustment_movement_id,
                    InventoryMovement.site_id == actor.site_id))
                receipt = s.get(PurchaseOrderReceipt, row.receipt_id)
                if (movement is None or movement.kind != "MANUAL_ADJUST"
                        or receipt is None or movement.stock_id != receipt.stock_id):
                    raise WorkflowError("Adjustment must be an existing manual correction to the same receipt stock")
                other = s.scalar(select(ReceivingDiscrepancy.id).where(
                    ReceivingDiscrepancy.adjustment_movement_id == adjustment_movement_id))
                if other is not None:
                    raise WorkflowError("Inventory correction movement already linked to another discrepancy")
            row.status = "RESOLVED"
            row.resolved_by_id = actor.id
            row.resolved_at = utcnow()
            row.resolution_note = reason
            row.adjustment_movement_id = adjustment_movement_id
            _record_event(s, actor, row, "RESOLVED", "OPEN", reason)
            self.service._audit(s, actor, "RECEIVING_DISCREPANCY_RESOLVED", row.id, {
                "resolution_note": reason,
                "adjustment_movement_id": adjustment_movement_id,
                "stock_changed_by_resolution": False,
            })
            s.flush()
            return self._serial(row)
