"""Additional synthetic prescription hold/resume/cancel transitions.

Cancellation is atomic with release of reserved stock, synthetic claim reversal
and return of verified unsold inventory. It is NOT live-payer cancellation.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from .inventory_ops import record_movement
from .models import Claim, DUR, Fill, FillSource, Prescription, Stock, WillCall
from .service import Actor, PharmacyService, WorkflowError


class LifecycleService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def hold(self, actor: Actor, rx_id: str, reason: str) -> None:
        if not reason.strip():
            raise WorkflowError("Hold requires a reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            rx = self.service._site(s, Prescription, rx_id, actor)
            if rx.status not in {"RECEIVED", "DATA_ENTRY", "DUR_REVIEW", "PRODUCT_FILL", "PHARMACIST_REVIEW", "READY", "SOLD"}:
                raise WorkflowError("Prescription status cannot be held")
            rx.held_from = rx.status
            rx.status = "ON_HOLD"
            self.service._audit(s, actor, "RX_HELD", rx.id, {"from": rx.held_from, "reason": reason.strip()})

    def resume(self, actor: Actor, rx_id: str, reason: str) -> None:
        if not reason.strip():
            raise WorkflowError("Resume requires a reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            rx = self.service._site(s, Prescription, rx_id, actor)
            if rx.status != "ON_HOLD" or not rx.held_from:
                raise WorkflowError("Prescription is not on hold")
            before = rx.held_from
            if before in {"PRODUCT_FILL", "PHARMACIST_REVIEW", "READY"}:
                if rx.expiration_date and rx.expiration_date < date.today().isoformat():
                    raise WorkflowError("Cannot resume an expired prescription toward dispensing")
                from .date_rules import require_date_eligible
                require_date_eligible(s, rx)
                if s.scalar(select(DUR.id).where(DUR.prescription_id == rx.id,
                            DUR.severity == "HIGH", DUR.resolved.is_(False))):
                    raise WorkflowError("Unresolved high-severity DUR issue")
            rx.status = before
            rx.held_from = None
            self.service._audit(s, actor, "RX_RESUMED", rx.id, {"to": before, "reason": reason.strip()})

    def cancel(self, actor: Actor, rx_id: str, reason: str) -> None:
        if not reason.strip():
            raise WorkflowError("Cancellation requires a documented reason")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            rx = self.service._site(s, Prescription, rx_id, actor)
            if rx.status in {"CANCELLED", "TRANSFERRED", "SOLD"} or (
                rx.status == "ON_HOLD" and rx.held_from == "SOLD"
            ):
                raise WorkflowError("Cannot cancel a completed/transferred prescription with this workflow")
            from .fill_completion import FillObligation
            from .emergency_supply import EmergencySupply
            if s.scalar(select(EmergencySupply.id).where(
                EmergencySupply.prescription_id == rx.id,
                EmergencySupply.site_id == actor.site_id)):
                raise WorkflowError("Emergency supply linked to a prior sale requires professional reconciliation")
            outstanding = s.scalars(select(FillObligation).where(
                FillObligation.prescription_id == rx.id,
                FillObligation.site_id == actor.site_id,
                FillObligation.status == "OPEN")).all()
            if any(item.dispensed > 0 for item in outstanding):
                raise WorkflowError("Previously sold partial requires separate professional reconciliation")
            active = s.scalars(select(Fill).where(Fill.prescription_id == rx.id,
                          Fill.status.in_(["PRODUCT_FILL", "PHARMACIST_REVIEW", "READY"]))).all()
            if len(active) > 1:
                raise WorkflowError("Multiple active fills require manual review")
            for f in active:
                claims = s.scalars(select(Claim).where(Claim.fill_id == f.id)).all()
                if any(claim.status != "PAID_SYNTHETIC" for claim in claims):
                    raise WorkflowError("Claim is not reversible by the synthetic adapter")
                for claim in claims:
                    from .billing import record_reversal
                    record_reversal(s, actor, claim, reason)
                    claim.status = "REVERSED_SYNTHETIC"
                sources = s.scalars(select(FillSource).where(FillSource.fill_id == f.id)).all()
                for src in sources:
                    stock = s.scalar(select(Stock).where(Stock.id == src.stock_id).with_for_update())
                    if stock is None or stock.site_id != actor.site_id:
                        raise WorkflowError("Fill stock is not at this pharmacy site")
                    if f.status == "READY":
                        record_movement(s, actor, stock, "CANCEL_RETURN", on_hand=src.quantity, reason=reason.strip())
                        from .inventory_advanced import quarantine_recalled_receipt
                        quarantine_recalled_receipt(s, actor, stock, src.quantity)
                    else:
                        record_movement(s, actor, stock, "CANCEL_RELEASE", reserved=-src.quantity,
                                        reason=reason.strip())
                bag = s.scalar(select(WillCall).where(WillCall.fill_id == f.id))
                if bag is not None:
                    bag.status = "CANCELLED"
                from .fill_completion import void_unissued_obligation
                void_unissued_obligation(s, actor, f, reason)
                f.status = "CANCELLED"
            from .prescription_transfer import require_no_pending_transfer
            require_no_pending_transfer(s, rx)
            before = rx.status
            rx.status = "CANCELLED"
            rx.held_from = None
            self.service._audit(s, actor, "RX_CANCELLED", rx.id,
                {"from": before, "active_fills_cancelled": [f.id for f in active], "reason": reason.strip()})
