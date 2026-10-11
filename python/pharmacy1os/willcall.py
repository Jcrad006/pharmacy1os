"""Synthetic Will Call custody, retired barcode registry and audit trail."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, Fill, Prescription, WillCall, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError


class WillCallBarcodeRecord(Base):
    __tablename__ = "py_will_call_barcode_records"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, index=True)
    barcode: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    assigned_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    retired_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"), nullable=True)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __table_args__ = (
        CheckConstraint("status IN ('ACTIVE', 'RETIRED', 'CLOSED')", name="ck_py_wcb_state"),
        Index("ix_py_wcb_site_fill", "site_id", "fill_id"),
    )


class WillCallCustodyEvent(Base):
    __tablename__ = "py_will_call_custody_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    old_barcode: Mapped[str | None] = mapped_column(String(100), nullable=True)
    new_barcode: Mapped[str | None] = mapped_column(String(100), nullable=True)
    old_bin: Mapped[str | None] = mapped_column(String(60), nullable=True)
    new_bin: Mapped[str | None] = mapped_column(String(60), nullable=True)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__ = (
        CheckConstraint("kind IN ('STAGED','REBAGGED','RELOCATED','SOLD','RETURNED')", name="ck_py_wc_event_kind"),
        Index("ix_py_wc_event_site_fill", "site_id", "fill_id"),
    )


def _barcode(value: str) -> str:
    if not isinstance(value, str) or not (clean := value.strip().upper()) or len(clean) > 100:
        raise WorkflowError("Will Call barcode must contain 1-100 characters")
    return clean


def _bin(value: str) -> str:
    if not isinstance(value, str) or not (clean := value.strip()) or len(clean) > 60:
        raise WorkflowError("Will Call bin must contain 1-60 characters")
    return clean


def _reason(value: str) -> str:
    if not isinstance(value, str) or not (clean := value.strip()) or len(clean) > 1000:
        raise WorkflowError("A documented reason of at most 1000 characters is required")
    return clean


def _record_event(s, actor: Actor, f: Fill, kind: str, *, old_barcode: str | None = None,
                  new_barcode: str | None = None, old_bin: str | None = None,
                  new_bin: str | None = None, reason: str) -> None:
    s.add(WillCallCustodyEvent(site_id=actor.site_id, fill_id=f.id, kind=kind,
                               old_barcode=old_barcode, new_barcode=new_barcode,
                               old_bin=old_bin, new_bin=new_bin, reason=reason,
                               actor_id=actor.id))


def assert_barcode_unused(s, barcode: str) -> str:
    clean = _barcode(barcode)
    if s.scalar(select(WillCallBarcodeRecord.id).where(WillCallBarcodeRecord.barcode == clean)):
        raise WorkflowError("Bag barcode was previously assigned; reuse is prohibited")
    if s.scalar(select(WillCall.id).where(WillCall.bag_barcode == clean)):
        raise WorkflowError("Bag barcode is already in use")
    return clean


def record_stage(s, actor: Actor, f: Fill, barcode: str, bin_name: str) -> None:
    clean, location = assert_barcode_unused(s, barcode), _bin(bin_name)
    s.add(WillCallBarcodeRecord(site_id=actor.site_id, fill_id=f.id, barcode=clean,
                                status="ACTIVE", assigned_by_id=actor.id))
    _record_event(s, actor, f, "STAGED", new_barcode=clean, new_bin=location,
                  reason="Initial physical Will Call staging")


def record_closed(s, actor: Actor, f: Fill, status: str, reason: str) -> None:
    bag = s.scalar(select(WillCall).where(WillCall.fill_id == f.id))
    if bag is None:
        return
    record = s.scalar(select(WillCallBarcodeRecord).where(
        WillCallBarcodeRecord.barcode == bag.bag_barcode))
    if record is not None and record.status == "ACTIVE":
        record.status = "CLOSED"
        record.retired_by_id = actor.id
        record.retired_at = utcnow()
    _record_event(s, actor, f, status, old_barcode=bag.bag_barcode,
                  old_bin=bag.bin_name, reason=reason)


class WillCallService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def _staged(self, s, actor: Actor, fill_id: str):
        self.service._authorized(s, actor, "process")
        fill = s.scalar(select(Fill).where(Fill.id == fill_id).with_for_update())
        if fill is None:
            raise WorkflowError("Fill not found")
        rx = self.service._site(s, Prescription, fill.prescription_id, actor)
        package = s.scalar(select(WillCall).where(WillCall.fill_id == fill_id).with_for_update())
        if fill.status != "READY" or rx.status != "READY" or package is None or package.status != "STAGED":
            raise WorkflowError("Only a ready, staged Will Call fill can be modified")
        return fill, package

    def rebag(self, actor: Actor, fill_id: str, new_barcode: str, reason: str) -> str:
        clean, explanation = _barcode(new_barcode), _reason(reason)
        with self.service.sessions.begin() as s:
            f, bag = self._staged(s, actor, fill_id)
            old = _barcode(bag.bag_barcode)
            if clean == old:
                raise WorkflowError("Replacement bag barcode must be different")
            assert_barcode_unused(s, clean)
            prior = s.scalar(select(WillCallBarcodeRecord).where(WillCallBarcodeRecord.barcode == old))
            if prior is None:
                prior = WillCallBarcodeRecord(site_id=actor.site_id, fill_id=f.id,
                                              barcode=old, status="ACTIVE", assigned_by_id=actor.id)
                s.add(prior)
            elif prior.site_id != actor.site_id or prior.fill_id != f.id or prior.status != "ACTIVE":
                raise WorkflowError("Will Call source barcode custody is inconsistent")
            prior.status = "RETIRED"
            prior.retired_by_id = actor.id
            prior.retired_at = utcnow()
            bag.bag_barcode = clean
            s.add(WillCallBarcodeRecord(site_id=actor.site_id, fill_id=f.id,
                                        barcode=clean, status="ACTIVE", assigned_by_id=actor.id))
            _record_event(s, actor, f, "REBAGGED", old_barcode=old, new_barcode=clean,
                          old_bin=bag.bin_name, new_bin=bag.bin_name, reason=explanation)
            self.service._audit(s, actor, "WILL_CALL_REBAGGED", f.id,
                                {"old_barcode": old, "new_barcode": clean, "reason": explanation})
            return clean

    def relocate(self, actor: Actor, fill_id: str, new_bin: str, reason: str) -> str:
        location, explanation = _bin(new_bin), _reason(reason)
        with self.service.sessions.begin() as s:
            f, bag = self._staged(s, actor, fill_id)
            old = bag.bin_name
            if old == location:
                raise WorkflowError("New bin must differ from the current bin")
            bag.bin_name = location
            _record_event(s, actor, f, "RELOCATED", old_barcode=bag.bag_barcode,
                          new_barcode=bag.bag_barcode, old_bin=old, new_bin=location,
                          reason=explanation)
            self.service._audit(s, actor, "WILL_CALL_RELOCATED", f.id,
                                {"old_bin": old, "new_bin": location, "reason": explanation})
            return location

    def history(self, actor: Actor, fill_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            self.service._site(s, Prescription, fill.prescription_id, actor)
            events = s.scalars(select(WillCallCustodyEvent).where(
                WillCallCustodyEvent.site_id == actor.site_id,
                WillCallCustodyEvent.fill_id == fill_id).order_by(
                WillCallCustodyEvent.occurred_at, WillCallCustodyEvent.id)).all()
            return [{"id": x.id, "kind": x.kind, "old_barcode": x.old_barcode,
                     "new_barcode": x.new_barcode, "old_bin": x.old_bin,
                     "new_bin": x.new_bin, "reason": x.reason, "actor_id": x.actor_id}
                    for x in events]
