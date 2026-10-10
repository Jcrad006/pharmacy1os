"""Read-only, privacy-minimized synthetic Third Party workbench projection.

Source parity: the original Fastify GET /third-party/workspace combines patient
coverages, site payers, recent claim issues and pending label jobs. This Python
projection never infers a genuine insurer rejection, adjudication or payment.
"""
from __future__ import annotations

from sqlalchemy import or_, select

from .claim_rebilling import SyntheticRebillLink
from .claim_transactions_models import SandboxClaimTransaction
from .insurance import _mask
from .insurance_models import InsurancePayer, PatientCoverage
from .label_printing import LabelPrintJob
from .models import Claim, Fill, Patient, Prescription
from .service import Actor, PharmacyService, WorkflowError


class ThirdPartyWorkspace:
    def __init__(self, service: PharmacyService):
        self.service = service

    def snapshot(self, actor: Actor, *, query: str = "") -> dict:
        term = query.strip() if isinstance(query, str) else None
        if term is None or len(term) > 100:
            raise WorkflowError("Third Party patient search must be at most 100 characters")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")

            patient_stmt = select(Patient).where(Patient.site_id == actor.site_id)
            if term:
                pattern = f"%{term.lower()}%"
                patient_stmt = patient_stmt.where(or_(
                    Patient.first_name.ilike(pattern),
                    Patient.last_name.ilike(pattern),
                    Patient.phone.ilike(pattern),
                ))
            patients = s.scalars(patient_stmt.order_by(
                Patient.last_name, Patient.first_name, Patient.id).limit(100)).all()
            payers = s.scalars(select(InsurancePayer).where(
                InsurancePayer.site_id == actor.site_id).order_by(
                InsurancePayer.active.desc(), InsurancePayer.name).limit(200)).all()
            payer_by_id = {p.id: p for p in payers}
            coverage_rows = s.scalars(select(PatientCoverage).where(
                PatientCoverage.site_id == actor.site_id,
                PatientCoverage.patient_id.in_([p.id for p in patients]))
                .order_by(PatientCoverage.patient_id, PatientCoverage.position)).all() if patients else []
            by_patient: dict[str, list] = {p.id: [] for p in patients}
            for cov in coverage_rows:
                payer = payer_by_id.get(cov.payer_id)
                if payer is None:
                    # Do not leak cross-site payer data via a broken coverage FK.
                    continue
                by_patient[cov.patient_id].append({
                    "id": cov.id, "payer_id": payer.id, "payer_name": payer.name,
                    "position": cov.position, "active": cov.active,
                    "payer_active": payer.active, "member_id_masked": _mask(cov.member_id),
                    "relationship": cov.relationship,
                })

            transactions = s.execute(select(
                SandboxClaimTransaction, Fill, Prescription, Patient
            ).join(Fill, SandboxClaimTransaction.fill_id == Fill.id)
             .join(Prescription, Fill.prescription_id == Prescription.id)
             .join(Patient, Prescription.patient_id == Patient.id)
             .where(SandboxClaimTransaction.site_id == actor.site_id,
                    Prescription.site_id == actor.site_id,
                    Patient.site_id == actor.site_id)
             .order_by(SandboxClaimTransaction.recorded_at.desc(),
                       SandboxClaimTransaction.id.desc()).limit(300)).all()
            reversed_ids = {tx.original_transaction_id for tx, _, _, _ in transactions
                            if tx.operation == "REVERSE"
                            and tx.outcome == "REVERSED_SYNTHETIC"
                            and tx.original_transaction_id is not None}
            cleared_ids = {tx.original_transaction_id for tx, _, _, _ in transactions
                           if tx.operation == "TEST_RESOLVE" and tx.original_transaction_id}
            recent = []
            issues = []
            for tx, fill, rx, patient in transactions:
                if tx.operation == "BILL":
                    status = ("REVERSED_SYNTHETIC" if tx.id in reversed_ids
                              else "PAID_SYNTHETIC_LOCAL_ONLY")
                elif tx.operation == "TEST_REJECT":
                    status = ("CLEARED_TEST_HOLD" if tx.id in cleared_ids
                              else "OPEN_TEST_REJECTION")
                else:
                    status = tx.outcome
                summary = {
                    "id": tx.id, "fill_id": fill.id, "rx_number": rx.rx_number,
                    "patient_id": patient.id, "patient_name": f"{patient.last_name}, {patient.first_name}",
                    "claim_id": tx.claim_id, "operation": tx.operation,
                    "status": status,
                    "payer_id": tx.payer_id, "coverage_id": tx.coverage_id,
                    "original_transaction_id": tx.original_transaction_id,
                    "recorded_at": tx.recorded_at.isoformat(),
                }
                recent.append(summary)
                if tx.operation == "TEST_REJECT" and status == "OPEN_TEST_REJECTION":
                    issues.append({
                        **summary, "issue": "MANUALLY_INJECTED_TEST_HOLD",
                        "external_payer_rejection": False,
                    })

            print_rows = s.execute(select(LabelPrintJob, Fill, Prescription, Patient)
                .join(Fill, LabelPrintJob.fill_id == Fill.id)
                .join(Prescription, Fill.prescription_id == Prescription.id)
                .join(Patient, Prescription.patient_id == Patient.id)
                .where(LabelPrintJob.site_id == actor.site_id,
                       Prescription.site_id == actor.site_id,
                       Patient.site_id == actor.site_id,
                       LabelPrintJob.status == "QUEUED")
                .order_by(LabelPrintJob.created_at.asc(), LabelPrintJob.id.asc())
                .limit(100)).all()
            print_queue = [{
                "id": job.id, "fill_id": fill.id, "rx_number": rx.rx_number,
                "patient_name": f"{person.last_name}, {person.first_name}",
                "bottle_number": job.bottle_number, "status": job.status,
                "created_at": job.created_at.isoformat(),
                "synthetic_watermark_required": True,
            } for job, fill, rx, person in print_rows]

            pending_rows = s.execute(select(SyntheticRebillLink, Fill, Prescription)
                .join(Fill, SyntheticRebillLink.replacement_fill_id == Fill.id)
                .join(Prescription, Fill.prescription_id == Prescription.id)
                .where(SyntheticRebillLink.site_id == actor.site_id,
                       Prescription.site_id == actor.site_id,
                       Fill.status.in_(("PRODUCT_FILL", "PHARMACIST_REVIEW")))
                .order_by(SyntheticRebillLink.created_at.desc()).limit(100)).all()
            pending = [{
                "original_fill_id": link.original_fill_id,
                "replacement_fill_id": fill.id,
                "rx_number": rx.rx_number, "fill_status": fill.status,
                "requires_fresh_scans": fill.status == "PRODUCT_FILL",
                "note": "LOCAL_REPLACEMENT_ATTEMPT_NOT_EXTERNAL_REBILL",
            } for link, fill, rx in pending_rows]

            return {
                "patients": [{
                    "id": p.id, "first_name": p.first_name, "last_name": p.last_name,
                    "coverages": by_patient[p.id],
                } for p in patients],
                "payers": [{
                    "id": p.id, "name": p.name, "active": p.active,
                    "claim_standard": p.claim_standard,
                    "billing_ndc_strategy": p.billing_ndc_strategy,
                } for p in payers],
                "claimIssues": issues, "recentClaimEvents": recent,
                "printQueue": print_queue, "pendingRebills": pending,
                "maxCoveragePositions": 4,
                "limits": {"patients": 100, "payers": 200,
                           "claim_events": 300, "print_jobs": 100},
                "warning": "SYNTHETIC_ONLY_NO_EXTERNAL_CLAIMS_ELIGIBILITY_OR_PRINTER_CONFIRMATION",
            }
