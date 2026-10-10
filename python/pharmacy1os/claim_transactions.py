"""Local synthetic claim event ledger and explicit simulated rejection workspace.

No network calls or payer transactions are performed. "PAID_SYNTHETIC" denotes
only that the in-process test adapter returned a simulated outcome.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any
from sqlalchemy import select

from .claim_transactions_models import SandboxClaimTransaction
from .insurance_models import InsurancePayer, PatientCoverage, ClaimCoverageSnapshot
from .models import Claim, Fill, Prescription, Stock, Product
from .billing_models import ClaimOperation
from .service import Actor, PharmacyService, WorkflowError

TEST_REJECT_CODES = {
    "TEST_70": "Simulated product/service not covered",
    "TEST_75": "Simulated prior authorization required",
    "TEST_79": "Simulated refill too soon",
}


def _canonical(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _record(s, actor: Actor, fill_id: str, operation: str, outcome: str,
            key: str, request: dict[str, Any], response: dict[str, Any],
            *, claim_id: str | None = None, payer_id: str | None = None,
            coverage_id: str | None = None,
            original_id: str | None = None) -> SandboxClaimTransaction:
    request_json = _canonical(request)
    event = SandboxClaimTransaction(
        site_id=actor.site_id, fill_id=fill_id, claim_id=claim_id,
        payer_id=payer_id, coverage_id=coverage_id,
        original_transaction_id=original_id, operation=operation,
        outcome=outcome, idempotency_key=key,
        request_json=request_json,
        response_json=_canonical(response),
        request_sha256=hashlib.sha256(request_json.encode("utf-8")).hexdigest(),
        actor_id=actor.id)
    s.add(event)
    s.flush()
    return event


def require_no_open_test_rejections(s, actor: Actor, fill: Fill) -> None:
    rejects = s.scalars(select(SandboxClaimTransaction).where(
        SandboxClaimTransaction.site_id == actor.site_id,
        SandboxClaimTransaction.fill_id == fill.id,
        SandboxClaimTransaction.operation == "TEST_REJECT")).all()
    for event in rejects:
        cleared = s.scalar(select(SandboxClaimTransaction.id).where(
            SandboxClaimTransaction.site_id == actor.site_id,
            SandboxClaimTransaction.original_transaction_id == event.id,
            SandboxClaimTransaction.operation == "TEST_RESOLVE"))
        if cleared is None:
            raise WorkflowError(
                "Open synthetic insurance rejection requires pharmacist resolution before fill preparation")


def record_test_paid(s, actor: Actor, claim: Claim) -> None:
    """Called after ClaimOperation/Snapshot are flushed inside fill transaction."""
    fill = s.get(Fill, claim.fill_id)
    if fill is None:
        raise WorkflowError("Claim is missing parent fill")
    rx = s.get(Prescription, fill.prescription_id)
    if rx is None or rx.site_id != actor.site_id:
        raise WorkflowError("Cannot record cross-site synthetic claim")
    paid = s.scalar(select(ClaimOperation).where(
        ClaimOperation.claim_id == claim.id,
        ClaimOperation.operation == "SYNTHETIC_PAID"))
    if paid is None:
        raise WorkflowError("Synthetic claim source selection was not recorded")
    coverage = s.scalar(select(ClaimCoverageSnapshot).where(
        ClaimCoverageSnapshot.claim_id == claim.id))
    cfg = json.loads(paid.source_snapshot)
    request = {
        "adapter": "PHARMACY1OS_LOCAL_TEST_ONLY",
        "standard": coverage.claim_standard_snapshot if coverage else "SANDBOX_LEGACY",
        "patient_id": rx.patient_id, "fill_id": fill.id,
        "payer_name": claim.payer, "payer_id": coverage.payer_id if coverage else None,
        "coverage_id": coverage.coverage_id if coverage else None,
        "coverage_position": coverage.coverage_position if coverage else claim.sequence,
        "billed_ndc": paid.selected_ndc,
        "payer_intended_quantity": str(claim.billed_quantity),
        "physical_part_quantity": str(fill.quantity),
        "days_supply": fill.days_supply,
        "selected_billing_product_id": fill.billing_product_id,
        "source_snapshot": cfg["physical_sources"],
        "billing_profile": cfg["billing_profile"],
        # No member ID, person code, DOB, or group ID in this public-safe ledger.
    }
    response = {
        "outcome": "PAID_SYNTHETIC",
        "adapter": "LOCAL_TEST_ONLY",
        "authorization_number": None,
        "transaction_reference": None,
        "amount_paid": None, "patient_responsibility": None,
        "reject_codes": [], "messages": ["Simulated acceptance; no payer contacted"],
    }
    _record(s, actor, fill.id, "BILL", "PAID_SYNTHETIC",
            f"synthetic-bill:{claim.id}", request, response,
            claim_id=claim.id,
            payer_id=coverage.payer_id if coverage else None,
            coverage_id=coverage.coverage_id if coverage else None)


def record_test_reversal(s, actor: Actor, claim: Claim, reason: str) -> None:
    paid = s.scalar(select(SandboxClaimTransaction).where(
        SandboxClaimTransaction.site_id == actor.site_id,
        SandboxClaimTransaction.claim_id == claim.id,
        SandboxClaimTransaction.operation == "BILL"))
    fill = s.get(Fill, claim.fill_id)
    if fill is None:
        raise WorkflowError("Missing source fill for synthetic reversal")
    request = {
        "claim_id": claim.id, "reason": reason.strip()[:500],
        "original_transaction_id": paid.id if paid else None,
        "legacy_original_missing": paid is None,
    }
    response = {
        "outcome": "REVERSED_SYNTHETIC",
        "message": "Local simulation only; no remote payer reversal",
        "transaction_reference": None,
    }
    _record(s, actor, fill.id, "REVERSE", "REVERSED_SYNTHETIC",
            f"synthetic-reverse:{claim.id}", request, response,
            claim_id=claim.id,
            payer_id=paid.payer_id if paid else None,
            coverage_id=paid.coverage_id if paid else None,
            original_id=paid.id if paid else None)


def _view(tx: SandboxClaimTransaction) -> dict[str, Any]:
    request = json.loads(tx.request_json)
    if hashlib.sha256(_canonical(request).encode("utf-8")).hexdigest() != tx.request_sha256:
        raise WorkflowError("Synthetic transaction integrity check failed")
    return {
        "id": tx.id, "fill_id": tx.fill_id, "claim_id": tx.claim_id,
        "payer_id": tx.payer_id, "coverage_id": tx.coverage_id,
        "original_transaction_id": tx.original_transaction_id,
        "operation": tx.operation, "outcome": tx.outcome,
        "idempotency_key": tx.idempotency_key,
        "request": request, "response": json.loads(tx.response_json),
        "request_sha256": tx.request_sha256,
        "actor_id": tx.actor_id, "recorded_at": tx.recorded_at.isoformat(),
        "warning": "SYNTHETIC_LOCAL_ADAPTER_NO_REAL_INSURANCE_ADJUDICATION",
    }


class SandboxClaimService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def list_for_fill(self, actor: Actor, fill_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            self.service._site(s, Prescription, fill.prescription_id, actor)
            events = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill_id)
                .order_by(SandboxClaimTransaction.recorded_at,
                          SandboxClaimTransaction.id)).all()
            return [_view(e) for e in events]

    def rejection_queue(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rejects = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.operation == "TEST_REJECT")
                .order_by(SandboxClaimTransaction.recorded_at)).all()
            output = []
            for item in rejects:
                resolution = s.scalar(select(SandboxClaimTransaction.id).where(
                    SandboxClaimTransaction.site_id == actor.site_id,
                    SandboxClaimTransaction.original_transaction_id == item.id,
                    SandboxClaimTransaction.operation == "TEST_RESOLVE"))
                details = json.loads(item.response_json)
                output.append({
                    "id": item.id, "fill_id": item.fill_id,
                    "payer_id": item.payer_id, "coverage_id": item.coverage_id,
                    "code": details["reject_codes"][0],
                    "message": details["messages"][0],
                    "status": "CLEARED_TEST_HOLD" if resolution else "OPEN_TEST_REJECTION",
                    "resolution_id": resolution,
                    "warning": "MANUALLY_INJECTED_DEVELOPMENT_REJECTION",
                })
            return output

    def inject_rejection(self, actor: Actor, fill_id: str, coverage_id: str,
                         reject_code: str, idempotency_key: str,
                         reason: str) -> str:
        """Only a pharmacist can create a mock rejection for workspace testing."""
        if reject_code not in TEST_REJECT_CODES:
            raise WorkflowError("Unsupported development-only reject code")
        if not isinstance(idempotency_key, str) or not 8 <= len(idempotency_key.strip()) <= 160:
            raise WorkflowError("Idempotency key must be between 8 and 160 characters")
        if not isinstance(reason, str) or not 12 <= len(reason.strip()) <= 2000:
            raise WorkflowError("Test rejection reason requires 12 to 2000 characters")
        key = "synthetic-reject:" + idempotency_key.strip()
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            fill = s.scalar(select(Fill).where(Fill.id == fill_id).with_for_update())
            if fill is None:
                raise WorkflowError("Fill not found")
            rx = self.service._site(s, Prescription, fill.prescription_id, actor)
            if fill.status != "PRODUCT_FILL":
                raise WorkflowError("Test rejections require a Product Fill awaiting review")
            cov = s.scalar(select(PatientCoverage).where(
                PatientCoverage.id == coverage_id,
                PatientCoverage.site_id == actor.site_id,
                PatientCoverage.patient_id == rx.patient_id))
            if cov is None:
                raise WorkflowError("Coverage not found for prescription patient and site")
            payer = s.scalar(select(InsurancePayer).where(
                InsurancePayer.id == cov.payer_id,
                InsurancePayer.site_id == actor.site_id))
            if payer is None:
                raise WorkflowError("Coverage payer not found at site")
            request = {
                "fill_id": fill_id, "coverage_id": coverage_id,
                "payer_id": payer.id, "position": cov.position,
                "reject_code": reject_code, "reason": reason.strip(),
            }
            response = {
                "outcome": "REJECTED_SYNTHETIC",
                "reject_codes": [reject_code], "messages": [TEST_REJECT_CODES[reject_code]],
                "authorization_number": None,
                "warning": "Manually injected test rejection; no payer contacted",
            }
            existing = s.scalar(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.idempotency_key == key))
            if existing is not None:
                if (existing.site_id != actor.site_id or existing.operation != "TEST_REJECT"
                    or existing.request_json != _canonical(request)):
                    raise WorkflowError("Idempotency key conflict")
                return existing.id
            event = _record(s, actor, fill_id, "TEST_REJECT", "REJECTED_SYNTHETIC",
                            key, request, response, payer_id=payer.id,
                            coverage_id=coverage_id)
            self.service._audit(s, actor, "SYNTHETIC_TEST_REJECTION_CREATED", event.id, {
                "fill_id": fill_id, "coverage_id": coverage_id,
                "reject_code": reject_code, "external_contact": False,
            })
            return event.id

    def resolve_rejection(self, actor: Actor, rejection_id: str, note: str) -> str:
        """Clear a development hold only. Never claim a payer accepted a claim."""
        if not isinstance(note, str) or not 12 <= len(note.strip()) <= 2000:
            raise WorkflowError("Document review is required to clear a test rejection")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            original = s.scalar(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.id == rejection_id,
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.operation == "TEST_REJECT"))
            if original is None:
                raise WorkflowError("Synthetic rejection not found")
            fill = s.scalar(select(Fill).where(Fill.id == original.fill_id).with_for_update())
            if fill is None:
                raise WorkflowError("Source fill not found")
            self.service._site(s, Prescription, fill.prescription_id, actor)
            if fill.status != "PRODUCT_FILL":
                raise WorkflowError("Rejection must be resolved before fill review")
            existing = s.scalar(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.original_transaction_id == original.id,
                SandboxClaimTransaction.operation == "TEST_RESOLVE"))
            if existing is not None:
                raise WorkflowError("Test rejection was already cleared")
            event = _record(s, actor, fill.id, "TEST_RESOLVE", "CLEARED_TEST_HOLD",
                            "synthetic-resolve:" + original.id,
                            {"original_transaction_id": original.id, "note": note.strip()},
                            {"outcome": "CLEARED_TEST_HOLD",
                             "message": "Hold cleared locally, NOT an approved insurance claim"},
                            payer_id=original.payer_id, coverage_id=original.coverage_id,
                            original_id=original.id)
            self.service._audit(s, actor, "SYNTHETIC_TEST_REJECTION_CLEARED", event.id, {
                "original_transaction_id": original.id, "fill_id": fill.id,
                "external_approval": False,
            })
            return event.id
