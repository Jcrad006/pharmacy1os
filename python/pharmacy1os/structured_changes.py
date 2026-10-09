"""Synthetic, pharmacist-approved structured prescription changes.

Separate provenance is retained; never alter source image, label or prior fill.
The documented authorization is a human attestation, NOT verified prescriber consent.
"""
from __future__ import annotations

import json
from decimal import Decimal
from typing import Any
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import (Base, Document, DocumentAnnotation, DocumentChange, Drug, Fill,
                     Prescription, Prescriber, utcnow, uuid)
from .service import Actor, PharmacyService, WorkflowError, positive
from .scheduling_models import ScheduledFill
from .documents import DocumentService


class StructuredChangeApplication(Base):
    __tablename__ = "py_structured_change_applications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), nullable=False, index=True)
    change_record_id: Mapped[str] = mapped_column(ForeignKey("py_document_changes.id"), nullable=False, unique=True)
    document_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    applied_field: Mapped[str] = mapped_column(String(30), nullable=False)
    before_value: Mapped[str] = mapped_column(Text, nullable=False)
    after_value: Mapped[str] = mapped_column(Text, nullable=False)
    version_before: Mapped[int] = mapped_column(Integer, nullable=False)
    version_after: Mapped[int] = mapped_column(Integer, nullable=False)
    pharmacist_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    approval_note: Mapped[str] = mapped_column(Text, nullable=False)
    applied_at: Mapped[Any] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("version_after = version_before + 1", name="ck_py_change_version_increment"),
        UniqueConstraint("prescription_id", "version_after", name="uq_py_change_rx_version"),
    )


