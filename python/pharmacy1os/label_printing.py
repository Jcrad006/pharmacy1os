"""Synthetic native-desktop printing queue and immutable bottle-label snapshots.

Jobs are created after each synthetic fill's bottle labels. No network printer
driver is configured by the backend. Reprints are separately audited, and
every rendered page is watermarked against use for real dispensing.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, UniqueConstraint, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .models import Base, Drug, Fill, Label, Patient, Prescription, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError

SYNTHETIC_MARK = "SYNTHETIC TEST LABEL - NOT FOR PATIENT USE"


class LabelPrintJob(Base):
    __tablename__ = "py_label_print_jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, index=True)
    label_id: Mapped[str] = mapped_column(ForeignKey("py_labels.id"), nullable=False, unique=True)
    bottle_number: Mapped[int] = mapped_column(nullable=False)
    snapshot_json: Mapped[str] = mapped_column(Text, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="QUEUED")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    void_reason: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("fill_id", "bottle_number", name="uq_py_label_print_bottle"),
        CheckConstraint("status IN ('QUEUED', 'VOIDED')", name="ck_py_print_job_status"),
        CheckConstraint("bottle_number > 0", name="ck_py_print_job_bottle"),
    )


class LabelPrintEvent(Base):
    __tablename__ = "py_label_print_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    print_job_id: Mapped[str] = mapped_column(ForeignKey("py_label_print_jobs.id"), nullable=False, index=True)
    request_key: Mapped[str] = mapped_column(String(120), nullable=False)
    event_kind: Mapped[str] = mapped_column(String(35), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("site_id", "request_key", name="uq_py_print_event_request_key"),
        CheckConstraint("event_kind IN ('NATIVE_DIALOG_ACCEPTED', 'TEST_REPRINT_REQUESTED')",
                        name="ck_py_print_event_kind"),
    )


def _hash(snapshot: str) -> str:
    return hashlib.sha256(snapshot.encode("utf-8")).hexdigest()


def enqueue_label_jobs(s: Session, actor: Actor, fill: Fill) -> None:
    """Runs within the same transaction as label creation; never auto-prints."""
    rx = s.get(Prescription, fill.prescription_id)
    if rx is None or rx.site_id != actor.site_id:
        raise WorkflowError("Cannot queue labels for a different pharmacy")
    person = s.get(Patient, rx.patient_id)
    drug = s.get(Drug, rx.drug_id)
    if person is None or person.site_id != actor.site_id or drug is None:
        raise WorkflowError("Patient or drug missing for label snapshot")
    s.flush()
    labels = s.scalars(select(Label).where(
        Label.fill_id == fill.id).order_by(Label.bottle_number)).all()
    if not labels:
        raise WorkflowError("No bottles to queue for printing")
    for label in labels:
        snap = {
            "banner": SYNTHETIC_MARK,
            "rx_number": rx.rx_number,
            "patient": f"{person.last_name}, {person.first_name}",
            "drug": f"{drug.name} {drug.strength}",
            "sig": rx.sig,
            "ndc": label.ndc,
            "manufacturer_description": label.description,
            "physical_bottle_quantity": str(label.quantity),
            "physical_total_quantity": str(label.total),
            "bottle_number": label.bottle_number,
            "bottle_count": label.bottle_count,
        }
        canonical = json.dumps(snap, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
        s.add(LabelPrintJob(site_id=actor.site_id, fill_id=fill.id, label_id=label.id,
                bottle_number=label.bottle_number, snapshot_json=canonical,
                sha256=_hash(canonical), created_by_id=actor.id,
                status="QUEUED"))
    PharmacyService._audit(s, actor, "SYNTHETIC_BOTTLE_JOBS_QUEUED", fill.id, {
        "bottle_count": len(labels), "auto_printed": False,
    })


def void_label_jobs(s: Session, actor: Actor, fill_id: str, reason: str) -> None:
    jobs = s.scalars(select(LabelPrintJob).where(
        LabelPrintJob.fill_id == fill_id,
        LabelPrintJob.site_id == actor.site_id,
        LabelPrintJob.status == "QUEUED")).all()
    for job in jobs:
        job.status = "VOIDED"
        job.void_reason = reason.strip()[:1000]
    if jobs:
        PharmacyService._audit(s, actor, "SYNTHETIC_LABEL_JOBS_VOIDED",
                                fill_id, {"count": len(jobs), "reason": reason.strip()[:1000]})


def _as_text(job: LabelPrintJob) -> str:
    if _hash(job.snapshot_json) != job.sha256:
        raise WorkflowError("Printed label snapshot checksum mismatch")
    payload = json.loads(job.snapshot_json)
    if payload.get("banner") != SYNTHETIC_MARK:
        raise WorkflowError("Missing mandatory synthetic label watermark")
    return "\n".join([
        "=" * 42, SYNTHETIC_MARK, "=" * 42,
        f"RX: {payload['rx_number']}",
        f"PATIENT: {payload['patient']}",
        f"DRUG: {payload['drug']}",
        f"INSTRUCTIONS: {payload['sig']}",
        f"NDC: {payload['ndc']}",
        f"PRODUCT: {payload['manufacturer_description']}",
        f"QUANTITY: {payload['physical_bottle_quantity']} / {payload['physical_total_quantity']}",
        f"BOTTLE {payload['bottle_number']} OF {payload['bottle_count']}",
        "=" * 42, SYNTHETIC_MARK,
    ])


class LabelPrintService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def list(self, actor: Actor, fill_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "process")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Physical fill not found")
            self.service._site(s, Prescription, fill.prescription_id, actor)
            jobs = s.scalars(select(LabelPrintJob).where(
                LabelPrintJob.fill_id == fill.id, LabelPrintJob.site_id == actor.site_id
                ).order_by(LabelPrintJob.bottle_number)).all()
            return [{
                "id": j.id, "fill_id": j.fill_id, "bottle_number": j.bottle_number,
                "status": j.status, "sha256": j.sha256,
                "watermark": SYNTHETIC_MARK,
            } for j in jobs]

    def preview(self, actor: Actor, job_id: str) -> str:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "process")
            job = s.scalar(select(LabelPrintJob).where(
                LabelPrintJob.id == job_id, LabelPrintJob.site_id == actor.site_id))
            if job is None:
                raise WorkflowError("Print job not found at pharmacy site")
            if job.status != "QUEUED":
                raise WorkflowError("Voided print job cannot be printed")
            return _as_text(job)

    def record_output_attempt(self, actor: Actor, job_id: str, request_key: str,
                              reason: str, *, dialog_accepted: bool = False) -> str:
        """Records an explicit OS spool *request*, not proof of hardware success."""
        key = request_key.strip() if isinstance(request_key, str) else ""
        note = reason.strip() if isinstance(reason, str) else ""
        if not key or len(key) > 120 or not note or len(note) > 1000:
            raise WorkflowError("Stable request key and documented reason required")
        kind = "NATIVE_DIALOG_ACCEPTED" if dialog_accepted is True else "TEST_REPRINT_REQUESTED"
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "verify")
            previous = s.scalar(select(LabelPrintEvent).where(
                LabelPrintEvent.site_id == actor.site_id,
                LabelPrintEvent.request_key == key).with_for_update())
            if previous is not None:
                if (previous.print_job_id, previous.event_kind, previous.note) != (job_id, kind, note):
                    raise WorkflowError("Print event request key reused for a different operation")
                return previous.id
            job = s.scalar(select(LabelPrintJob).where(
                LabelPrintJob.id == job_id, LabelPrintJob.site_id == actor.site_id).with_for_update())
            if job is None or job.status != "QUEUED":
                raise WorkflowError("Active print job not found at pharmacy site")
            _as_text(job)
            attempt = LabelPrintEvent(site_id=actor.site_id, print_job_id=job.id,
                request_key=key, event_kind=kind, note=note, actor_id=actor.id)
            s.add(attempt)
            s.flush()
            self.service._audit(s, actor, "SYNTHETIC_LABEL_OUTPUT_ATTEMPT", job.id, {
                "event_id": attempt.id, "kind": kind, "reason": note,
                "hardware_print_success_verified": False,
            })
            return attempt.id
