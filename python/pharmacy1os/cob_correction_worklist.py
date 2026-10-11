"""Site-scoped *candidate* list for local synthetic COB corrections.

The list is a discovery surface only, NEVER a statement that a payer approved
a claim or a fill is eligible for correction. CobCorrectionPlanner.plan and
SyntheticCobCorrectionService.correct independently verify full provenance.
"""
from __future__ import annotations

from sqlalchemy import func, select

from .models import Claim, Fill, Patient, Prescription
from .service import Actor, PharmacyService, WorkflowError


class CobCorrectionWorklist:
    def __init__(self, service: PharmacyService):
        self.service = service

    def page(self, actor: Actor, *, limit: int = 25, offset: int = 0,
             rx_query: str = "") -> dict:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
            raise WorkflowError("COB worklist limit must be 1-50")
        if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 10000:
            raise WorkflowError("COB worklist offset must be 0-10000")
        if not isinstance(rx_query, str) or len(rx_query.strip()) > 60:
            raise WorkflowError("COB worklist Rx query is too long")
        query = rx_query.strip()
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            all_claims = (select(func.count(Claim.id))
                          .where(Claim.fill_id == Fill.id)
                          .correlate(Fill).scalar_subquery())
            paid_claims = (select(func.count(Claim.id))
                           .where(Claim.fill_id == Fill.id,
                                  Claim.status == "PAID_SYNTHETIC")
                           .correlate(Fill).scalar_subquery())
            scope = [
                Prescription.site_id == actor.site_id,
                Patient.site_id == actor.site_id,
                Fill.status == "PHARMACIST_REVIEW",
                Prescription.status == "PHARMACIST_REVIEW",
                all_claims.between(2, 4),
                paid_claims == all_claims,
            ]
            if query:
                scope.append(Prescription.rx_number.ilike(f"%{query}%"))
            rows = s.execute(
                select(Fill, Prescription, Patient, all_claims.label("payer_count"))
                .join(Prescription, Fill.prescription_id == Prescription.id)
                .join(Patient, Prescription.patient_id == Patient.id)
                .where(*scope)
                .order_by(Prescription.rx_number.asc(), Fill.fill_number.desc(),
                          Fill.attempt.desc(), Fill.id.asc())
                .offset(offset).limit(limit + 1)
            ).all()
            visible = rows[:limit]
            return {
                "limit": limit, "offset": offset,
                "next_offset": offset + limit if len(rows) > limit else None,
                "items": [{
                    "fill_id": fill.id,
                    "rx_number": rx.rx_number,
                    "patient_id": patient.id,
                    "patient_name": f"{patient.last_name}, {patient.first_name}",
                    "fill_number": fill.fill_number,
                    "attempt": fill.attempt,
                    "payer_count": count,
                    "physical_quantity": str(fill.quantity),
                    "payer_intended_quantity": str(fill.billed_quantity),
                    "candidate_only": True,
                } for fill, rx, patient, count in visible],
                "warning": (
                    "CANDIDATES_ONLY_NOT_CORRECTION_ELIGIBILITY; revalidate "
                    "the full COB ledger, physical scans, queued labels and "
                    "current paid transactions immediately before any test mutation"
                ),
            }
