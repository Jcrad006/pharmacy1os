"""Synthetic prescription transfer-out handoff and pharmacist attestation.

This records a requested *external* transfer. Nothing is transmitted or
represented as legally completed until a pharmacist explicitly attests to
an independently handled exchange. No automatic transfer-in or EPCS.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, UniqueConstraint, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .models import Base, Drug, Fill, Prescription, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError


class TransferOut(Base):
    __tablename__ = "py_prescription_transfers_out"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(
        ForeignKey("py_prescriptions.id"), nullable=False, unique=True)
    request_key: Mapped[str] = mapped_column(String(120), nullable=False)
    destination_name: Mapped[str] = mapped_column(String(180), nullable=False)
    destination_phone: Mapped[str] = mapped_column(String(60), nullable=False)
    request_reason: Mapped[str] = mapped_column(Text, nullable=False)
    requested_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="REQUESTED")
    attested_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"))
    attested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    receiving_pharmacist: Mapped[str | None] = mapped_column(String(150))
    handoff_reference: Mapped[str | None] = mapped_column(String(150))
    attestation_note: Mapped[str | None] = mapped_column(Text)
    withdrawn_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"))
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    withdrawal_reason: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("site_id", "request_key", name="uq_py_transfer_out_request_key"),
        CheckConstraint("status IN ('REQUESTED', 'ATTESTED_OUT', 'WITHDRAWN')",
                        name="ck_py_transfer_out_status"),
    )


def required_text(value: str, name: str, limit: int) -> str:
    cleaned = value.strip() if isinstance(value, str) else ""
    if not cleaned or len(cleaned) > limit:
        raise WorkflowError(f"{name} must be provided and be at most {limit} characters")
    return cleaned


def require_no_pending_transfer(s: Session, rx: Prescription) -> None:
    if s.scalar(select(TransferOut.id).where(
        TransferOut.site_id == rx.site_id,
        TransferOut.prescription_id == rx.id,
        TransferOut.status == "REQUESTED")):
        raise WorkflowError("Prescription has a pending outgoing transfer request")


def _available_for_handoff(s: Session, rx: Prescription) -> None:
    if rx.status not in {"DUR_REVIEW", "SOLD"}:
        raise WorkflowError("Transfer-out requires reviewed or previously sold prescription")
    drug = s.get(Drug, rx.drug_id)
    if drug is None or drug.controlled:
        raise WorkflowError("Controlled/unidentified medication transfers need separate validated workflow")
    from .fill_completion import guard_new_logical_fill
    guard_new_logical_fill(s, rx)
    from .emergency_supply import EmergencySupply
    if s.scalar(select(EmergencySupply.id).where(
        EmergencySupply.prescription_id == rx.id,
        EmergencySupply.site_id == rx.site_id,
        EmergencySupply.status == "OPEN")):
        raise WorkflowError("Outstanding emergency follow-up or fill blocks transfer")
    from .scheduling_models import ScheduledFill
    if s.scalar(select(ScheduledFill.id).where(
        ScheduledFill.prescription_id == rx.id,
        ScheduledFill.status == "PENDING")):
        raise WorkflowError("Pending future-fill schedule must be resolved before transfer")
    if s.scalar(select(Fill.id).where(
        Fill.prescription_id == rx.id,
        Fill.status.in_(("PRODUCT_FILL", "PHARMACIST_REVIEW", "READY")))):
        raise WorkflowError("Active physical fill must be resolved before transfer")
    if rx.status == "SOLD" and rx.refills_used >= rx.refills_allowed:
        raise WorkflowError("No remaining refills to transfer from this sold prescription")


class TransferService:
    def __init__(self, service: PharmacyService):
        self.service = service

    @staticmethod
    def _view(event: TransferOut) -> dict[str, Any]:
        return {
            "id": event.id, "site_id": event.site_id, "prescription_id": event.prescription_id,
            "status": event.status, "destination_name": event.destination_name,
            "destination_phone": event.destination_phone,
            "request_key": event.request_key,
            "request_reason": event.request_reason,
            "requested_by_id": event.requested_by_id,
            "requested_at": event.requested_at.isoformat(),
            "receiving_pharmacist": event.receiving_pharmacist,
            "handoff_reference": event.handoff_reference,
            "attested_by_id": event.attested_by_id,
            "attested_at": event.attested_at.isoformat() if event.attested_at else None,
            "attestation_note": event.attestation_note,
            "withdrawal_reason": event.withdrawal_reason,
            "warning": "NO_EXTERNAL_TRANSFER_TRANSMISSION_PERFORMED",
        }

    def request(self, actor: Actor, prescription_id: str, destination_name: str,
                destination_phone: str, reason: str, request_key: str) -> str:
        pharmacy = required_text(destination_name, "Receiving pharmacy", 180)
        phone = required_text(destination_phone, "Receiving pharmacy telephone", 60)
        note = required_text(reason, "Transfer request reason", 1000)
        key = required_text(request_key, "Transfer request key", 120)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            rx = s.scalar(select(Prescription).where(
                Prescription.id == prescription_id,
                Prescription.site_id == actor.site_id).with_for_update())
            if rx is None:
                raise WorkflowError("Prescription not found at pharmacy site")
            old = s.scalar(select(TransferOut).where(
                TransferOut.site_id == actor.site_id, TransferOut.request_key == key))
            if old is not None:
                if (old.prescription_id, old.destination_name,
                        old.destination_phone, old.request_reason) != (
                        rx.id, pharmacy, phone, note):
                    raise WorkflowError("Transfer request key reused for different request")
                return old.id
            if s.scalar(select(TransferOut.id).where(TransferOut.prescription_id == rx.id)):
                raise WorkflowError("A transfer request or history already exists for this prescription")
            _available_for_handoff(s, rx)
            event = TransferOut(site_id=actor.site_id, prescription_id=rx.id,
                request_key=key, destination_name=pharmacy, destination_phone=phone,
                request_reason=note, requested_by_id=actor.id, status="REQUESTED")
            s.add(event)
            s.flush()
            self.service._audit(s, actor, "RX_TRANSFER_OUT_REQUESTED", event.id, {
                "prescription_id": rx.id, "receiving_pharmacy": pharmacy,
                "request_key": key, "external_transmission": False,
            })
            return event.id

    def attest_out(self, actor: Actor, transfer_id: str, *,
                   receiving_pharmacist: str, handoff_reference: str,
                   note: str, personally_confirmed: bool) -> None:
        receiver = required_text(receiving_pharmacist, "Receiving pharmacist", 150)
        reference = required_text(handoff_reference, "Independent handoff reference", 150)
        description = required_text(note, "Pharmacist attestation note", 2000)
        if personally_confirmed is not True:
            raise WorkflowError("Explicit pharmacist attestation is required")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "verify")
            transfer = s.scalar(select(TransferOut).where(
                TransferOut.id == transfer_id,
                TransferOut.site_id == actor.site_id).with_for_update())
            if transfer is None:
                raise WorkflowError("Outgoing transfer request not found at pharmacy site")
            if transfer.status != "REQUESTED":
                raise WorkflowError("Only a requested transfer can be attested")
            rx = s.scalar(select(Prescription).where(
                Prescription.id == transfer.prescription_id,
                Prescription.site_id == actor.site_id).with_for_update())
            if rx is None:
                raise WorkflowError("Source prescription missing at pharmacy site")
            _available_for_handoff(s, rx)
            rx.status = "TRANSFERRED"
            rx.held_from = None
            transfer.status = "ATTESTED_OUT"
            transfer.attested_by_id = actor.id
            transfer.attested_at = utcnow()
            transfer.receiving_pharmacist = receiver
            transfer.handoff_reference = reference
            transfer.attestation_note = description
            self.service._audit(s, actor, "RX_TRANSFER_OUT_ATTESTED_SYNTHETIC", transfer.id, {
                "prescription_id": rx.id, "receiving_pharmacy": transfer.destination_name,
                "receiving_pharmacist": receiver, "handoff_reference": reference,
                "note": description, "external_transmission": False,
            })

    def withdraw(self, actor: Actor, transfer_id: str, reason: str) -> None:
        note = required_text(reason, "Transfer withdrawal reason", 1000)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            transfer = s.scalar(select(TransferOut).where(
                TransferOut.id == transfer_id,
                TransferOut.site_id == actor.site_id).with_for_update())
            if transfer is None:
                raise WorkflowError("Outgoing transfer request not found at pharmacy site")
            if transfer.status != "REQUESTED":
                raise WorkflowError("Only an unconfirmed transfer request may be withdrawn")
            transfer.status = "WITHDRAWN"
            transfer.withdrawn_by_id = actor.id
            transfer.withdrawn_at = utcnow()
            transfer.withdrawal_reason = note
            self.service._audit(s, actor, "RX_TRANSFER_OUT_WITHDRAWN", transfer.id, {
                "prescription_id": transfer.prescription_id, "reason": note,
            })

    def get(self, actor: Actor, transfer_id: str) -> dict[str, Any]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            row = s.scalar(select(TransferOut).where(
                TransferOut.id == transfer_id, TransferOut.site_id == actor.site_id))
            if row is None:
                raise WorkflowError("Outgoing transfer not found at pharmacy site")
            return self._view(row)

    def list(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            events = s.scalars(select(TransferOut).where(
                TransferOut.site_id == actor.site_id).order_by(
                TransferOut.requested_at.desc(), TransferOut.id)).all()
            return [self._view(e) for e in events]
