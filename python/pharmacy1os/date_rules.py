"""Synthetic dispensing date gates ported from clinical/dateRules.ts.

No insurance/legal refill allowance is inferred. Sale timestamps are recorded at
pickup; legacy SOLD fills without a timestamp fail closed when minimum-day rules
are active. Future-day previews use 00:00 UTC conservatively.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column, Session
from .models import Base, Fill, Prescription, Sale, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError


class PrescriptionDatePolicy(Base):
    __tablename__ = "py_rx_date_policies"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), nullable=False, unique=True)
    minimum_days_between_fills: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (CheckConstraint("minimum_days_between_fills BETWEEN 0 AND 365", name="ck_py_rx_date_interval"),)


class FillSaleTimestamp(Base):
    """Append-only, pharmacy-site-aware timestamp of completed sale, never an estimate."""
    __tablename__ = "py_fill_sale_timestamps"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, unique=True)
    sold_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    sold_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


@dataclass(frozen=True)
class DateRuleBlock:
    code: str
    message: str
    eligible_at: str | None = None


def _day(value: str | None, field: str) -> date | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) != 10:
        raise WorkflowError(f"{field} must be YYYY-MM-DD")
    try:
        d = date.fromisoformat(value)
    except ValueError as exc:
        raise WorkflowError(f"{field} is not a valid calendar date") from exc
    if d.isoformat() != value:
        raise WorkflowError(f"{field} must be YYYY-MM-DD")
    return d


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def evaluate_date_rules(session: Session, rx: Prescription, *, on: date | None = None,
                        now: datetime | None = None) -> list[DateRuleBlock]:
    """Read-only rule evaluation; never claims state from an unverified sold timestamp."""
    if on is not None and now is not None:
        raise WorkflowError("Specify a date or timestamp, not both")
    instant = _utc(now) if now is not None else (datetime.combine(on, time.min, tzinfo=timezone.utc)
                                                  if on is not None else datetime.now(timezone.utc))
    today = instant.date()
    blocks: list[DateRuleBlock] = []
    expiry = _day(rx.expiration_date, "Prescription expiration")
    not_before = _day(rx.do_not_fill_before, "Do-not-fill-before")
    if expiry is not None and today > expiry:
        blocks.append(DateRuleBlock("RX_EXPIRED", "Prescription expired"))
    if not_before is not None and today < not_before:
        blocks.append(DateRuleBlock("DO_NOT_FILL_BEFORE", "Do-not-fill-before date not reached", not_before.isoformat()))
    policy = session.scalar(select(PrescriptionDatePolicy).where(
        PrescriptionDatePolicy.prescription_id == rx.id,
        PrescriptionDatePolicy.site_id == rx.site_id))
    if policy is None or policy.minimum_days_between_fills <= 0:
        return blocks
    sold_fills = session.scalars(select(Fill).where(Fill.prescription_id == rx.id, Fill.status == "SOLD")).all()
    if not sold_fills:
        return blocks
    events = session.scalars(select(FillSaleTimestamp).where(
        FillSaleTimestamp.site_id == rx.site_id,
        FillSaleTimestamp.fill_id.in_([f.id for f in sold_fills]))).all()
    recorded = {e.fill_id: e for e in events}
    if any(f.id not in recorded for f in sold_fills):
        blocks.append(DateRuleBlock("SALE_TIME_UNKNOWN", "A previous sold fill lacks verified pickup time; pharmacist review required"))
        return blocks
    last = max(_utc(e.sold_at) for e in events)
    eligible = last + timedelta(days=policy.minimum_days_between_fills)
    if instant < eligible:
        blocks.append(DateRuleBlock("REFILL_TOO_SOON",
            f"At least {policy.minimum_days_between_fills} day(s) required since last sold fill",
            eligible.isoformat()))
    return blocks


def require_date_eligible(session: Session, rx: Prescription, *, on: date | None = None,
                          now: datetime | None = None) -> None:
    blocks = evaluate_date_rules(session, rx, on=on, now=now)
    if blocks:
        raise WorkflowError(f"{blocks[0].code}: {blocks[0].message}")


def record_sale_time(session: Session, actor: Actor, fill: Fill) -> None:
    """Invoke within the same transaction that sets status SOLD and creates Sale."""
    if session.scalar(select(FillSaleTimestamp.id).where(FillSaleTimestamp.fill_id == fill.id)):
        raise WorkflowError("Completed sale timestamp already recorded")
    session.add(FillSaleTimestamp(site_id=actor.site_id, fill_id=fill.id,
                                  sold_by_id=actor.id, sold_at=utcnow()))


class DateRulesService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def preview(self, actor: Actor, prescription_id: str, *, target_day: str | None = None) -> dict:
        date_target = _day(target_day, "Target date")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rx = self.service._site(s, Prescription, prescription_id, actor)
            policy = s.scalar(select(PrescriptionDatePolicy).where(
                PrescriptionDatePolicy.site_id == actor.site_id,
                PrescriptionDatePolicy.prescription_id == rx.id))
            blocks = evaluate_date_rules(s, rx, on=date_target)
            return {"prescription_id": rx.id, "target_day": target_day or date.today().isoformat(),
                    "minimum_days_between_fills": policy.minimum_days_between_fills if policy else 0,
                    "eligible": not blocks,
                    "blocks": [{"code": b.code, "message": b.message, "eligible_at": b.eligible_at} for b in blocks]}

    def set_minimum_days(self, actor: Actor, prescription_id: str, days: int, reason: str) -> None:
        if isinstance(days, bool) or not isinstance(days, int) or not 0 <= days <= 365:
            raise WorkflowError("Minimum days must be an integer from 0 to 365")
        if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 1000:
            raise WorkflowError("A documented policy-change reason is required")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "clinical")
            rx = self.service._site(s, Prescription, prescription_id, actor)
            old = s.scalar(select(PrescriptionDatePolicy).where(
                PrescriptionDatePolicy.site_id == actor.site_id,
                PrescriptionDatePolicy.prescription_id == rx.id).with_for_update())
            before = old.minimum_days_between_fills if old else 0
            if old:
                old.minimum_days_between_fills = days
                old.updated_at = utcnow()
                old.updated_by_id = actor.id
            else:
                s.add(PrescriptionDatePolicy(site_id=actor.site_id, prescription_id=rx.id,
                         minimum_days_between_fills=days, updated_by_id=actor.id))
            self.service._audit(s, actor, "RX_DATE_POLICY_CHANGED", rx.id,
                                {"old_days": before, "new_days": days, "reason": reason.strip()})
