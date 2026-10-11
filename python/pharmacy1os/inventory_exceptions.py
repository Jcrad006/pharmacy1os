"""Advisory, persistent inventory exception detection and review.

Explicit refresh performs site-level, transactional snapshot reconciliation.
Reads do not modify status. Acknowledgement survives repeat detections. No
automatic reorder, physical stock correction or clinical authorization occurs.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import or_, select

from .inventory_demand_models import InventoryDemand
from .inventory_exception_models import InventoryExceptionRecord, InventoryExceptionEvent
from .inventory_location_models import InventoryAllocation, InventoryStockPosition
from .inventory_planning import ReorderPolicy
from .models import (
    InventoryTransfer, Product, PurchaseOrder, RecallCase, Site, Stock, utcnow,
)
from .service import Actor, PharmacyService, WorkflowError

ZERO = Decimal("0")
AUTOMATED = {
    "BELOW_REORDER_POINT", "EXPIRING_SOON", "STALE_RESERVATION",
    "TRANSFER_STUCK", "PURCHASE_ORDER_OVERDUE", "UNALLOCATED_DEMAND",
    "POSITION_IMBALANCE",
}
ORDER = {"HIGH": 0, "WARNING": 1, "INFO": 2}


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _note(value: str, label: str) -> str:
    cleaned = value.strip() if isinstance(value, str) else ""
    if not 12 <= len(cleaned) <= 2000:
        raise WorkflowError(f"{label} needs 12-2000 characters")
    return cleaned


def _event(s, actor: Actor, record: InventoryExceptionRecord,
           action: str, previous: str | None, reason: str) -> None:
    s.add(InventoryExceptionEvent(
        site_id=actor.site_id, exception_id=record.id, actor_id=actor.id,
        operation=action, previous_status=previous,
        next_status=record.status, note=reason))


def _detect(s, site_id: str, now: datetime) -> dict[str, dict[str, Any]]:
    """Detections are computed only from concrete existing Python source records."""
    hits: dict[str, dict[str, Any]] = {}

    def flag(fingerprint: str, kind: str, severity: str, entity_type: str,
             entity_id: str, title: str, detail: str) -> None:
        hits[fingerprint] = {
            "fingerprint": fingerprint, "type": kind, "severity": severity,
            "entity_type": entity_type, "entity_id": entity_id,
            "title": title, "detail": detail,
        }

    today = now.date()
    stocks = s.scalars(select(Stock).where(Stock.site_id == site_id)).all()
    recalls = s.scalars(select(RecallCase).where(
        RecallCase.site_id == site_id, RecallCase.status == "ACTIVE")).all()
    recall_keys = {(recall.product_id, recall.lot) for recall in recalls}
    usable: dict[str, Decimal] = {}
    for stock in stocks:
        remaining = stock.on_hand - stock.reserved - stock.quarantined
        if remaining > ZERO and stock.expires <= (today + timedelta(days=90)).isoformat():
            expired = stock.expires <= today.isoformat()
            flag(f"expiring:{stock.id}", "EXPIRING_SOON",
                 "HIGH" if expired else "WARNING", "Stock", stock.id,
                 "Inventory is expired or approaching expiration",
                 f"Lot {stock.lot} expires {stock.expires} with {remaining} units in unreserved/unquarantined stock.")
        if (stock.expires > today.isoformat()
                and (stock.product_id, None) not in recall_keys
                and (stock.product_id, stock.lot) not in recall_keys):
            usable[stock.product_id] = usable.get(stock.product_id, ZERO) + remaining

        if stock.location_tracking_enabled:
            positions = s.scalars(select(InventoryStockPosition).where(
                InventoryStockPosition.stock_id == stock.id)).all()
            totals = (
                sum((x.available for x in positions), ZERO),
                sum((x.reserved for x in positions), ZERO),
                sum((x.quarantined for x in positions), ZERO),
            )
            expected = (remaining, stock.reserved, stock.quarantined)
            if totals != expected:
                flag(f"position-imbalance:{stock.id}", "POSITION_IMBALANCE", "HIGH",
                     "Stock", stock.id, "Location and aggregate lot balances disagree",
                     f"Stock {stock.id}: physical positions {totals} vs aggregate {expected}.")

    for policy in s.scalars(select(ReorderPolicy).where(
            ReorderPolicy.site_id == site_id, ReorderPolicy.enabled.is_(True))):
        product = s.get(Product, policy.product_id)
        if product is None or not product.active:
            continue
        qty = usable.get(product.id, ZERO)
        if qty < policy.minimum:
            flag(f"reorder:{product.id}", "BELOW_REORDER_POINT", "WARNING",
                 "Product", product.id, "Inventory below reorder threshold",
                 f"{qty} physically available units; configured threshold {policy.minimum}. "
                 "This is advisory and does not place an order.")

    old_alloc = now - timedelta(hours=24)
    for allocation in s.scalars(select(InventoryAllocation).where(
            InventoryAllocation.site_id == site_id,
            InventoryAllocation.status == "ACTIVE")):
        if _utc(allocation.created_at) < old_alloc:
            flag(f"stale-allocation:{allocation.id}", "STALE_RESERVATION", "WARNING",
                 "InventoryAllocation", allocation.id, "An inventory reservation remains outstanding",
                 f"{allocation.quantity} units allocated at {_utc(allocation.created_at).isoformat()}.")

    old_transfer = now - timedelta(hours=48)
    for transfer in s.scalars(select(InventoryTransfer).where(
            InventoryTransfer.status == "IN_TRANSIT",
            or_(InventoryTransfer.from_site_id == site_id, InventoryTransfer.to_site_id == site_id))):
        if _utc(transfer.created_at) < old_transfer:
            flag(f"stale-transfer:{transfer.id}", "TRANSFER_STUCK", "WARNING",
                 "InventoryTransfer", transfer.id, "Inter-site transfer remains in transit",
                 f"Transfer {transfer.id} was shipped {_utc(transfer.created_at).isoformat()}.")

    old_order = now - timedelta(days=3)
    for order in s.scalars(select(PurchaseOrder).where(
            PurchaseOrder.site_id == site_id,
            PurchaseOrder.status.in_(("OPEN", "PARTIAL")))):
        if _utc(order.created_at) < old_order:
            flag(f"overdue-po:{order.id}", "PURCHASE_ORDER_OVERDUE", "INFO",
                 "PurchaseOrder", order.id, "Purchase order still outstanding",
                 f"Order {order.reference} remained {order.status} since {_utc(order.created_at).isoformat()}.")

    for demand in s.scalars(select(InventoryDemand).where(
            InventoryDemand.site_id == site_id, InventoryDemand.status == "OPEN")):
        late = demand.needed_by is not None and demand.needed_by <= today.isoformat()
        flag(f"open-demand:{demand.id}", "UNALLOCATED_DEMAND",
             "HIGH" if late else "WARNING", "InventoryDemand", demand.id,
             "Open stock need is not fully coverable",
             f"Demand requires {demand.required_quantity} units; only "
             f"{demand.available_quantity} units are forecast available.")

    return hits


class InventoryExceptionRegistry:
    def __init__(self, service: PharmacyService):
        self.service = service

    @staticmethod
    def _serial(record: InventoryExceptionRecord) -> dict[str, Any]:
        return {
            "id": record.id, "site_id": record.site_id,
            "fingerprint": record.fingerprint, "type": record.type,
            "status": record.status, "severity": record.severity,
            "entity_type": record.entity_type, "entity_id": record.entity_id,
            "title": record.title, "detail": record.detail,
            "first_detected_at": record.first_detected_at.isoformat(),
            "last_detected_at": record.last_detected_at.isoformat(),
            "acknowledged_by_id": record.acknowledged_by_id,
            "acknowledged_at": record.acknowledged_at.isoformat() if record.acknowledged_at else None,
            "resolved_by_id": record.resolved_by_id,
            "resolved_at": record.resolved_at.isoformat() if record.resolved_at else None,
            "resolution_note": record.resolution_note,
            "warning": "SYNTHETIC_ADVISORY_NOT_AN_EXHAUSTIVE_SAFETY_CHECK",
        }

    def list(self, actor: Actor, status: str | None = None) -> list[dict[str, Any]]:
        if status is not None and status not in {"OPEN", "ACKNOWLEDGED", "RESOLVED"}:
            raise WorkflowError("Invalid inventory exception status")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            query = select(InventoryExceptionRecord).where(
                InventoryExceptionRecord.site_id == actor.site_id)
            if status is not None:
                query = query.where(InventoryExceptionRecord.status == status)
            records = s.scalars(query).all()
            records.sort(key=lambda r: (r.status == "RESOLVED",
                                        ORDER.get(r.severity, 9),
                                        -_utc(r.last_detected_at).timestamp(),
                                        r.id))
            return [self._serial(r) for r in records[:250]]

    def history(self, actor: Actor, exception_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            self.service._site(s, InventoryExceptionRecord, exception_id, actor)
            events = s.scalars(select(InventoryExceptionEvent).where(
                InventoryExceptionEvent.site_id == actor.site_id,
                InventoryExceptionEvent.exception_id == exception_id).order_by(
                InventoryExceptionEvent.created_at, InventoryExceptionEvent.id)).all()
            return [{
                "id": e.id, "actor_id": e.actor_id,
                "operation": e.operation, "previous_status": e.previous_status,
                "next_status": e.next_status, "note": e.note,
                "created_at": e.created_at.isoformat(),
            } for e in events]

    def refresh(self, actor: Actor) -> dict[str, int]:
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            s.scalar(select(Site).where(Site.id == actor.site_id).with_for_update())
            now = utcnow()
            detected = _detect(s, actor.site_id, now)
            rows = s.scalars(select(InventoryExceptionRecord).where(
                InventoryExceptionRecord.site_id == actor.site_id).with_for_update()).all()
            existing = {record.fingerprint: record for record in rows}
            created = reopened = auto_resolved = 0
            for fingerprint, finding in detected.items():
                row = existing.get(fingerprint)
                if row is None:
                    row = InventoryExceptionRecord(site_id=actor.site_id, **finding,
                        first_detected_at=now, last_detected_at=now)
                    s.add(row); s.flush()
                    _event(s, actor, row, "DETECTED", None, row.detail)
                    created += 1
                else:
                    row.type = finding["type"]
                    row.severity = finding["severity"]
                    row.entity_type = finding["entity_type"]
                    row.entity_id = finding["entity_id"]
                    row.title = finding["title"]
                    row.detail = finding["detail"]
                    row.last_detected_at = now
                    if row.status == "RESOLVED":
                        row.status = "OPEN"
                        row.resolved_at = None
                        row.resolved_by_id = None
                        row.resolution_note = None
                        row.acknowledged_at = None
                        row.acknowledged_by_id = None
                        _event(s, actor, row, "REOPENED", "RESOLVED",
                               "Risk condition detected again on explicit stock refresh")
                        reopened += 1
            for row in rows:
                if (row.fingerprint not in detected and row.type in AUTOMATED
                        and row.status in {"OPEN", "ACKNOWLEDGED"}):
                    previous = row.status
                    row.status = "RESOLVED"
                    row.resolved_at = now
                    row.resolved_by_id = None
                    row.resolution_note = "Condition no longer detected on explicit stock refresh"
                    _event(s, actor, row, "AUTO_RESOLVED", previous, row.resolution_note)
                    auto_resolved += 1
            self.service._audit(s, actor, "INVENTORY_EXCEPTIONS_REFRESHED", actor.site_id, {
                "detected": len(detected), "new": created,
                "reopened": reopened, "auto_resolved": auto_resolved,
            })
            return {"detected": len(detected), "created": created,
                    "reopened": reopened, "auto_resolved": auto_resolved}

    def acknowledge(self, actor: Actor, exception_id: str, note: str) -> dict[str, Any]:
        reason = _note(note, "Acknowledgement")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "inventory")
            row = s.scalar(select(InventoryExceptionRecord).where(
                InventoryExceptionRecord.site_id == actor.site_id,
                InventoryExceptionRecord.id == exception_id).with_for_update())
            if row is None:
                raise WorkflowError("Inventory exception not found at this site")
            if row.status != "OPEN":
                raise WorkflowError("Only open inventory exceptions can be acknowledged")
            row.status = "ACKNOWLEDGED"
            row.acknowledged_by_id = actor.id
            row.acknowledged_at = utcnow()
            _event(s, actor, row, "ACKNOWLEDGED", "OPEN", reason)
            self.service._audit(s, actor, "INVENTORY_EXCEPTION_ACKNOWLEDGED", row.id, {
                "note": reason})
            return self._serial(row)

    def resolve(self, actor: Actor, exception_id: str, note: str) -> dict[str, Any]:
        reason = _note(note, "Resolution")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            row = s.scalar(select(InventoryExceptionRecord).where(
                InventoryExceptionRecord.site_id == actor.site_id,
                InventoryExceptionRecord.id == exception_id).with_for_update())
            if row is None:
                raise WorkflowError("Inventory exception not found at this site")
            if row.status not in {"OPEN", "ACKNOWLEDGED"}:
                raise WorkflowError("Inventory exception already resolved")
            previous = row.status
            row.status = "RESOLVED"
            row.resolved_by_id = actor.id
            row.resolved_at = utcnow()
            row.resolution_note = reason
            _event(s, actor, row, "RESOLVED", previous, reason)
            self.service._audit(s, actor, "INVENTORY_EXCEPTION_RESOLVED", row.id, {
                "type": row.type, "reason": reason,
                "condition_may_reopen_on_refresh": True})
            return self._serial(row)
