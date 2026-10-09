"""Synthetic physical-part continuation for an existing logical prescription fill.

A 3-of-90 partial creates 87 owed, without a second payer claim or refill.
This is a development model, not a verified state-law/NCPDP dispensing policy.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Numeric, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .models import Base, Claim, DUR, Fill, FillSource, Prescription, Stock, uuid
from .service import Actor, PharmacyService, WorkflowError, positive

ZERO = Decimal("0")


class FillObligation(Base):
    __tablename__ = "py_fill_obligations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), nullable=False, index=True)
    anchor_fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, unique=True)
    intended: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    dispensed: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False, default=ZERO)
    remaining: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN")
    __table_args__ = (
        CheckConstraint("intended > 0 AND dispensed >= 0 AND remaining >= 0 "
                        "AND dispensed + remaining = intended", name="ck_py_fill_obligation_balance"),
        CheckConstraint("status IN ('OPEN', 'FULFILLED', 'VOID_UNSOLD')",
                        name="ck_py_fill_obligation_status"),
    )


class FillCompletion(Base):
    __tablename__ = "py_fill_completions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    obligation_id: Mapped[str] = mapped_column(ForeignKey("py_fill_obligations.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, unique=True)
    part_number: Mapped[int] = mapped_column(Integer, nullable=False)
    __table_args__ = (
        UniqueConstraint("obligation_id", "part_number", name="uq_py_completion_part_number"),
        CheckConstraint("part_number >= 2", name="ck_py_completion_part_number"),
    )


def _obligation_for_sale(s: Session, fill: Fill, site_id: str) -> FillObligation | None:
    link = s.scalar(select(FillCompletion).where(
        FillCompletion.fill_id == fill.id, FillCompletion.site_id == site_id))
    if link:
        item = s.scalar(select(FillObligation).where(
            FillObligation.id == link.obligation_id,
            FillObligation.site_id == site_id).with_for_update())
        if item is None:
            raise WorkflowError("Linked partial-fill obligation missing")
        return item
    item = s.scalar(select(FillObligation).where(
        FillObligation.anchor_fill_id == fill.id,
        FillObligation.site_id == site_id).with_for_update())
    return item


def guard_new_logical_fill(s: Session, rx: Prescription) -> None:
    if s.scalar(select(FillObligation.id).where(
        FillObligation.prescription_id == rx.id,
        FillObligation.site_id == rx.site_id,
        FillObligation.status == "OPEN")):
        raise WorkflowError("Complete or reconcile the outstanding partial before starting a new refill")


def _assert_completion_rx_eligible(s: Session, rx: Prescription) -> None:
    """Same logical claim: check expiry and DUR, not the *new-refill* spacing interval."""
    today = date.today().isoformat()
    if rx.expiration_date and rx.expiration_date < today:
        raise WorkflowError("Prescription expired; completion requires clinical review")
    if rx.do_not_fill_before and rx.do_not_fill_before > today:
        raise WorkflowError("Prescription do-not-fill-before date not reached")
    if s.scalar(select(DUR.id).where(DUR.prescription_id == rx.id,
                                    DUR.severity == "HIGH", DUR.resolved.is_(False))):
        raise WorkflowError("Unresolved high-severity DUR issue")


def require_fill_date_eligible(s: Session, rx: Prescription, fill: Fill) -> None:
    """Central gate for single-fill verification, POS and native desktop sale."""
    if s.scalar(select(FillCompletion.id).where(FillCompletion.fill_id == fill.id)):
        _assert_completion_rx_eligible(s, rx)
    else:
        from .date_rules import require_date_eligible
        require_date_eligible(s, rx)


def record_physical_sale(s: Session, actor: Actor, fill: Fill) -> None:
    """Update the owed balance in the caller's sale transaction (one sale per part)."""
    obligation = _obligation_for_sale(s, fill, actor.site_id)
    if obligation is None:
        return
    if obligation.status != "OPEN" or obligation.prescription_id != fill.prescription_id:
        raise WorkflowError("Partial-fill obligation is not open for sale")
    if fill.quantity > obligation.remaining:
        raise WorkflowError("Physical sale exceeds remaining owed quantity")
    obligation.dispensed += fill.quantity
    obligation.remaining -= fill.quantity
    if obligation.remaining == ZERO:
        obligation.status = "FULFILLED"
    PharmacyService._audit(s, actor, "PARTIAL_PHYSICAL_SOLD", fill.id, {
        "anchor_fill_id": obligation.anchor_fill_id, "physical_sold": str(fill.quantity),
        "cumulative_sold": str(obligation.dispensed),
        "remaining_owed": str(obligation.remaining),
    })


