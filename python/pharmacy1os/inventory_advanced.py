"""Synthetic Python ports of four legacy inventory workstreams.

Transactions preserve an auditable stock ledger; these are not validated
production supply-chain controls. SQLite is single-user development only.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select

from .inventory_ops import record_movement
from .models import (
    CycleCountLine, CycleCountSession, Fill, FillSource, InventoryHold, InventoryMovement,
    InventoryTransfer, Product, PurchaseOrder, PurchaseOrderLine,
    PurchaseOrderReceipt, RecallCase, RecallExposure, Site, Stock, Prescription,
)
from .service import Actor, PharmacyService, WorkflowError, positive

ZERO = Decimal("0")


def nonnegative(value: str | Decimal) -> Decimal:
    try:
        qty = Decimal(str(value))
    except (TypeError, InvalidOperation) as exc:
        raise WorkflowError("Count must be a valid decimal") from exc
    if not qty.is_finite() or qty < 0 or qty.as_tuple().exponent < -3:
        raise WorkflowError("Count must be nonnegative with at most three decimals")
    return qty


def _require_text(value: str, field: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise WorkflowError(f"{field} is required")
    return cleaned


def _lock_stock(s, stock_id: str, site_id: str) -> Stock:
    stock = s.scalar(select(Stock).where(Stock.id == stock_id, Stock.site_id == site_id).with_for_update())
    if stock is None:
        raise WorkflowError("Stock not found at pharmacy site")
    return stock


def _stock_for_receipt(s, site_id: str, product_id: str, lot: str, expires: str) -> Stock:
    _require_text(lot, "Lot number")
    try:
        if date.fromisoformat(expires) <= date.today():
            raise WorkflowError("Expired stock cannot be received as usable")
    except ValueError as exc:
        raise WorkflowError("Expiration must use YYYY-MM-DD") from exc
    stock = s.scalar(select(Stock).where(
        Stock.site_id == site_id, Stock.product_id == product_id,
        Stock.lot == lot, Stock.expires == expires).with_for_update())
    if stock is None:
        stock = Stock(site_id=site_id, product_id=product_id, lot=lot, expires=expires,
                      on_hand=ZERO, reserved=ZERO, quarantined=ZERO)
        s.add(stock)
        s.flush()
    return stock


def active_recall(s, site_id: str, product_id: str, lot: str) -> RecallCase | None:
    """Most specific match, including a product-wide active recall."""
    return s.scalar(select(RecallCase).where(
        RecallCase.site_id == site_id, RecallCase.product_id == product_id,
        RecallCase.status == "ACTIVE",
        (RecallCase.lot == lot) | (RecallCase.lot.is_(None)),
    ).order_by(RecallCase.lot.desc()))


def quarantine_recalled_available(s, actor: Actor, stock: Stock, recall: RecallCase) -> str | None:
    """Only stock not already reserved/quarantined can be auto-held.

    Any reserved stock is explicitly blocked at final pharmacist verification.
    """
    available = stock.on_hand - stock.reserved - stock.quarantined
    if available <= 0:
        return None
    reason = f"Active recall {recall.reference}: {recall.reason}"
    movement = record_movement(s, actor, stock, "RECALL_QUARANTINE", quarantined=available, reason=reason)
    hold = InventoryHold(site_id=actor.site_id, stock_id=stock.id, recall_id=recall.id,
                         quantity=available, reason=reason, status="ACTIVE", created_by_id=actor.id)
    s.add(hold)
    s.flush()
    PharmacyService._audit(s, actor, "RECALL_STOCK_HELD", hold.id,
                           {"recall_id": recall.id, "stock_id": stock.id,
                            "quantity": str(available), "movement_id": movement})
    return hold.id


class AdvancedInventoryService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def create_purchase_order(self, actor: Actor, vendor: str, reference: str,
                              lines: list[dict[str, str]]) -> str:
        vendor = _require_text(vendor, "Vendor")
        reference = _require_text(reference, "Order reference")
        if not lines:
            raise WorkflowError("Purchase order requires at least one product")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            seen: set[str] = set()
            normalized: list[tuple[str, Decimal]] = []
            for item in lines:
                product_id = item.get("product_id", "")
                if product_id in seen or s.get(Product, product_id) is None:
                    raise WorkflowError("Product must exist and appear only once per order")
                seen.add(product_id)
                normalized.append((product_id, positive(item.get("quantity", ""))))
            order = PurchaseOrder(site_id=actor.site_id, vendor=vendor,
                                  reference=reference, status="OPEN", created_by_id=actor.id)
            s.add(order); s.flush()
            for product_id, quantity in normalized:
                s.add(PurchaseOrderLine(order_id=order.id, product_id=product_id,
                                        ordered=quantity, received=ZERO))
            self.service._audit(s, actor, "PO_CREATED", order.id,
                                {"vendor": vendor, "reference": reference,
                                 "lines": [{"product_id": p, "quantity": str(q)} for p, q in normalized]})
            return order.id

    def receive_purchase_order(self, actor: Actor, line_id: str, lot: str, expires: str,
                               quantity: str, invoice: str) -> str:
        qty = positive(quantity)
        invoice = _require_text(invoice, "Invoice reference")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            line = s.scalar(select(PurchaseOrderLine).where(PurchaseOrderLine.id == line_id).with_for_update())
            if not line:
                raise WorkflowError("Purchase order line not found")
            order = self.service._site(s, PurchaseOrder, line.order_id, actor)
            if order.status not in {"OPEN", "PARTIAL"}:
                raise WorkflowError("Order is closed")
            if line.received + qty > line.ordered:
                raise WorkflowError("Purchase order over-receipt blocked")
            stock = _stock_for_receipt(s, actor.site_id, line.product_id, lot, expires)
            movement = record_movement(s, actor, stock, "PO_RECEIVE", on_hand=qty,
                                       reason=f"PO {order.reference}; invoice {invoice}")
            line.received += qty
            receipt = PurchaseOrderReceipt(site_id=actor.site_id, line_id=line.id,
                                           stock_id=stock.id, quantity=qty, invoice=invoice,
                                           received_by_id=actor.id)
            s.add(receipt); s.flush()
            all_lines = s.scalars(select(PurchaseOrderLine).where(PurchaseOrderLine.order_id == order.id)).all()
            s.flush()
            order.status = "RECEIVED" if all(x.received == x.ordered for x in all_lines) else "PARTIAL"
            recall = active_recall(s, actor.site_id, stock.product_id, stock.lot)
            if recall:
                quarantine_recalled_available(s, actor, stock, recall)
            self.service._audit(s, actor, "PO_RECEIVED", receipt.id,
                                {"line_id": line.id, "stock_id": stock.id, "quantity": str(qty),
                                 "invoice": invoice, "movement_id": movement})
            return receipt.id

    def cancel_purchase_order(self, actor: Actor, order_id: str, reason: str) -> None:
        reason = _require_text(reason, "Cancellation reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            order = self.service._site(s, PurchaseOrder, order_id, actor)
            if order.status not in {"OPEN", "PARTIAL"}:
                raise WorkflowError("Only an open/partial order can be cancelled")
            order.status = "CANCELLED"
            self.service._audit(s, actor, "PO_CANCELLED", order.id, {"reason": reason})

    def purchase_orders(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            orders = s.scalars(select(PurchaseOrder).where(PurchaseOrder.site_id == actor.site_id)
                               .order_by(PurchaseOrder.created_at, PurchaseOrder.id)).all()
            return [{"id": p.id, "reference": p.reference, "vendor": p.vendor,
                     "status": p.status, "lines": [{"id": x.id, "product_id": x.product_id,
                      "ordered": str(x.ordered), "received": str(x.received)} for x in
                      s.scalars(select(PurchaseOrderLine).where(PurchaseOrderLine.order_id == p.id)).all()]}
                    for p in orders]

    def ship_transfer(self, actor: Actor, stock_id: str, destination_site_id: str,
                      quantity: str, reason: str) -> str:
        qty = positive(quantity)
        reason = _require_text(reason, "Transfer reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            if destination_site_id == actor.site_id or s.get(Site, destination_site_id) is None:
                raise WorkflowError("Transfer must target a different valid pharmacy site")
            stock = _lock_stock(s, stock_id, actor.site_id)
            if active_recall(s, stock.site_id, stock.product_id, stock.lot):
                raise WorkflowError("Recalled product cannot be transferred")
            if stock.expires <= date.today().isoformat():
                raise WorkflowError("Expired stock cannot be transferred")
            if qty > stock.on_hand - stock.reserved - stock.quarantined:
                raise WorkflowError("Insufficient available stock for transfer")
            movement = record_movement(s, actor, stock, "TRANSFER_OUT", on_hand=-qty, reason=reason)
            transfer = InventoryTransfer(from_site_id=actor.site_id, to_site_id=destination_site_id,
                                         source_stock_id=stock.id, quantity=qty, status="IN_TRANSIT",
                                         reason=reason, shipped_by_id=actor.id)
            s.add(transfer); s.flush()
            self.service._audit(s, actor, "TRANSFER_SHIPPED", transfer.id,
                                {"movement_id": movement, "to_site_id": destination_site_id,
                                 "quantity": str(qty)})
            return transfer.id

    def receive_transfer(self, actor: Actor, transfer_id: str) -> str:
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            transfer = s.scalar(select(InventoryTransfer).where(InventoryTransfer.id == transfer_id).with_for_update())
            if transfer is None or transfer.to_site_id != actor.site_id:
                raise WorkflowError("Transfer not found for destination site")
            if transfer.status != "IN_TRANSIT":
                raise WorkflowError("Transfer has already been closed")
            source = s.get(Stock, transfer.source_stock_id)
            if not source or source.site_id != transfer.from_site_id:
                raise WorkflowError("Transfer source invalid")
            stock = _stock_for_receipt(s, actor.site_id, source.product_id, source.lot, source.expires)
            movement = record_movement(s, actor, stock, "TRANSFER_IN", on_hand=transfer.quantity,
                                       reason=f"Transfer {transfer.id}")
            transfer.status = "RECEIVED"
            transfer.received_stock_id = stock.id
            transfer.closed_by_id = actor.id
            transfer.closed_at = datetime.now(timezone.utc)
            recall = active_recall(s, actor.site_id, stock.product_id, stock.lot)
            if recall:
                quarantine_recalled_available(s, actor, stock, recall)
            self.service._audit(s, actor, "TRANSFER_RECEIVED", transfer.id,
                                {"source_site_id": transfer.from_site_id, "stock_id": stock.id,
                                 "movement_id": movement})
            return stock.id

    def cancel_transfer(self, actor: Actor, transfer_id: str, reason: str) -> None:
        reason = _require_text(reason, "Cancellation reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            transfer = s.scalar(select(InventoryTransfer).where(InventoryTransfer.id == transfer_id).with_for_update())
            if transfer is None or transfer.from_site_id != actor.site_id:
                raise WorkflowError("Transfer not found at source site")
            if transfer.status != "IN_TRANSIT":
                raise WorkflowError("Only in-transit transfers can be cancelled")
            source = _lock_stock(s, transfer.source_stock_id, actor.site_id)
            record_movement(s, actor, source, "TRANSFER_CANCEL_RETURN", on_hand=transfer.quantity, reason=reason)
            recall = active_recall(s, actor.site_id, source.product_id, source.lot)
            if recall:
                quarantine_recalled_available(s, actor, source, recall)
            transfer.status = "CANCELLED"
            transfer.closed_by_id = actor.id
            transfer.closed_at = datetime.now(timezone.utc)
            self.service._audit(s, actor, "TRANSFER_CANCELLED", transfer.id, {"reason": reason})

    def transfers(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            transfers = s.scalars(select(InventoryTransfer).where(
                (InventoryTransfer.from_site_id == actor.site_id) |
                (InventoryTransfer.to_site_id == actor.site_id)).order_by(InventoryTransfer.created_at)).all()
            return [{"id": t.id, "from_site_id": t.from_site_id, "to_site_id": t.to_site_id,
                     "quantity": str(t.quantity), "status": t.status,
                     "stock_id": t.source_stock_id, "destination_stock_id": t.received_stock_id}
                    for t in transfers]

    def create_cycle_count(self, actor: Actor) -> str:
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            session = CycleCountSession(site_id=actor.site_id, status="OPEN", created_by_id=actor.id)
            s.add(session); s.flush()
            self.service._audit(s, actor, "CYCLE_COUNT_STARTED", session.id, {})
            return session.id

    def record_count(self, actor: Actor, session_id: str, stock_id: str,
                     counted_on_hand: str) -> str:
        count = nonnegative(counted_on_hand)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            session = self.service._site(s, CycleCountSession, session_id, actor)
            if session.status != "OPEN":
                raise WorkflowError("Only an open count accepts entries")
            stock = _lock_stock(s, stock_id, actor.site_id)
            number = s.scalar(select(func.count()).select_from(InventoryMovement).where(
                InventoryMovement.stock_id == stock_id))
            line = s.scalar(select(CycleCountLine).where(
                CycleCountLine.session_id == session_id, CycleCountLine.stock_id == stock_id))
            if line is None:
                line = CycleCountLine(session_id=session_id, stock_id=stock_id)
                s.add(line)
            line.counted_on_hand = count
            line.baseline_on_hand = stock.on_hand
            line.baseline_reserved = stock.reserved
            line.baseline_quarantined = stock.quarantined
            line.movement_count = number
            line.counted_by_id = actor.id
            s.flush()
            self.service._audit(s, actor, "CYCLE_COUNT_RECORDED", line.id,
                                {"quantity": str(count), "stock_id": stock_id, "movement_count": number})
            return line.id

    def submit_cycle_count(self, actor: Actor, session_id: str) -> None:
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            session = self.service._site(s, CycleCountSession, session_id, actor)
            if session.status != "OPEN" or not s.scalar(select(CycleCountLine.id).where(CycleCountLine.session_id == session.id)):
                raise WorkflowError("A count must be open and contain lines before submission")
            session.status = "SUBMITTED"
            self.service._audit(s, actor, "CYCLE_COUNT_SUBMITTED", session.id, {})

    def review_cycle_count(self, actor: Actor, session_id: str, approve: bool, reason: str) -> None:
        reason = _require_text(reason, "Review reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            session = self.service._site(s, CycleCountSession, session_id, actor)
            if session.status != "SUBMITTED":
                raise WorkflowError("Count must be submitted exactly once")
            lines = s.scalars(select(CycleCountLine).where(CycleCountLine.session_id == session.id)
                              .order_by(CycleCountLine.stock_id)).all()
            if approve:
                # Validate *all* lines before posting any adjustments.
                planned: list[tuple[Stock, Decimal]] = []
                for line in lines:
                    stock = _lock_stock(s, line.stock_id, actor.site_id)
                    moves = s.scalar(select(func.count()).select_from(InventoryMovement).where(
                        InventoryMovement.stock_id == line.stock_id))
                    if (moves != line.movement_count or stock.on_hand != line.baseline_on_hand
                            or stock.reserved != line.baseline_reserved
                            or stock.quarantined != line.baseline_quarantined):
                        raise WorkflowError("Stale cycle count: stock changed after physical count")
                    if line.counted_on_hand < stock.reserved + stock.quarantined:
                        raise WorkflowError("Count cannot reduce on-hand below reserved/quarantined stock")
                    planned.append((stock, line.counted_on_hand - stock.on_hand))
                for stock, delta in planned:
                    if delta:
                        record_movement(s, actor, stock, "CYCLE_RECONCILE", on_hand=delta, reason=reason)
            session.status = "APPROVED" if approve else "REJECTED"
            session.reviewed_by_id = actor.id
            session.review_reason = reason
            self.service._audit(s, actor, "CYCLE_COUNT_REVIEWED", session.id,
                                {"status": session.status, "reason": reason})

    def cycle_counts(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            sessions = s.scalars(select(CycleCountSession).where(
                CycleCountSession.site_id == actor.site_id).order_by(CycleCountSession.created_at)).all()
            return [{"id": x.id, "status": x.status,
                     "lines": [{"id": line.id, "stock_id": line.stock_id,
                                "counted": str(line.counted_on_hand)} for line in
                               s.scalars(select(CycleCountLine).where(CycleCountLine.session_id == x.id)).all()]}
                    for x in sessions]

    def open_recall(self, actor: Actor, product_id: str, reference: str,
                    reason: str, lot: str | None = None) -> str:
        reference = _require_text(reference, "Recall reference")
        reason = _require_text(reason, "Recall reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            if not s.get(Product, product_id):
                raise WorkflowError("Recall product not found")
            recall = RecallCase(site_id=actor.site_id, product_id=product_id,
                                reference=reference, reason=reason,
                                lot=lot.strip() if lot and lot.strip() else None,
                                status="ACTIVE", created_by_id=actor.id)
            s.add(recall); s.flush()
            rows = s.scalars(select(Stock).where(Stock.site_id == actor.site_id,
                Stock.product_id == product_id).order_by(Stock.id).with_for_update()).all()
            held = 0
            for stock in rows:
                if recall.lot is None or stock.lot == recall.lot:
                    if quarantine_recalled_available(s, actor, stock, recall):
                        held += 1
            # Link affected dispensed/prepared fills, including sold fills, for
            # pharmacist follow-up. Do not change their historic Rx records.
            relevant = s.execute(select(Fill.id, Fill.status, Stock.lot).join(
                FillSource, FillSource.fill_id == Fill.id).join(
                Stock, Stock.id == FillSource.stock_id).join(
                Prescription, Prescription.id == Fill.prescription_id).where(
                Prescription.site_id == actor.site_id, Stock.product_id == product_id,
                Fill.status.in_(["READY", "SOLD"]))).all()
            exposed = set()
            for fill_id, status, lot_number in relevant:
                if fill_id in exposed or (recall.lot is not None and lot_number != recall.lot):
                    continue
                exposed.add(fill_id)
                s.add(RecallExposure(recall_id=recall.id, fill_id=fill_id,
                                     status_at_discovery=status))
            self.service._audit(s, actor, "RECALL_OPENED", recall.id,
                                {"reference": reference, "lot": recall.lot,
                                 "stock_balances_held": held, "affected_fills": len(exposed)})
            return recall.id

    def close_recall(self, actor: Actor, recall_id: str, reason: str) -> None:
        reason = _require_text(reason, "Closure reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            recall = self.service._site(s, RecallCase, recall_id, actor)
            if recall.status != "ACTIVE":
                raise WorkflowError("Recall already closed")
            recall.status = "CLOSED"
            recall.closed_by_id = actor.id
            recall.closed_at = datetime.now(timezone.utc)
            # Holds remain ACTIVE. Closure does not release quarantined inventory.
            self.service._audit(s, actor, "RECALL_CLOSED", recall.id,
                                {"reason": reason, "holds_left_in_place": True})

    def recalls(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rows = s.scalars(select(RecallCase).where(RecallCase.site_id == actor.site_id)
                             .order_by(RecallCase.created_at)).all()
            return [{"id": r.id, "reference": r.reference, "product_id": r.product_id,
                     "lot": r.lot, "reason": r.reason, "status": r.status,
                     "exposures": [{"fill_id": e.fill_id, "status_at_discovery": e.status_at_discovery}
                       for e in s.scalars(select(RecallExposure).where(
                           RecallExposure.recall_id == r.id)).all()]} for r in rows]


def assert_not_recalled(s, stock: Stock) -> None:
    if active_recall(s, stock.site_id, stock.product_id, stock.lot):
        raise WorkflowError("Active recall blocks dispensing, staging, or sale of this product")


def quarantine_recalled_receipt(s, actor: Actor, stock: Stock, _received: Decimal) -> None:
    recall = active_recall(s, stock.site_id, stock.product_id, stock.lot)
    if recall:
        quarantine_recalled_available(s, actor, stock, recall)
