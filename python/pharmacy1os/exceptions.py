"""Read-only Python exception board across synthetic clinical and scheduling data.

The original program also has emergency follow-ups, biologic communications and
completion fills; these are intentionally not displayed until their data models
are ported. Do not interpret a short exception list as proof of clinical safety.
"""
from __future__ import annotations
from datetime import datetime
from typing import Any
from sqlalchemy import select
from .models import DUR, Drug, Patient, Prescription
from .scheduling_models import ScheduledFill
from .service import Actor, PharmacyService, WorkflowError

KINDS = {"CLINICAL_ISSUE", "ON_HOLD", "PHARMACIST_REVIEW", "SCHEDULED_FILL"}
SEVERITY = {"HIGH": 3, "WARNING": 2, "INFO": 1}


class ExceptionService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def list(self, actor: Actor, *, kind: str | None = None,
             query: str = "", limit: int = 200) -> list[dict[str, Any]]:
        if kind and kind not in KINDS:
            raise WorkflowError("Unknown or not-yet-supported exception category")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 300:
            raise WorkflowError("Exception result limit must be 1 to 300")
        search = query.strip().casefold()
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            prescriptions = s.scalars(select(Prescription).where(
                Prescription.site_id == actor.site_id)).all()
            by_id = {rx.id:rx for rx in prescriptions}
            patient_names = {}
            drug_names = {}
            for rx in prescriptions:
                patient = s.get(Patient, rx.patient_id)
                drug = s.get(Drug, rx.drug_id)
                patient_names[rx.id] = (f"{patient.last_name}, {patient.first_name}" if patient else "Unknown")
                drug_names[rx.id] = (f"{drug.name} {drug.strength}" if drug else "Unknown")
            results = []
            def add(kind_name: str, event_id: str, rx: Prescription,
                    title: str, detail: str, severity: str, due: str | None = None):
                if kind and kind_name != kind:
                    return
                patient = patient_names[rx.id]
                drug = drug_names[rx.id]
                if search not in f"{kind_name} {rx.rx_number} {patient} {drug} {title} {detail}".casefold():
                    return
                results.append({"id":f"{kind_name.lower()}:{event_id}", "kind":kind_name,
                                "prescription_id":rx.id, "rx_number":rx.rx_number,
                                "patient_name":patient, "medication_name":drug,
                                "title":title, "detail":detail,
                                "severity":severity, "due_at":due})
            if not kind or kind == "CLINICAL_ISSUE":
                issues=s.scalars(select(DUR).join(Prescription, DUR.prescription_id == Prescription.id).where(
                    Prescription.site_id == actor.site_id, DUR.resolved.is_(False))).all()
                for issue in issues:
                    rx=by_id.get(issue.prescription_id)
                    if rx:
                        severity = issue.severity if issue.severity in SEVERITY else "WARNING"
                        add("CLINICAL_ISSUE", issue.id,rx,
                            "Unresolved DUR: "+issue.code, "Requires documented clinician review", severity)
            for rx in prescriptions:
                if rx.status == "ON_HOLD":
                    add("ON_HOLD",rx.id,rx,"Prescription on hold",
                        "Previous status: "+(rx.held_from or "unknown"),"WARNING")
                elif rx.status == "PHARMACIST_REVIEW":
                    add("PHARMACIST_REVIEW",rx.id,rx,"Pharmacist final verification",
                        "Verified clinical and physical assessment required","HIGH")
            if not kind or kind == "SCHEDULED_FILL":
                pending=s.scalars(select(ScheduledFill).where(
                    ScheduledFill.site_id == actor.site_id,
                    ScheduledFill.status == "PENDING")).all()
                for item in pending:
                    rx=by_id.get(item.prescription_id)
                    if rx:
                        add("SCHEDULED_FILL",item.id,rx,"Future fill pending",
                            "Scheduled for "+item.due_date,"INFO",item.due_date)
            results.sort(key=lambda x:(-SEVERITY.get(x["severity"],0),x["due_at"] or "9999-12-31",x["id"]))
            return results[:limit]
