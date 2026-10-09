"""Immutable synthetic intervention notes and a combined prescription clinical record.

Mirrors the original TypeScript InterventionNote concept without pretending that
a free-text note changes the Rx, satisfies DUR, or proves prescriber consent.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, Index, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, DUR, Prescription, Staff, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError


class InterventionNote(Base):
    __tablename__ = "py_intervention_notes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(
        ForeignKey("py_prescriptions.id"), nullable=False, index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("length(trim(note)) BETWEEN 1 AND 4000",
                        name="ck_py_intervention_note_length"),
        Index("ix_py_intervention_rx_time", "prescription_id", "created_at"),
    )


class ClinicalRecordService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def record_intervention(self, actor: Actor, prescription_id: str,
                            note: str) -> dict[str, Any]:
        clean = note.strip() if isinstance(note, str) else ""
        if not 1 <= len(clean) <= 4000:
            raise WorkflowError("Intervention note must contain 1–4000 characters")
        with self.service.sessions.begin() as s:
            # Intervention authors must hold a current pharmacist-level
            # clinical permission, never merely a dispensing/process permission.
            self.service._authorized(s, actor, "clinical")
            rx = self.service._site(s, Prescription, prescription_id, actor)
            author = self.service._authorized(s, actor, "clinical")
            intervention = InterventionNote(
                site_id=actor.site_id, prescription_id=rx.id,
                author_id=author.id, note=clean)
            s.add(intervention)
            s.flush()
            # Audit stores identifiers only; free-text clinical content belongs
            # in the protected intervention record, not a second audit field.
            self.service._audit(s, actor, "PHARMACIST_INTERVENTION_RECORDED",
                intervention.id, {"prescription_id": rx.id, "author_id": author.id})
            return {
                "id": intervention.id, "prescription_id": rx.id,
                "author_id": author.id,
                "author": {"display_name": author.name, "role": author.role},
                "note": intervention.note,
                "created_at": intervention.created_at.isoformat(),
            }

    def create_issue(self, actor: Actor, prescription_id: str, code: str,
                     title: str, description: str | None = None,
                     severity: str = "WARNING") -> dict[str, Any]:
        if severity not in {"INFO", "WARNING", "HIGH"}:
            raise WorkflowError("Original-style DUR severity must be INFO, WARNING or HIGH")
        issue_id = self.service.add_dur_issue(actor, prescription_id,
            severity, code, title=title, description=description)
        return self.issue(actor, issue_id)

    def resolve_issue(self, actor: Actor, issue_id: str, note: str) -> dict[str, Any]:
        self.service.resolve_dur(actor, issue_id, note)
        return self.issue(actor, issue_id)

    def issue(self, actor: Actor, issue_id: str) -> dict[str, Any]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            issue = s.get(DUR, issue_id)
            if issue is None:
                raise WorkflowError("DUR issue not found")
            self.service._site(s, Prescription, issue.prescription_id, actor)
            reviewer = s.get(Staff, issue.resolved_by_id) if issue.resolved_by_id else None
            if reviewer is not None and reviewer.site_id != actor.site_id:
                raise WorkflowError("DUR resolution actor is inconsistent")
            return {
                "id": issue.id, "prescription_id": issue.prescription_id,
                "code": issue.code, "title": issue.title or issue.code,
                "description": issue.description, "severity": issue.severity,
                "source": issue.source,
                "status": "RESOLVED" if issue.resolved else "OPEN",
                "created_at": issue.created_at.isoformat() if issue.created_at else None,
                "resolved_at": issue.resolved_at.isoformat() if issue.resolved_at else None,
                "resolution_note": issue.resolution,
                "resolved_automatically": issue.resolved_automatically,
                "resolved_by_id": issue.resolved_by_id,
                "resolved_by": (
                    {"display_name": reviewer.name, "role": reviewer.role}
                    if reviewer is not None else None),
            }

    def clinical_record(self, actor: Actor, prescription_id: str) -> dict[str, Any]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rx = self.service._site(s, Prescription, prescription_id, actor)
            issues = s.scalars(select(DUR).where(DUR.prescription_id == rx.id)
                .order_by(DUR.id)).all()
            notes = s.scalars(select(InterventionNote).where(
                InterventionNote.site_id == actor.site_id,
                InterventionNote.prescription_id == rx.id)
                .order_by(InterventionNote.created_at.desc(),
                          InterventionNote.id.desc())).all()
            result = []
            for item in notes:
                author = s.get(Staff, item.author_id)
                if author is None or author.site_id != actor.site_id:
                    raise WorkflowError("Clinical intervention author is inconsistent")
                result.append({
                    "id": item.id, "prescription_id": rx.id,
                    "author_id": item.author_id,
                    "author": {"display_name": author.name, "role": author.role},
                    "note": item.note, "created_at": item.created_at.isoformat(),
                })
            return {
                "prescription_id": rx.id,
                "issues": [{
                    "id": issue.id, "prescription_id": rx.id,
                    "code": issue.code, "title": issue.title or issue.code,
                    "description": issue.description,
                    "severity": issue.severity, "source": issue.source,
                    "status": "RESOLVED" if issue.resolved else "OPEN",
                    "resolved": issue.resolved, "resolution_note": issue.resolution,
                    "created_at": issue.created_at.isoformat() if issue.created_at else None,
                    "resolved_at": issue.resolved_at.isoformat() if issue.resolved_at else None,
                    "resolved_automatically": issue.resolved_automatically,
                    "resolved_by_id": issue.resolved_by_id,
                } for issue in issues],
                "interventions": result,
                "warning": "SYNTHETIC_CLINICAL_RECORD_NOT_LIVE_PHARMACY",
            }
