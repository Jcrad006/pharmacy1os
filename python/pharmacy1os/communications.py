"""Synthetic communication/document custody worklist; never sends a fax or an eRx.

Inbound documents are *quarantined until pharmacist review* and do not create a
prescription; outbound items are manual work orders, not evidence of delivery.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, Document, Prescription, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError
from .documents import DocumentService


class CommunicationTask(Base):
    __tablename__ = "py_communication_tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), nullable=False, index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("py_documents.id"), nullable=False)
    document_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    direction: Mapped[str] = mapped_column(String(10), nullable=False)
    channel: Mapped[str] = mapped_column(String(12), nullable=False)
    destination: Mapped[str] = mapped_column(String(180), nullable=False)
    summary: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    request_key: Mapped[str] = mapped_column(String(100), nullable=False)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    approved_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("site_id", "request_key", name="uq_py_communication_request"),
        CheckConstraint("direction IN ('INBOUND','OUTBOUND')", name="ck_py_communication_direction"),
        CheckConstraint("channel IN ('FAX','ERX','PHONE')", name="ck_py_communication_channel"),
        CheckConstraint("status IN ('QUARANTINED','REVIEWED','DRAFT','APPROVED','ACTIVITY_RECORDED','CANCELLED')",
                        name="ck_py_communication_status"),
        Index("ix_py_communication_site_status", "site_id", "status"),
    )


class CommunicationEvent(Base):
    __tablename__ = "py_communication_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("py_communication_tasks.id"), nullable=False, index=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    request_key: Mapped[str] = mapped_column(String(100), nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("task_id", "sequence", name="uq_py_communication_event_sequence"),
        UniqueConstraint("task_id", "request_key", name="uq_py_communication_event_request"),
        CheckConstraint("sequence >= 1", name="ck_py_communication_sequence"),
        CheckConstraint("action IN ('CREATED','APPROVED','REVIEWED','ATTEMPT_RECORDED','CANCELLED')",
                        name="ck_py_communication_action"),
    )


def _required(value: str, label: str, max_length: int) -> str:
    v = value.strip() if isinstance(value, str) else ""
    if not v or len(v) > max_length:
        raise WorkflowError(f"{label} must contain 1–{max_length} characters")
    return v


class CommunicationService:
    def __init__(self, service: PharmacyService, documents: DocumentService | None = None):
        self.service = service
        self.documents = documents or DocumentService.from_demo_env(service)

    @staticmethod
    def _dict(task: CommunicationTask) -> dict[str, Any]:
        return {"id": task.id, "prescription_id": task.prescription_id,
                "document_id": task.document_id, "document_sha256": task.document_sha256,
                "direction": task.direction, "channel": task.channel,
                "destination": task.destination, "summary": task.summary,
                "status": task.status, "request_key": task.request_key,
                "created_at": task.created_at.isoformat() if task.created_at else None}

    def _intact(self, actor: Actor, task: CommunicationTask) -> None:
        """Validate actual immutable source bytes, not only a metadata record."""
        import hashlib
        content, _ = self.documents.read_source(actor, task.document_id)
        if hashlib.sha256(content).hexdigest() != task.document_sha256:
            raise WorkflowError("Communication source changed; manual integrity review required")

    def _event(self, s, actor: Actor, task: CommunicationTask,
               action: str, note: str, key: str) -> str:
        latest = s.scalars(select(CommunicationEvent).where(
            CommunicationEvent.task_id == task.id).order_by(CommunicationEvent.sequence.desc())).first()
        event = CommunicationEvent(site_id=actor.site_id, task_id=task.id,
                                   sequence=(latest.sequence + 1 if latest else 1),
                                   action=action, note=note, request_key=key, actor_id=actor.id)
        s.add(event)
        s.flush()
        task.updated_at = utcnow()
        self.service._audit(s, actor, "COMMUNICATION_" + action, task.id,
                            {"event_id": event.id, "channel": task.channel,
                             "document_id": task.document_id,
                             "note": note[:500]})
        return event.id

    def create(self, actor: Actor, rx_id: str, document_id: str, direction: str,
               channel: str, destination: str, summary: str, request_key: str) -> str:
        direction = _required(direction, "Direction", 10).upper()
        channel = _required(channel, "Channel", 12).upper()
        destination = _required(destination, "Office/remote party", 180)
        summary = _required(summary, "Communication purpose", 500)
        key = _required(request_key, "Idempotency key", 100)
        if direction not in {"INBOUND", "OUTBOUND"} or channel not in {"FAX", "ERX", "PHONE"}:
            raise WorkflowError("Unsupported communication direction or channel")
        if direction == "OUTBOUND" and channel == "ERX":
            raise WorkflowError("Outbound eRx transmission is not implemented or authorized")
        # Verify source integrity before creating a linked task. This is not a transport intake.
        self.documents.read_source(actor, document_id)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "entry")
            self.service._site(s, Prescription, rx_id, actor)
            doc = self.service._site(s, Document, document_id, actor)
            if doc.prescription_id != rx_id:
                raise WorkflowError("Immutable source document belongs to another prescription")
            existing = s.scalar(select(CommunicationTask).where(
                CommunicationTask.site_id == actor.site_id,
                CommunicationTask.request_key == key).with_for_update())
            if existing:
                if (existing.prescription_id, existing.document_id, existing.direction,
                    existing.channel, existing.destination, existing.summary) != (
                    rx_id, document_id, direction, channel, destination, summary):
                    raise WorkflowError("Communication request key reused with different details")
                return existing.id
            task = CommunicationTask(site_id=actor.site_id, prescription_id=rx_id,
                                     document_id=doc.id, document_sha256=doc.sha256,
                                     direction=direction, channel=channel,
                                     destination=destination, summary=summary,
                                     status="QUARANTINED" if direction == "INBOUND" else "DRAFT",
                                     request_key=key, created_by_id=actor.id)
            s.add(task); s.flush()
            self._event(s, actor, task, "CREATED",
                        "Synthetic metadata only; no fax/eRx transmission or prescription import", "CREATE:" + key)
            return task.id

    def list(self, actor: Actor, *, status: str | None = None) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            statement = select(CommunicationTask).where(CommunicationTask.site_id == actor.site_id)
            if status:
                statement = statement.where(CommunicationTask.status == status)
            rows = s.scalars(statement.order_by(CommunicationTask.created_at, CommunicationTask.id)).all()
            return [self._dict(x) for x in rows]

    def history(self, actor: Actor, task_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            self.service._site(s, CommunicationTask, task_id, actor)
            events = s.scalars(select(CommunicationEvent).where(
                CommunicationEvent.task_id == task_id).order_by(CommunicationEvent.sequence)).all()
            return [{"id": x.id, "sequence": x.sequence, "action": x.action,
                     "note": x.note, "request_key": x.request_key,
                     "actor_id": x.actor_id, "at": x.created_at.isoformat()}
                    for x in events]

    def change(self, actor: Actor, task_id: str, action: str, note: str,
               request_key: str) -> str:
        action = _required(action, "Action", 30).upper()
        note = _required(note, "Supporting note", 2000)
        key = _required(request_key, "Event idempotency key", 100)
        if action not in {"APPROVED", "REVIEWED", "ATTEMPT_RECORDED", "CANCELLED"}:
            raise WorkflowError("Unsupported communication transition")
        with self.service.sessions.begin() as s:
            permission = "clinical" if action in {"APPROVED", "REVIEWED", "CANCELLED"} else "process"
            self.service._authorized(s, actor, permission)
            task = s.scalar(select(CommunicationTask).where(
                CommunicationTask.id == task_id,
                CommunicationTask.site_id == actor.site_id).with_for_update())
            if task is None:
                raise WorkflowError("Communication task not found at pharmacy site")
            previous = s.scalar(select(CommunicationEvent).where(
                CommunicationEvent.task_id == task_id,
                CommunicationEvent.request_key == key))
            if previous:
                if previous.action != action or previous.note != note:
                    raise WorkflowError("Communication event key reused for different content")
                return previous.id
            if action == "APPROVED":
                if task.direction != "OUTBOUND" or task.status != "DRAFT":
                    raise WorkflowError("Only an outbound draft can be approved")
                self._intact(actor, task)
                task.approved_by_id = actor.id
                task.status = "APPROVED"
            elif action == "REVIEWED":
                if task.direction != "INBOUND" or task.status != "QUARANTINED":
                    raise WorkflowError("Only a quarantined inbound record can be reviewed")
                self._intact(actor, task)
                task.approved_by_id = actor.id
                task.status = "REVIEWED"
            elif action == "ATTEMPT_RECORDED":
                if task.direction != "OUTBOUND" or task.status not in {"APPROVED", "ACTIVITY_RECORDED"}:
                    raise WorkflowError("Manual activity requires approved outbound communication")
                if task.channel not in {"FAX", "PHONE"}:
                    raise WorkflowError("This channel has no manual communication workflow")
                self._intact(actor, task)
                task.status = "ACTIVITY_RECORDED"
            else:  # CANCELLED
                if task.direction != "OUTBOUND" or task.status not in {"DRAFT", "APPROVED", "ACTIVITY_RECORDED"}:
                    raise WorkflowError("Only a non-cancelled outbound task can be cancelled")
                task.status = "CANCELLED"
            return self._event(s, actor, task, action, note, key)