def void_unissued_obligation(s: Session, actor: Actor, fill: Fill, reason: str) -> None:
    """Void an unissued primary partial after RTS/cancel without erasing its history."""
    obligation = s.scalar(select(FillObligation).where(
        FillObligation.anchor_fill_id == fill.id,
        FillObligation.site_id == actor.site_id).with_for_update())
    if obligation is not None:
        if obligation.dispensed != ZERO or obligation.status != "OPEN":
            raise WorkflowError("A previously sold partial requires pharmacist reconciliation")
        obligation.status = "VOID_UNSOLD"
        PharmacyService._audit(s, actor, "PARTIAL_ROOT_VOIDED", fill.id, {"reason": reason})


class FillCompletionService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def interrupt_as_partial(self, actor: Actor, fill_id: str, quantity: str, reason: str) -> str:
        physical = positive(quantity)
        note = (reason or "").strip()
        if not note or len(note) > 1000:
            raise WorkflowError("Documented interruption reason is required (up to 1000 characters)")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            fill = s.scalar(select(Fill).where(Fill.id == fill_id).with_for_update())
            if fill is None:
                raise WorkflowError("Fill not found")
            rx = self.service._site(s, Prescription, fill.prescription_id, actor)
            if fill.status != "PRODUCT_FILL" or rx.status != "PRODUCT_FILL":
                raise WorkflowError("Only an active Product Fill may be interrupted")
            if not ZERO < physical < fill.quantity:
                raise WorkflowError("Partial quantity must be below the original physical target")
            from .emergency_supply import emergency_for_fill
            if emergency_for_fill(s, fill.id, actor.site_id):
                raise WorkflowError("Emergency supply cannot be converted to an ordinary partial")
            if s.scalar(select(FillObligation.id).where(FillObligation.anchor_fill_id == fill.id)) or s.scalar(
                select(FillCompletion.id).where(FillCompletion.fill_id == fill.id)):
                raise WorkflowError("Partially linked fills cannot be interrupted a second time")
            if s.scalar(select(Claim.id).where(Claim.fill_id == fill.id)):
                raise WorkflowError("A billed fill cannot be interrupted with this workflow")
            from .inventory_ops import record_movement
            sources = s.scalars(select(FillSource).where(FillSource.fill_id == fill.id)).all()
            for source in sources:
                stock = s.scalar(select(Stock).where(
                    Stock.id == source.stock_id, Stock.site_id == actor.site_id).with_for_update())
                if stock is None or stock.reserved < source.quantity:
                    raise WorkflowError("Physical stock reservation inconsistent")
                from .inventory_allocations import (
                    source_allocation, allocation_location_id, transition_allocation,
                )
                allocation = source_allocation(s, actor, fill, stock, source)
                record_movement(s, actor, stock, "PARTIAL_INTERRUPT_RELEASE",
                                reserved=-source.quantity, reason=note,
                                location_id=allocation_location_id(s, allocation))
                transition_allocation(s, actor, allocation, "RELEASED",
                    "Partial interruption voided original scanned reservation",
                    release_source_link=True)
                s.delete(source)
            # Require an explicit fresh scan for the *actual* physical part; never silently
            # assume a source remains trustworthy after a reported shortage.
            fill.quantity = physical
            from .inventory_demands import update_fill_demand_tx
            update_fill_demand_tx(s, actor, fill, rx, reason=note)
            obligation = FillObligation(site_id=actor.site_id, prescription_id=rx.id,
                anchor_fill_id=fill.id, intended=fill.billed_quantity, dispensed=ZERO,
                remaining=fill.billed_quantity, status="OPEN")
            s.add(obligation)
            s.flush()
            self.service._audit(s, actor, "FILL_INTERRUPTED_PARTIAL", fill.id, {
                "intended": str(obligation.intended), "new_physical_part": str(physical),
                "released_sources": len(sources), "requires_rescan": True,
                "reason": note,
            })
            return obligation.id

    def begin_completion(self, actor: Actor, anchor_fill_id: str, quantity: str | None = None) -> str:
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            obligation = s.scalar(select(FillObligation).where(
                FillObligation.anchor_fill_id == anchor_fill_id,
                FillObligation.site_id == actor.site_id).with_for_update())
            if obligation is None or obligation.status != "OPEN" or obligation.remaining <= ZERO:
                raise WorkflowError("No outstanding partial-fill balance at this site")
            anchor = s.get(Fill, anchor_fill_id)
            rx = self.service._site(s, Prescription, obligation.prescription_id, actor)
            if anchor is None or anchor.status != "SOLD" or anchor.prescription_id != rx.id:
                raise WorkflowError("Original partial must be physically sold before completion")
            if rx.status != "SOLD":
                raise WorkflowError("Prescription must be available for partial completion")
            _assert_completion_rx_eligible(s, rx)
            if s.scalar(select(Fill.id).where(
                Fill.prescription_id == rx.id,
                Fill.status.in_(("PRODUCT_FILL", "PHARMACIST_REVIEW", "READY")))):
                raise WorkflowError("Another physical fill is already active")
            amount = positive(quantity) if quantity is not None else obligation.remaining
            if amount > obligation.remaining:
                raise WorkflowError("Completion exceeds the remaining quantity owed")
            existing = s.scalars(select(FillCompletion).where(
                FillCompletion.obligation_id == obligation.id)).all()
            previous_parts = [s.get(Fill, x.fill_id) for x in existing]
            if any(f is None or f.status not in {"SOLD", "RETURNED", "CANCELLED"}
                   for f in previous_parts):
                raise WorkflowError("Previous completion must be sold or reconciled")
            attempted = s.scalars(select(Fill).where(
                Fill.prescription_id == rx.id, Fill.fill_number == anchor.fill_number)).all()
            fill = Fill(prescription_id=rx.id, fill_number=anchor.fill_number,
                        attempt=max(f.attempt for f in attempted) + 1,
                        quantity=amount, billed_quantity=anchor.billed_quantity,
                        status="PRODUCT_FILL")
            s.add(fill)
            s.flush()
            link = FillCompletion(site_id=actor.site_id, obligation_id=obligation.id,
                                  fill_id=fill.id,
                                  part_number=max((x.part_number for x in existing), default=1) + 1)
            s.add(link)
            rx.status = "PRODUCT_FILL"
            self.service._audit(s, actor, "PARTIAL_COMPLETION_STARTED", fill.id, {
                "anchor_fill_id": anchor.id, "part_number": link.part_number,
                "planned_physical": str(amount), "remaining_owed": str(obligation.remaining),
                "payer_claim_created": False,
            })
            return fill.id

    def balance(self, actor: Actor, anchor_fill_id: str) -> dict:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            item = s.scalar(select(FillObligation).where(
                FillObligation.anchor_fill_id == anchor_fill_id,
                FillObligation.site_id == actor.site_id))
            if item is None:
                raise WorkflowError("Partial-fill obligation not found at this site")
            links = s.scalars(select(FillCompletion).where(
                FillCompletion.obligation_id == item.id).order_by(FillCompletion.part_number)).all()
            return {
                "anchor_fill_id": item.anchor_fill_id, "prescription_id": item.prescription_id,
                "status": item.status, "intended": str(item.intended),
                "physically_sold": str(item.dispensed), "remaining_owed": str(item.remaining),
                "completions": [{"fill_id": link.fill_id, "part_number": link.part_number,
                                 "status": s.get(Fill, link.fill_id).status} for link in links],
            }