class StructuredChangeService:
    """Guarded editing of fields directly supported by the Python Rx schema.

    The TypeScript model supports additional fields which are *not* in Python's
    Prescription table; reject rather than mutate Drug catalog or fake parity.
    """
    FIELDS = {"SIG": "sig", "QUANTITY": "quantity", "REFILLS": "refills_allowed",
              "DRUG": "drug_id", "PRESCRIBER": "prescriber_id"}

    def __init__(self, service: PharmacyService, documents: DocumentService):
        self.service = service
        self.documents = documents

    @staticmethod
    def _encode(value: Any) -> str:
        return json.dumps(str(value) if isinstance(value, Decimal) else value, ensure_ascii=False)

    def history(self, actor: Actor, rx_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            self.service._site(s, Prescription, rx_id, actor)
            records = s.scalars(select(StructuredChangeApplication).where(
                StructuredChangeApplication.site_id == actor.site_id,
                StructuredChangeApplication.prescription_id == rx_id
            ).order_by(StructuredChangeApplication.version_after)).all()
            return [{"id": r.id, "change_record_id": r.change_record_id,
                     "field": r.applied_field, "before": json.loads(r.before_value),
                     "after": json.loads(r.after_value), "version_before": r.version_before,
                     "version_after": r.version_after, "pharmacist_id": r.pharmacist_id,
                     "approval_note": r.approval_note,
                     "applied_at": r.applied_at.isoformat()} for r in records]

    def apply(self, actor: Actor, change_record_id: str, value: Any,
              approval_note: str, *, expected_version: int) -> dict[str, Any]:
        """Apply one attested structured value and log before/after atomically.

        Caller must independently establish prescription change authority. Never
        infer an authorized change from a technician-authored annotation alone.
        """
        note = approval_note.strip() if isinstance(approval_note, str) else ""
        if not 8 <= len(note) <= 2000:
            raise WorkflowError("Pharmacist approval note must be 8–2000 characters")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise WorkflowError("A nonnegative expected prescription version is required")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "clinical")
            record = self.service._site(s, DocumentChange, change_record_id, actor)
            # Duplicate application always fails (including after supersession).
            if s.scalar(select(StructuredChangeApplication.id).where(
                StructuredChangeApplication.change_record_id == record.id)):
                raise WorkflowError("Structured change has already been applied")
            if record.status != "ACTIVE" or record.change_type not in self.FIELDS:
                raise WorkflowError("Only an active supported change can be applied")
            if not record.authorizing_prescriber or not record.authorizing_prescriber.strip():
                raise WorkflowError("Documented prescriber authorization is required")
            if not record.communication_method or not record.contacted_party:
                raise WorkflowError("Communication provenance and contacted party are required")
            annotation = self.service._site(s, DocumentAnnotation, record.annotation_id, actor)
            if annotation.status != "ACTIVE" or annotation.prescription_id != record.prescription_id:
                raise WorkflowError("Active annotation and change record must agree")
            document = self.service._site(s, Document, annotation.document_id, actor)
            if document.prescription_id != record.prescription_id:
                raise WorkflowError("Original document does not belong to prescription")
            rx = s.scalar(select(Prescription).where(
                Prescription.id == record.prescription_id,
                Prescription.site_id == actor.site_id).with_for_update())
            if rx is None or rx.version != expected_version:
                raise WorkflowError("Prescription was modified; refresh and retry review")
            if rx.status not in {"DATA_ENTRY", "DUR_REVIEW", "ON_HOLD"}:
                raise WorkflowError("Changes require an unfilled prescription at Data Entry or DUR")
            # A previous fill (even sold, cancelled or returned) must not be retroactively
            # reinterpreted by mutating the same prescription.
            if s.scalar(select(Fill.id).where(Fill.prescription_id == rx.id)):
                raise WorkflowError("Prescription already has fill history; new order or reviewed reversal required")
            if s.scalar(select(ScheduledFill.id).where(
                ScheduledFill.prescription_id == rx.id, ScheduledFill.status == "PENDING")):
                raise WorkflowError("Cancel pending schedules before modifying the prescription")
            # Verify immutable bytes and SHA before any medication mutation.
            self.documents.read_source(actor, document.id)
            field = self.FIELDS[record.change_type]
            previous = getattr(rx, field)
            if record.change_type == "SIG":
                candidate = value.strip() if isinstance(value, str) else ""
                if not 1 <= len(candidate) <= 4000:
                    raise WorkflowError("SIG must contain 1–4000 characters")
            elif record.change_type == "QUANTITY":
                candidate = positive(value)
            elif record.change_type == "REFILLS":
                if isinstance(value, bool):
                    raise WorkflowError("Refills must be a nonnegative whole number")
                try:
                    decimal_value = Decimal(str(value))
                except Exception as exc:
                    raise WorkflowError("Refills must be a nonnegative whole number") from exc
                if not decimal_value.is_finite() or decimal_value != decimal_value.to_integral_value() or not 0 <= decimal_value <= 999:
                    raise WorkflowError("Refills must be a nonnegative whole number (max 999)")
                candidate = int(decimal_value)
                if candidate < rx.refills_used:
                    raise WorkflowError("Refills cannot be below prior refills used")
            elif record.change_type == "DRUG":
                drug = s.get(Drug, value) if isinstance(value, str) else None
                if drug is None or drug.controlled:
                    raise WorkflowError("An existing noncontrolled catalog drug is required")
                candidate = drug.id
            else:
                prescriber = s.get(Prescriber, value) if isinstance(value, str) else None
                if prescriber is None or prescriber.site_id != actor.site_id:
                    raise WorkflowError("Prescriber must exist at this pharmacy")
                candidate = prescriber.id
            if previous == candidate:
                raise WorkflowError("Structured value is unchanged")
            original_status = rx.status
            setattr(rx, field, candidate)
            rx.version += 1
            if rx.status == "DUR_REVIEW":
                rx.status = "DATA_ENTRY"
            if rx.status == "ON_HOLD" and rx.held_from == "DUR_REVIEW":
                rx.held_from = "DATA_ENTRY"
            event = StructuredChangeApplication(
                site_id=actor.site_id, prescription_id=rx.id, change_record_id=record.id,
                document_sha256=document.sha256, applied_field=field,
                before_value=self._encode(previous), after_value=self._encode(candidate),
                version_before=expected_version, version_after=rx.version,
                pharmacist_id=actor.id, approval_note=note)
            s.add(event)
            s.flush()
            self.service._audit(s, actor, "STRUCTURED_RX_CHANGE_APPLIED", event.id,
                {"rx_id":rx.id,"record_id":record.id,"document_sha256":document.sha256,
                 "field":field,"before":json.loads(event.before_value),
                 "after":json.loads(event.after_value),"version":rx.version,
                 "prior_status":original_status,"new_status":rx.status})
            return {"id":event.id,"prescription_id":rx.id,"version":rx.version,
                    "field":field,"before":json.loads(event.before_value),
                    "after":json.loads(event.after_value),"status":rx.status}
