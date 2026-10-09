"""Synthetic future-fill / refill orchestration with server-side DUR gates.

No automatic claim transmission, refill dispensing, or legal eligibility inference.
Only the explicit start_due action may create a fill and it re-evaluates the Rx.
"""
from __future__ import annotations
from datetime import date
from typing import Any
from sqlalchemy import select
from .models import DUR, Fill, Prescription, utcnow
from .scheduling_models import ScheduledFill
from .service import Actor, PharmacyService, WorkflowError, positive


def _iso_day(value: str) -> date:
    if not isinstance(value, str) or len(value) != 10:
        raise WorkflowError("Date must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise WorkflowError("Invalid calendar date") from exc
    if parsed.isoformat() != value:
        raise WorkflowError("Date must be YYYY-MM-DD")
    return parsed


class SchedulingService:
    def __init__(self, service: PharmacyService):
        self.service = service

    @staticmethod
    def _serialize(entry: ScheduledFill) -> dict[str, Any]:
        return {"id": entry.id, "prescription_id": entry.prescription_id,
                "due_date": entry.due_date, "quantity": entry.quantity,
                "status": entry.status, "idempotency_key": entry.idempotency_key,
                "fill_id": entry.fill_id}

    def list(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            entries = s.scalars(select(ScheduledFill).where(ScheduledFill.site_id == actor.site_id)
                                .order_by(ScheduledFill.due_date, ScheduledFill.id)).all()
            return [self._serialize(e) for e in entries]

    def schedule(self, actor: Actor, prescription_id: str, due_date: str,
                 idempotency_key: str, quantity: str | None = None) -> str:
        due = _iso_day(due_date)
        key = idempotency_key.strip() if isinstance(idempotency_key, str) else ""
        if not key or len(key) > 100:
            raise WorkflowError("A stable idempotency key (up to 100 characters) is required")
        q = str(positive(quantity)) if quantity is not None else None
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            rx = self.service._site(s, Prescription, prescription_id, actor)
            prior = s.scalar(select(ScheduledFill).where(ScheduledFill.site_id == actor.site_id,
                                                        ScheduledFill.idempotency_key == key))
            if prior is not None:
                if (prior.prescription_id, prior.due_date, prior.quantity) != (prescription_id, due_date, q):
                    raise WorkflowError("Idempotency key already used with different scheduling details")
                return prior.id
            from .fill_completion import guard_new_logical_fill
            guard_new_logical_fill(s, rx)
            if rx.status not in {"DUR_REVIEW", "SOLD"}:
                raise WorkflowError("Schedule only after DUR review or from a previously sold prescription")
            if rx.expiration_date and due.isoformat() > rx.expiration_date:
                raise WorkflowError("Schedule cannot exceed prescription expiration date")
            if rx.do_not_fill_before and due.isoformat() < rx.do_not_fill_before:
                raise WorkflowError("Schedule cannot precede do-not-fill-before date")
            from .date_rules import require_date_eligible
            require_date_eligible(s, rx, on=due)
            if q is not None and positive(q) > rx.quantity:
                raise WorkflowError("Scheduled quantity exceeds authorized quantity")
            if s.scalar(select(ScheduledFill.id).where(ScheduledFill.prescription_id == rx.id,
                                                     ScheduledFill.status == "PENDING")):
                raise WorkflowError("There is already a pending scheduled fill for this prescription")
            item = ScheduledFill(site_id=actor.site_id, prescription_id=rx.id, due_date=due_date,
                                 idempotency_key=key, quantity=q, created_by_id=actor.id)
            s.add(item)
            s.flush()
            self.service._audit(s, actor, "FILL_SCHEDULED", item.id,
                                {"rx_id": rx.id, "due_date": due_date, "quantity": q})
            return item.id

    def cancel(self, actor: Actor, scheduled_id: str, reason: str) -> None:
        if not reason or not reason.strip():
            raise WorkflowError("A cancellation reason is required")
        if len(reason.strip()) > 500:
            raise WorkflowError("Cancellation reason is too long")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            schedule = self.service._site(s, ScheduledFill, scheduled_id, actor)
            if schedule.status != "PENDING":
                raise WorkflowError("Only a pending future fill can be cancelled")
            schedule.status = "CANCELLED"
            schedule.cancelled_by_id = actor.id
            schedule.cancelled_at = utcnow()
            schedule.cancelled_reason = reason.strip()
            self.service._audit(s, actor, "SCHEDULED_FILL_CANCELLED", schedule.id,
                                {"prescription_id": schedule.prescription_id, "reason": reason.strip()})

    def begin_refill_review(self, actor: Actor, prescription_id: str, reason: str) -> None:
        if not reason or not reason.strip():
            raise WorkflowError("Refill review reason is required")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            rx = self.service._site(s, Prescription, prescription_id, actor)
            if rx.status != "SOLD":
                raise WorkflowError("Refill review is only available after a sold fill")
            from .fill_completion import guard_new_logical_fill
            guard_new_logical_fill(s, rx)
            fills = s.scalars(select(Fill).where(Fill.prescription_id == rx.id)).all()
            if any(f.status in ("PRODUCT_FILL", "PHARMACIST_REVIEW", "READY") for f in fills):
                raise WorkflowError("An active fill prevents refill review")
            if max((f.fill_number for f in fills if f.status == "SOLD"), default=-1) >= rx.refills_allowed:
                raise WorkflowError("No refills remain")
            if rx.expiration_date and rx.expiration_date < date.today().isoformat():
                raise WorkflowError("Prescription expired")
            rx.status = "DUR_REVIEW"
            self.service._audit(s, actor, "RX_REFILL_DUR_REQUIRED", rx.id, {"reason": reason.strip()})

    def start_due(self, actor: Actor, scheduled_id: str, *, today: date | None = None) -> str:
        current = today or date.today()
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            schedule = s.scalar(select(ScheduledFill).where(
                ScheduledFill.id == scheduled_id, ScheduledFill.site_id == actor.site_id).with_for_update())
            if schedule is None:
                raise WorkflowError("Scheduled fill not found at actor site")
            if schedule.status == "STARTED" and schedule.fill_id:
                return schedule.fill_id  # idempotent successful retry
            if schedule.status != "PENDING":
                raise WorkflowError("Scheduled fill is not pending")
            if _iso_day(schedule.due_date) > current:
                raise WorkflowError("Future fill is not due")
            rx = self.service._site(s, Prescription, schedule.prescription_id, actor)
            if rx.status != "DUR_REVIEW":
                raise WorkflowError("Fresh DUR review is required before a scheduled fill starts")
            if rx.expiration_date and current.isoformat() > rx.expiration_date:
                raise WorkflowError("Prescription expired")
            if rx.do_not_fill_before and current.isoformat() < rx.do_not_fill_before:
                raise WorkflowError("Do-not-fill-before date not reached")
            if s.scalar(select(DUR.id).where(DUR.prescription_id == rx.id,
                        DUR.severity == "HIGH", DUR.resolved.is_(False))):
                raise WorkflowError("Unresolved high-severity DUR issue")
            fill_id = self.service._start_fill_tx(
                s, actor, rx, schedule.quantity, effective_date=current, scheduled_id=schedule.id)
            schedule.status = "STARTED"
            schedule.fill_id = fill_id
            schedule.started_by_id = actor.id
            schedule.started_at = utcnow()
            self.service._audit(s, actor, "SCHEDULED_FILL_STARTED", schedule.id,
                                {"prescription_id": rx.id, "fill_id": fill_id})
            return fill_id
