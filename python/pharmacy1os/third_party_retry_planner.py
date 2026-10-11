"""Read-only retry plan for a *complete* local synthetic Third Party case.

Never submits a claim, creates a label or modifies a fill. The mutating domain
services independently revalidate every fact while holding the fill row lock.
"""
from __future__ import annotations

from sqlalchemy import select

from .claim_transactions import _view
from .claim_transactions_models import SandboxClaimTransaction
from .insurance import require_coverages
from .insurance_models import PatientCoverage
from .models import Claim, Fill, Label, Patient, Prescription
from .service import Actor, PharmacyService, WorkflowError


class ThirdPartyRetryPlanner:
    def __init__(self, service: PharmacyService):
        self.service = service

    def plan(self, actor: Actor, fill_id: str) -> dict:
        """Produce exact rejection/resolution IDs for one safe mock retry.

        Reject incomplete/duplicate holds, a stale coverage set, historical
        claims or labels, and non-Product-Fill states. The returned plan is a
        *preflight snapshot*; it is never authorization to dispense or bill.
        """
        if not isinstance(fill_id, str) or not fill_id:
            raise WorkflowError("A synthetic fill ID is required")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Synthetic fill not found")
            rx = self.service._site(s, Prescription, fill.prescription_id, actor)
            patient = self.service._site(s, Patient, rx.patient_id, actor)
            if fill.status != "PRODUCT_FILL" or rx.status != "PRODUCT_FILL":
                raise WorkflowError("Only an active Product Fill can retry local test holds")
            if (s.scalar(select(Claim.id).where(Claim.fill_id == fill.id))
                    or s.scalar(select(Label.id).where(Label.fill_id == fill.id))):
                raise WorkflowError("Existing payer or label history needs separate reconciliation")
            events = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill.id,
                SandboxClaimTransaction.operation.in_(
                    ("TEST_REJECT", "TEST_RESOLVE", "TEST_RETRY")))).all()
            rejects = {event.id: event for event in events
                       if event.operation == "TEST_REJECT"}
            if not 1 <= len(rejects) <= 4:
                raise WorkflowError("Retry requires one to four distinct local test holds")
            linked: dict[str, SandboxClaimTransaction] = {}
            for event in events:
                _view(event)  # Verify both canonical digests before any planning.
                if event.operation == "TEST_REJECT":
                    if event.original_transaction_id is not None:
                        raise WorkflowError("Test rejection cannot have a parent event")
                    continue
                if (event.original_transaction_id not in rejects
                        or event.operation == "TEST_RETRY"):
                    raise WorkflowError("Unreconciled or previously retried test hold")
                if event.original_transaction_id in linked:
                    raise WorkflowError("Duplicate pharmacist resolution needs reconciliation")
                linked[event.original_transaction_id] = event

            coverages = s.scalars(select(PatientCoverage).where(
                PatientCoverage.site_id == actor.site_id,
                PatientCoverage.patient_id == patient.id,
                PatientCoverage.active.is_(True)
            ).order_by(PatientCoverage.position)).all()
            coverage_ids = [row.id for row in coverages]
            # Validates contiguous positions, patient/site, payer active,
            # effective dates, termination, supported synthetic billing rules
            # and duplicate payers. No claim is actually submitted here.
            selected = require_coverages(s, actor, rx, coverage_ids)
            by_coverage = {cov.id: (cov, payer) for cov, payer in selected}
            pairs = []
            seen = set()
            for original in rejects.values():
                details = _view(original)
                req, result = details["request"], details["response"]
                if (original.outcome != "REJECTED_SYNTHETIC"
                        or original.claim_id is not None
                        or original.coverage_id in seen
                        or original.coverage_id not in by_coverage
                        or req.get("fill_id") != fill.id
                        or req.get("coverage_id") != original.coverage_id
                        or req.get("payer_id") != original.payer_id
                        or req.get("position") != by_coverage[original.coverage_id][0].position
                        or original.payer_id != by_coverage[original.coverage_id][1].id
                        or result.get("reject_codes") != [req.get("reject_code")]):
                    raise WorkflowError("Inconsistent or duplicate synthetic rejection evidence")
                seen.add(original.coverage_id)
                resolution = linked.get(original.id)
                if resolution is None:
                    raise WorkflowError("Every selected test hold needs pharmacist clearance")
                resolution_request = _view(resolution)["request"]
                if (resolution.outcome != "CLEARED_TEST_HOLD"
                        or resolution.claim_id is not None
                        or resolution.payer_id != original.payer_id
                        or resolution.coverage_id != original.coverage_id
                        or resolution_request.get("original_transaction_id") != original.id):
                    raise WorkflowError("Pharmacist resolution ancestry does not match the hold")
                pairs.append({
                    "rejection_id": original.id,
                    "expected_resolution_id": resolution.id,
                    "coverage_id": original.coverage_id,
                    "coverage_position": by_coverage[original.coverage_id][0].position,
                    "reject_code": req.get("reject_code"),
                })
            pairs.sort(key=lambda row: row["coverage_position"])
            return {
                "fill_id": fill.id, "rx_number": rx.rx_number,
                "patient_id": patient.id,
                "test_holds": len(pairs),
                "mode": "SINGLE" if len(pairs) == 1 else "BATCH",
                "rejections": pairs, "coverage_ids": coverage_ids,
                "external_submission": False, "synthetic_only": True,
                "warning": (
                    "READ_ONLY_TEST_RETRY_PREFLIGHT_NOT_PAYER_APPROVAL; "
                    "mutating services must independently validate the current fill"
                ),
            }
