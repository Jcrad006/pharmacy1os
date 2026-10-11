"""Read-only fill-level claim and bottle-label provenance, synthetic only.

Returns a compact original-style /fills/:id/claims projection. Every transaction
request checksum and every printed test-label snapshot hash is verified before
returning any summary. Never reports successful real-world printer output.
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select

from .billing_models import ClaimOperation
from .cob_attempts import CobAttemptRegistry
from .claim_transactions import _view
from .claim_transactions_models import SandboxClaimTransaction
from .insurance import _mask
from .insurance_models import ClaimCoverageSnapshot
from .label_printing import LabelPrintEvent, LabelPrintJob, SYNTHETIC_MARK, _hash
from .models import Claim, Fill, Label, Prescription
from .service import Actor, PharmacyService, WorkflowError


class FillClaimReview:
    def __init__(self, service: PharmacyService):
        self.service = service

    def detail(self, actor: Actor, fill_id: str) -> dict[str, Any]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            rx = self.service._site(s, Prescription, fill.prescription_id, actor)

            operations = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill_id).order_by(
                SandboxClaimTransaction.recorded_at,
                SandboxClaimTransaction.id)).all()
            # _view validates SHA-256 against canonical immutable request JSON.
            event_data = [_view(tx) for tx in operations]
            by_claim: dict[str, list[dict[str, Any]]] = {}
            other_events = []
            for ev in event_data:
                summary = {
                    "id": ev["id"], "operation": ev["operation"],
                    "outcome": ev["outcome"],
                    "original_transaction_id": ev["original_transaction_id"],
                    "recorded_at": ev["recorded_at"],
                    "reject_codes": ev["response"].get("reject_codes", []),
                    "messages": ev["response"].get("messages", []),
                    "payer_id": ev["payer_id"], "coverage_id": ev["coverage_id"],
                    "external_reference": None,
                    "real_payment_or_patient_responsibility": False,
                }
                if ev["claim_id"]:
                    by_claim.setdefault(ev["claim_id"], []).append(summary)
                else:
                    other_events.append(summary)

            # Reconcile every local BILL/REVERSE with its immutable versioned
            # payer attempt before presenting a current billing position.
            attempt_summary = CobAttemptRegistry(self.service)._history_tx(s, actor, fill.id)
            version_by_claim = {p["claim_id"]: p for p in attempt_summary["claim_positions"]}
            claim_rows = s.scalars(select(Claim).where(
                Claim.fill_id == fill.id).order_by(Claim.sequence)).all()
            result_claims = []
            for claim in claim_rows:
                source_ops = s.scalars(select(ClaimOperation).where(
                    ClaimOperation.site_id == actor.site_id,
                    ClaimOperation.claim_id == claim.id).order_by(
                    ClaimOperation.created_at, ClaimOperation.id)).all()
                paid = next((op for op in source_ops if op.operation == "SYNTHETIC_PAID"), None)
                billing_snapshot = json.loads(paid.source_snapshot) if paid else None
                coverage = s.scalar(select(ClaimCoverageSnapshot).where(
                    ClaimCoverageSnapshot.site_id == actor.site_id,
                    ClaimCoverageSnapshot.claim_id == claim.id))
                version = version_by_claim.get(claim.id)
                if version is None or not version["attempts"]:
                    raise WorkflowError("Claim has no validated synthetic attempt lineage")
                current = version["attempts"][-1]
                first = version["attempts"][0]
                result_claims.append({
                    "id": claim.id, "payer": claim.payer, "position": claim.sequence,
                    "status": claim.status, "billed_quantity": str(claim.billed_quantity),
                    "physical_quantity": str(fill.quantity),
                    "days_supply": (billing_snapshot.get("days_supply")
                                    if billing_snapshot is not None else None),
                    # The old ClaimOperation describes attempt 1 only; do
                    # not display it as the current NDC after selective COB.
                    "selected_ndc": current["billed_ndc"],
                    "original_selected_ndc": first["billed_ndc"],
                    "current_paid_transaction_id": (
                        current["paid_transaction_id"]
                        if current["state"] == "PAID_SYNTHETIC_LOCAL_ONLY" else None),
                    "active_attempt_number": current["attempt_number"],
                    "attempt_history": version["attempts"],
                    "original_claim_operation_snapshot_only": True,
                    "billing_profile": (billing_snapshot.get("billing_profile")
                                        if billing_snapshot is not None else None),
                    "source_count": (len(billing_snapshot.get("physical_sources", []))
                                     if billing_snapshot is not None else None),
                    "coverage": ({
                        "coverage_id": coverage.coverage_id,
                        "payer_id": coverage.payer_id,
                        "position": coverage.coverage_position,
                        "member_id_masked": _mask(coverage.member_id_snapshot),
                        "claim_standard": coverage.claim_standard_snapshot,
                    } if coverage else None),
                    "claim_transactions": by_claim.get(claim.id, []),
                    "operation_history": [{
                        "id": op.id, "operation": op.operation,
                        "selected_ndc": op.selected_ndc,
                        "billed_quantity": str(op.billed_quantity),
                        "created_at": op.created_at.isoformat(),
                    } for op in source_ops],
                })
            orphan_claim_events = set(by_claim) - {x.id for x in claim_rows}
            if orphan_claim_events:
                raise WorkflowError("Orphan claim transactions require historical review")

            labels = s.scalars(select(Label).where(
                Label.fill_id == fill.id).order_by(Label.bottle_number)).all()
            jobs = s.scalars(select(LabelPrintJob).where(
                LabelPrintJob.site_id == actor.site_id,
                LabelPrintJob.fill_id == fill.id)).all()
            job_by_label = {job.label_id: job for job in jobs}
            labels_out = []
            for label in labels:
                job = job_by_label.get(label.id)
                attempts = []
                if job is not None:
                    if _hash(job.snapshot_json) != job.sha256:
                        raise WorkflowError("Printed label snapshot checksum mismatch")
                    snapshot = json.loads(job.snapshot_json)
                    if (snapshot.get("banner") != SYNTHETIC_MARK
                            or snapshot.get("ndc") != label.ndc
                            or snapshot.get("bottle_number") != label.bottle_number
                            or snapshot.get("bottle_count") != label.bottle_count
                            or snapshot.get("physical_bottle_quantity") != str(label.quantity)
                            or snapshot.get("physical_total_quantity") != str(label.total)):
                        raise WorkflowError("Synthetic label snapshot does not match bottle record")
                    attempts = s.scalars(select(LabelPrintEvent).where(
                        LabelPrintEvent.site_id == actor.site_id,
                        LabelPrintEvent.print_job_id == job.id).order_by(
                        LabelPrintEvent.occurred_at, LabelPrintEvent.id)).all()
                labels_out.append({
                    "id": label.id, "bottle_number": label.bottle_number,
                    "bottle_count": label.bottle_count, "ndc": label.ndc,
                    "description": label.description, "physical_quantity": str(label.quantity),
                    "physical_total": str(label.total),
                    "print_job": ({
                        "id": job.id, "status": job.status, "sha256": job.sha256,
                        "void_reason": job.void_reason,
                        "test_output_attempted": bool(attempts),
                        "output_events": [{
                            "id": event.id, "event_kind": event.event_kind,
                            "actor_id": event.actor_id,
                            "occurred_at": event.occurred_at.isoformat(),
                            "hardware_success_confirmed": False,
                        } for event in attempts],
                    } if job else None),
                })
            if len(job_by_label) != len(jobs) or len(job_by_label) > len(labels):
                raise WorkflowError("Inconsistent bottle-label job mapping")
            return {
                "fill_id": fill.id, "prescription_id": rx.id,
                "rx_number": rx.rx_number, "fill_number": fill.fill_number,
                "attempt": fill.attempt, "status": fill.status,
                "physical_quantity": str(fill.quantity),
                "payer_intended_quantity": str(fill.billed_quantity),
                "claims": result_claims, "labels": labels_out,
                "versioned_cob": {
                    "total_attempts": attempt_summary["total_attempts"],
                    "active_local_paid_positions": attempt_summary[
                        "active_local_paid_positions"],
                    "external_payer_contact": False,
                },
                "standalone_test_events": other_events,
                "warnings": [
                    "LOCAL_SYNTHETIC_RECORDS_ONLY_NO_PAYER_OR_PRINTER_CONNECTIVITY",
                    "CLAIM_AMOUNT_PATIENT_RESPONSIBILITY_AND_DEVICE_PRINT_CONFIRMATION_UNAVAILABLE",
                ],
            }
