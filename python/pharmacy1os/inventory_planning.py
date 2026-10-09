"""Site-scoped, advisory-only inventory replenishment for synthetic pharmacies.

Policies never create orders or automatically release recalled/controlled products.
All quantities use exact Decimal arithmetic; generated reports are snapshots and
must be rechecked by a pharmacist before any manual purchase-order action.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Numeric, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import (
    Base, Drug, InventoryTransfer, Product, PurchaseOrder, PurchaseOrderLine,
    RecallCase, Stock, uuid,
)
from .service import Actor, PharmacyService, WorkflowError

ZERO = Decimal("0")
MAX_QTY = Decimal("999999999.999")


class ReorderPolicy(Base):
    __tablename__ = "py_reorder_policies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("py_products.id"), nullable=False)
    minimum: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    target: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("site_id", "product_id", name="uq_py_reorder_site_product"),
        CheckConstraint("minimum >= 0 AND target > minimum", name="ck_py_reorder_bounds"),
    )


def _quantity(value: str, label: str, *, positive: bool = False) -> Decimal:
    try:
        qty = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise WorkflowError(f"{label} must be a valid decimal") from exc
    if (not qty.is_finite() or qty < 0 or (positive and qty == ZERO)
            or qty > MAX_QTY or qty.as_tuple().exponent < -3):
        raise WorkflowError(f"{label} must be a nonnegative quantity with at most three decimals")
    return qty


def _reason(value: str) -> str:
    reason = (value or "").strip()
    if not reason or len(reason) > 1000:
        raise WorkflowError("A documented reason (up to 1000 characters) is required")
    return reason


class InventoryPlanningService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def configure(self, actor: Actor, product_id: str, minimum: str, target: str,
                  reason: str) -> str:
        low = _quantity(minimum, "Reorder minimum")
        high = _quantity(target, "Reorder target", positive=True)
        if high <= low:
            raise WorkflowError("Reorder target must exceed the minimum")
        note = _reason(reason)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            if s.get(Product, product_id) is None:
                raise WorkflowError("Product not found")
            policy = s.scalar(select(ReorderPolicy).where(
                ReorderPolicy.site_id == actor.site_id,
                ReorderPolicy.product_id == product_id).with_for_update())
            previous = None
            if policy is None:
                policy = ReorderPolicy(site_id=actor.site_id, product_id=product_id,
                                       minimum=low, target=high, enabled=True)
                s.add(policy)
            else:
                previous = {"minimum": str(policy.minimum), "target": str(policy.target),
                            "enabled": policy.enabled}
                policy.minimum, policy.target, policy.enabled = low, high, True
            s.flush()
            self.service._audit(s, actor, "REORDER_POLICY_CONFIGURED", policy.id,
                {"product_id": product_id, "before": previous,
                 "after": {"minimum": str(low), "target": str(high), "enabled": True},
                 "reason": note})
            return policy.id

    def disable(self, actor: Actor, product_id: str, reason: str) -> None:
        note = _reason(reason)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            policy = s.scalar(select(ReorderPolicy).where(
                ReorderPolicy.site_id == actor.site_id,
                ReorderPolicy.product_id == product_id).with_for_update())
            if policy is None or not policy.enabled:
                raise WorkflowError("No active reorder policy for this product at this site")
            policy.enabled = False
            self.service._audit(s, actor, "REORDER_POLICY_DISABLED", policy.id,
                                {"product_id": product_id, "reason": note})

    def recommendations(self, actor: Actor, *, include_all: bool = False) -> list[dict]:
        """Snapshot only. Open purchase orders and in-transit stock count as incoming.

        Stock from expired lots is excluded. A recall or controlled status blocks
        automatic suggestions, rather than silently authorizing replenishment.
        """
        today = date.today().isoformat()
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            policies = s.scalars(select(ReorderPolicy).where(
                ReorderPolicy.site_id == actor.site_id).order_by(ReorderPolicy.product_id)).all()
            results = []
            for policy in policies:
                product = s.get(Product, policy.product_id)
                if product is None:
                    raise WorkflowError("Configured reorder product is missing")
                drug = s.get(Drug, product.drug_id)
                if drug is None:
                    raise WorkflowError("Configured reorder drug is missing")
                stocks = s.scalars(select(Stock).where(
                    Stock.site_id == actor.site_id, Stock.product_id == product.id,
                    Stock.expires > today)).all()
                usable = sum((st.on_hand - st.reserved - st.quarantined for st in stocks), ZERO)
                outstanding_lines = s.execute(
                    select(PurchaseOrderLine, PurchaseOrder).join(
                        PurchaseOrder, PurchaseOrderLine.order_id == PurchaseOrder.id
                    ).where(PurchaseOrder.site_id == actor.site_id,
                            PurchaseOrder.status.in_(("OPEN", "PARTIAL")),
                            PurchaseOrderLine.product_id == product.id)
                ).all()
                on_order = sum((line.ordered - line.received for line, _ in outstanding_lines), ZERO)
                inbound_rows = s.execute(
                    select(InventoryTransfer, Stock).join(
                        Stock, InventoryTransfer.source_stock_id == Stock.id
                    ).where(InventoryTransfer.to_site_id == actor.site_id,
                            InventoryTransfer.status == "IN_TRANSIT",
                            Stock.product_id == product.id, Stock.expires > today)
                ).all()
                inbound = sum((transfer.quantity for transfer, _ in inbound_rows), ZERO)
                projected = usable + on_order + inbound
                recalled = s.scalar(select(RecallCase.id).where(
                    RecallCase.site_id == actor.site_id, RecallCase.product_id == product.id,
                    RecallCase.status == "ACTIVE").limit(1)) is not None
                if not policy.enabled:
                    status = "DISABLED"
                elif recalled:
                    status = "RECALL_REVIEW"
                elif drug.controlled:
                    status = "CONTROLLED_REVIEW"
                elif projected < policy.minimum:
                    status = "BELOW_MINIMUM"
                else:
                    status = "SUFFICIENT"
                suggested = max(ZERO, policy.target - projected) if status == "BELOW_MINIMUM" else ZERO
                if include_all or status not in {"DISABLED", "SUFFICIENT"}:
                    results.append({
                        "policy_id": policy.id, "product_id": product.id, "ndc": product.ndc,
                        "drug": drug.name, "site_id": actor.site_id,
                        "minimum": str(policy.minimum), "target": str(policy.target),
                        "available": str(usable), "open_orders": str(on_order),
                        "incoming_transfers": str(inbound), "projected": str(projected),
                        "suggested_quantity": str(suggested), "status": status,
                    })
            return sorted(results, key=lambda x: (x["status"], x["ndc"]))
