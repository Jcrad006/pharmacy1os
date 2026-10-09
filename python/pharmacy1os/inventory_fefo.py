"""Synthetic FEFO policy controls for physical NDC/lot scans.

Existing fills remain advisory unless a pharmacist enables a site/product policy.
An override is only accepted from a pharmacist/admin and recorded with audit
provenance in the same transaction that reserves inventory.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from .inventory_fefo_models import FefoPolicy
from .inventory_location_models import InventoryLocation, InventoryStockPosition
from .models import Product, Stock
from .service import Actor, PharmacyService, WorkflowError

ZERO = Decimal("0")


def _explanation(value: str) -> str:
    note = value.strip() if isinstance(value, str) else ""
    if not 12 <= len(note) <= 1000:
        raise WorkflowError("FEFO policy change or override requires a 12–1000 character reason")
    return note


def _accessible_available(s: Session, stock: Stock, site_id: str) -> Decimal:
    """Only actionable stock counts as an earlier FEFO option."""
    aggregate = stock.on_hand - stock.reserved - stock.quarantined
    if aggregate <= ZERO:
        return ZERO
    if not stock.location_tracking_enabled:
        return aggregate
    physical = s.scalar(select(InventoryStockPosition.available)
        .join(InventoryLocation, InventoryStockPosition.location_id == InventoryLocation.id)
        .where(InventoryStockPosition.stock_id == stock.id,
               InventoryLocation.site_id == site_id,
               InventoryLocation.active.is_(True),
               InventoryLocation.is_quarantine.is_(False))
        .order_by(InventoryStockPosition.id).limit(1))
    # Multiple eligible physical bins can hold this lot.
    positions = s.scalars(select(InventoryStockPosition.available)
        .join(InventoryLocation, InventoryStockPosition.location_id == InventoryLocation.id)
        .where(InventoryStockPosition.stock_id == stock.id,
               InventoryLocation.site_id == site_id,
               InventoryLocation.active.is_(True),
               InventoryLocation.is_quarantine.is_(False))).all()
    return min(aggregate, sum(positions, ZERO)) if physical is not None else ZERO


def assess_fefo(s: Session, actor: Actor, stock: Stock, policy: FefoPolicy) -> dict:
    """Assess selected lot against stocked, non-recalled, physically usable earlier lots."""
    from .inventory_advanced import active_recall
    today = date.today()
    selected_exp = date.fromisoformat(stock.expires)
    shelf_days = (selected_exp - today).days
    reasons = []
    if shelf_days < policy.minimum_shelf_life_days:
        reasons.append("BELOW_MIN_SHELF_LIFE")
    earliest: Stock | None = None
    for other in s.scalars(select(Stock).where(
            Stock.site_id == actor.site_id,
            Stock.product_id == stock.product_id,
            Stock.id != stock.id,
            Stock.expires > today.isoformat(),
            Stock.expires < stock.expires)
            .order_by(Stock.expires, Stock.id).with_for_update()):
        other_exp = date.fromisoformat(other.expires)
        if (other_exp - today).days < policy.minimum_shelf_life_days:
            continue
        if active_recall(s, actor.site_id, other.product_id, other.lot):
            continue
        if _accessible_available(s, other, actor.site_id) > ZERO:
            earliest = other
            reasons.append("EARLIER_USABLE_LOT")
            break
    return {
        "selected_stock_id": stock.id,
        "selected_expiration": stock.expires,
        "selected_shelf_life_days": shelf_days,
        "minimum_shelf_life_days": policy.minimum_shelf_life_days,
        "earlier_stock_id": earliest.id if earliest else None,
        "earlier_expiration": earliest.expires if earliest else None,
        "reason_codes": reasons,
    }


def require_fefo_scan(s: Session, actor: Actor, fill_id: str,
                      stock: Stock, override_note: str | None) -> None:
    policy = s.scalar(select(FefoPolicy).where(
        FefoPolicy.site_id == actor.site_id,
        FefoPolicy.product_id == stock.product_id,
        FefoPolicy.enabled.is_(True)).with_for_update())
    if policy is None:
        if override_note is not None:
            raise WorkflowError("No active FEFO policy requires an override")
        return
    assessment = assess_fefo(s, actor, stock, policy)
    reasons = assessment["reason_codes"]
    if not reasons:
        if override_note is not None:
            raise WorkflowError("FEFO override is not applicable to this selected stock")
        return
    if policy.mode == "ADVISORY":
        if override_note is not None:
            raise WorkflowError("An advisory-only FEFO choice does not accept an override")
        PharmacyService._audit(s, actor, "FEFO_PICK_ADVISORY", fill_id, {
            **assessment, "policy_id": policy.id})
        return
    if policy.mode != "ENFORCE":
        raise WorkflowError("Unexpected FEFO policy mode")
    if override_note is None:
        raise WorkflowError("FEFO policy requires earlier stock or pharmacist-documented override: "
                            + ",".join(reasons))
    PharmacyService._authorized(s, actor, "correct")
    reason = _explanation(override_note)
    PharmacyService._audit(s, actor, "FEFO_PHARMACIST_OVERRIDE", fill_id, {
        **assessment, "policy_id": policy.id, "reason": reason,
        "override_actor_id": actor.id,
    })


class FefoPolicyService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def list(self, actor: Actor) -> list[dict]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rows = s.scalars(select(FefoPolicy).where(
                FefoPolicy.site_id == actor.site_id)
                .order_by(FefoPolicy.product_id)).all()
            return [{
                "id": row.id, "product_id": row.product_id,
                "mode": row.mode, "enabled": row.enabled,
                "minimum_shelf_life_days": row.minimum_shelf_life_days,
                "updated_by_id": row.updated_by_id,
                "updated_at": row.updated_at.isoformat(), "reason": row.reason,
            } for row in rows]

    def configure(self, actor: Actor, product_id: str, mode: str,
                  minimum_shelf_life_days: int, reason: str,
                  enabled: bool = True) -> str:
        if mode not in ("ADVISORY", "ENFORCE"):
            raise WorkflowError("FEFO mode must be ADVISORY or ENFORCE")
        if (type(minimum_shelf_life_days) is not int
                or not 0 <= minimum_shelf_life_days <= 3650):
            raise WorkflowError("Minimum shelf life must be 0–3650 whole days")
        if type(enabled) is not bool:
            raise WorkflowError("FEFO policy enabled must be boolean")
        note = _explanation(reason)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            product = s.get(Product, product_id)
            if product is None or not product.active:
                raise WorkflowError("Active product required for FEFO policy")
            policy = s.scalar(select(FefoPolicy).where(
                FefoPolicy.site_id == actor.site_id,
                FefoPolicy.product_id == product_id).with_for_update())
            before = None
            if policy is None:
                policy = FefoPolicy(site_id=actor.site_id, product_id=product_id,
                    mode=mode, minimum_shelf_life_days=minimum_shelf_life_days,
                    enabled=enabled, updated_by_id=actor.id, reason=note)
                s.add(policy)
            else:
                before = {"mode": policy.mode,
                    "minimum_shelf_life_days": policy.minimum_shelf_life_days,
                    "enabled": policy.enabled}
                policy.mode = mode
                policy.minimum_shelf_life_days = minimum_shelf_life_days
                policy.enabled = enabled
                policy.updated_by_id = actor.id
                policy.updated_at = datetime.now(timezone.utc)
                policy.reason = note
            s.flush()
            self.service._audit(s, actor, "FEFO_POLICY_CONFIGURED", policy.id, {
                "product_id": product.id, "previous": before,
                "mode": mode, "minimum_shelf_life_days": minimum_shelf_life_days,
                "enabled": enabled, "reason": note,
            })
            return policy.id
