"""Synthetic pharmacist-authorized emergency supply and follow-up provenance.

Follows selected Stage 3I workflow constraints but *never* asserts that a fill
is legally permissible. No controlled substances, payer transactions, or
emergency overrides of prescription expiry/DUR/date rules.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, String, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .models import Base, Drug, DUR, Fill, Prescription, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError, positive

ACTIVE_FILL_STATES = ("PRODUCT_FILL", "PHARMACIST_REVIEW", "READY")


class EmergencySupply(Base):
    __tablename__ = "py_emergency_supplies"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(
        ForeignKey("py_prescriptions.id"), nullable=False, unique=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, unique=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    authorized_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    authorized_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow)
    follow_up_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN")
    follow_up_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"))
    follow_up_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    follow_up_note: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_py_emergency_quantity"),
        CheckConstraint("status IN ('OPEN','COMPLETED','VOID_UNSOLD')",
                        name="ck_py_emergency_state"),
    )


def _reason(value: str, field: str = "Documented reason") -> str:
    note = value.strip() if isinstance(value, str) else ""
    if not 1 <= len(note) <= 2000:
        raise WorkflowError(f"{field} is required (1-2000 characters)")
    return note


def _due(value: str) -> datetime:
    try:
        due = datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise WorkflowError("Follow-up deadline requires ISO 8601 timezone-aware date/time") from exc
    if due.tzinfo is None or due.utcoffset() is None:
        raise WorkflowError("Follow-up deadline must include an explicit timezone")
    due = due.astimezone(timezone.utc)
    if due <= datetime.now(timezone.utc):
        raise WorkflowError("Follow-up deadline must be in the future")
    return due


def emergency_for_fill(s: Session, fill_id: str, site_id: str) -> EmergencySupply | None:
    return s.scalar(select(EmergencySupply).where(
        EmergencySupply.fill_id == fill_id, EmergencySupply.site_id == site_id))


def require_emergency_claim_separation(s: Session, fill_id: str, site_id: str,
                                       payers: list[str]) -> None:
    if emergency_for_fill(s, fill_id, site_id) and payers:
        raise WorkflowError("Emergency supply does not support synthetic payer claims")


def require_emergency_dispense_eligible(s: Session, rx: Prescription, fill: Fill) -> None:
    """Recheck mutable catalog/Rx classification during scan, verify and checkout.

    Authorization is not a standing right to dispense after the clinical record
    changes. Ordinary non-emergency fills are unaffected.
    """
    event = emergency_for_fill(s, fill.id, rx.site_id)
    if event is None:
        return
    if (event.status != "OPEN" or event.prescription_id != rx.id
            or event.quantity != fill.quantity
            or fill.billed_quantity != event.quantity):
        raise WorkflowError("Emergency authorization no longer matches this physical fill")
    drug = s.get(Drug, rx.drug_id)
    if drug is None or drug.controlled:
        raise WorkflowError("Emergency supply blocked by controlled or missing catalog drug")
    if rx.refills_used < rx.refills_allowed:
        raise WorkflowError("Authorized refills are now available; emergency requires review")
    from .fill_completion import guard_new_logical_fill
    guard_new_logical_fill(s, rx)


def void_unsold_emergency(s: Session, actor: Actor, fill: Fill, reason: str) -> bool:
    """Called inside return-to-stock or cancellation, never on a sold fill."""
    record = s.scalar(select(EmergencySupply).where(
        EmergencySupply.fill_id == fill.id, EmergencySupply.site_id == actor.site_id
    ).with_for_update())
    if record is None:
        return False
    if record.status != "OPEN" or fill.status == "SOLD":
        raise WorkflowError("A dispensed emergency supply cannot be silently voided")
    record.status = "VOID_UNSOLD"
    PharmacyService._audit(s, actor, "EMERGENCY_SUPPLY_UNSOLD_VOIDED", fill.id, {
        "reason": _reason(reason), "prescription_id": record.prescription_id,
        "follow_up_status": "VOID_UNSOLD",
    })
    return True


class EmergencySupplyService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def authorize(self, actor: Actor, prescription_id: str, quantity: str, reason: str,
                  follow_up_due_at: str) -> str:
        amount = positive(quantity)
        note = _reason(reason, "Pharmacist emergency justification")
        due = _due(follow_up_due_at)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "verify")
            rx = s.scalar(select(Prescription).where(
                Prescription.id == prescription_id,
                Prescription.site_id == actor.site_id).with_for_update())
            if rx is None:
                raise WorkflowError("Prescription not found at pharmacy site")
            if rx.status != "SOLD":
                raise WorkflowError("Emergency supply requires a previously sold prescription")
            if rx.refills_used < rx.refills_allowed:
                raise WorkflowError("Authorized refills remain; use the usual refill workflow")
            if amount > rx.quantity:
                raise WorkflowError("Emergency quantity cannot exceed the written quantity")
            drug = s.get(Drug, rx.drug_id)
            if drug is None or drug.controlled:
                raise WorkflowError("Controlled or unidentified products cannot use emergency supply")
            if s.scalar(select(EmergencySupply.id).where(
                EmergencySupply.prescription_id == rx.id)):
                raise WorkflowError("An emergency supply is already documented for this prescription")
            from .fill_completion import guard_new_logical_fill
            from .prescription_transfer import require_no_pending_transfer
            require_no_pending_transfer(s, rx)
            guard_new_logical_fill(s, rx)
            from .date_rules import require_date_eligible
            require_date_eligible(s, rx)
            if s.scalar(select(DUR.id).where(
                DUR.prescription_id == rx.id, DUR.severity == "HIGH", DUR.resolved.is_(False))):
                raise WorkflowError("Unresolved high-severity DUR issue")
            from .scheduling_models import ScheduledFill
            if s.scalar(select(ScheduledFill.id).where(
                ScheduledFill.prescription_id == rx.id, ScheduledFill.status == "PENDING")):
                raise WorkflowError("Resolve pending scheduled fill before emergency supply")
            fills = s.scalars(select(Fill).where(Fill.prescription_id == rx.id)).all()
            if any(f.status in ACTIVE_FILL_STATES for f in fills):
                raise WorkflowError("Existing active physical fill must be resolved")
            sold = [f for f in fills if f.status == "SOLD" and f.fill_number >= 0]
            if not sold:
                raise WorkflowError("Emergency supply requires an earlier regular sold fill")
            latest = max(sold, key=lambda f: (f.fill_number, f.attempt))
            attempt = max((f.attempt for f in fills
                           if f.fill_number == latest.fill_number), default=0) + 1
            fill = Fill(prescription_id=rx.id, fill_number=latest.fill_number,
                        attempt=attempt, quantity=amount, billed_quantity=amount,
                        status="PRODUCT_FILL")
            s.add(fill)
            s.flush()
            event = EmergencySupply(site_id=actor.site_id, prescription_id=rx.id,
                fill_id=fill.id, quantity=amount, reason=note, authorized_by_id=actor.id,
                follow_up_due_at=due, status="OPEN")
            s.add(event)
            rx.status = "PRODUCT_FILL"
            s.flush()
            self.service._audit(s, actor, "EMERGENCY_SUPPLY_AUTHORIZED", fill.id, {
                "quantity": str(amount), "reason": note,
                "follow_up_due_at": due.isoformat(), "previous_fill_id": latest.id,
                "consumes_refill": False, "payer_claims_permitted": False,
            })
            return fill.id

    def complete_follow_up(self, actor: Actor, fill_id: str, note: str) -> None:
        comment = _reason(note, "Follow-up clinical note")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "clinical")
            event = s.scalar(select(EmergencySupply).where(
                EmergencySupply.fill_id == fill_id,
                EmergencySupply.site_id == actor.site_id).with_for_update())
            if event is None:
                raise WorkflowError("Emergency supply not found at pharmacy site")
            if event.status != "OPEN":
                raise WorkflowError("Emergency follow-up is no longer open")
            fill = s.get(Fill, event.fill_id)
            if fill is None or fill.status != "SOLD":
                raise WorkflowError("Only physically sold emergency supply can complete follow-up")
            event.status = "COMPLETED"
            event.follow_up_by_id = actor.id
            event.follow_up_completed_at = utcnow()
            event.follow_up_note = comment
            self.service._audit(s, actor, "EMERGENCY_SUPPLY_FOLLOW_UP_COMPLETED",
                                fill.id, {"note": comment, "prescription_id": event.prescription_id})

    def list(self, actor: Actor, *, include_closed: bool = True) -> list[dict]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            events = s.scalars(select(EmergencySupply).where(
                EmergencySupply.site_id == actor.site_id).order_by(
                EmergencySupply.follow_up_due_at, EmergencySupply.id)).all()
            return [{
                "id": e.id, "prescription_id": e.prescription_id, "fill_id": e.fill_id,
                "quantity": str(e.quantity), "reason": e.reason, "status": e.status,
                "authorized_by_id": e.authorized_by_id,
                "follow_up_due_at": e.follow_up_due_at.isoformat(),
                "follow_up_by_id": e.follow_up_by_id,
                "follow_up_completed_at": e.follow_up_completed_at.isoformat()
                    if e.follow_up_completed_at else None,
            } for e in events if include_closed or e.status == "OPEN"]
