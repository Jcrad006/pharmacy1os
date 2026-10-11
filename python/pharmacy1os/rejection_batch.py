"""Atomic multi-hold local retry with exact pharmacist resolution ancestry.

A fill with several manually injected test rejections must not claim all
payers by retrying only one hold. Local simulation only: no payer transport.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy import select

from .claim_transactions import _record, _view, require_no_open_test_rejections
from .claim_transactions_models import SandboxClaimTransaction
from .insurance import require_coverages
from .models import Claim, Fill, Label, Prescription
from .service import Actor, PharmacyService, WorkflowError


def require_rejections_retried_for_preparation(
    s, actor: Actor, fill: Fill, *, selected_coverage_ids: list[str] | None
) -> None:
    """Enforce one validated resolution and retry for every mock test hold."""
    rejects = s.scalars(select(SandboxClaimTransaction).where(
        SandboxClaimTransaction.site_id == actor.site_id,
        SandboxClaimTransaction.fill_id == fill.id,
        SandboxClaimTransaction.operation == "TEST_REJECT")).all()
    if not rejects:
        return
    if selected_coverage_ids is None:
        raise WorkflowError("Documented test rejection requires coverage-linked pharmacist retry")
    seen = set()
    for original in rejects:
        if original.coverage_id in seen:
            raise WorkflowError("Duplicate mock rejection coverage requires manual reconciliation")
        seen.add(original.coverage_id)
        evidence = _view(original)
        if (original.outcome != "REJECTED_SYNTHETIC"
                or original.claim_id is not None
                or original.original_transaction_id is not None
                or original.coverage_id not in selected_coverage_ids
                or evidence["request"].get("fill_id") != fill.id
                or evidence["request"].get("coverage_id") != original.coverage_id
                or evidence["request"].get("payer_id") != original.payer_id):
            raise WorkflowError("Mock rejection origin does not match current COB")
        linked = s.scalars(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.site_id == actor.site_id,
            SandboxClaimTransaction.original_transaction_id == original.id,
            SandboxClaimTransaction.operation.in_(("TEST_RESOLVE", "TEST_RETRY")))).all()
        resolved = [x for x in linked if x.operation == "TEST_RESOLVE"]
        retried = [x for x in linked if x.operation == "TEST_RETRY"]
        if len(resolved) != 1 or len(retried) != 1:
            raise WorkflowError(
                "Each synthetic hold requires its own pharmacist resolution and retry before preparation")
        res, retry = resolved[0], retried[0]
        rv, tv = _view(res), _view(retry)
        if (res.outcome != "CLEARED_TEST_HOLD"
                or retry.outcome != "RETRIED_SYNTHETIC"
                or any(x.fill_id != fill.id or x.claim_id is not None
                       or x.payer_id != original.payer_id
                       or x.coverage_id != original.coverage_id for x in linked)
                or rv["request"].get("original_transaction_id") != original.id
                or tv["request"].get("original_rejection_id") != original.id
                or tv["request"].get("resolution_id") != res.id
                or tv["request"].get("coverage_ids") != selected_coverage_ids):
            raise WorkflowError("Synthetic hold retry ancestry or COB selection is inconsistent")


class RejectionBatchService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def retry(self, actor: Actor, fill_id: str, *, rejections: list[dict[str, str]],
              coverage_ids: list[str], reason: str) -> dict[str, Any]:
        note = reason.strip() if isinstance(reason, str) else ""
        if not 12 <= len(note) <= 2000:
            raise WorkflowError("Documented batch retry reason must be 12-2000 characters")
        if (not isinstance(rejections, list) or not 2 <= len(rejections) <= 4
                or any(not isinstance(item, dict)
                       or not isinstance(item.get("rejection_id"), str)
                       or not item.get("rejection_id")
                       or not isinstance(item.get("expected_resolution_id"), str)
                       or not item.get("expected_resolution_id") for item in rejections)):
            raise WorkflowError("Batch retry requires two to four rejection/resolution pairs")
        ids = [item["rejection_id"] for item in rejections]
        if len(set(ids)) != len(ids):
            raise WorkflowError("Batch retry rejection IDs must be unique")
        if (not isinstance(coverage_ids, list) or not 1 <= len(coverage_ids) <= 4
                or any(not isinstance(cid, str) or not cid for cid in coverage_ids)
                or len(set(coverage_ids)) != len(coverage_ids)):
            raise WorkflowError("Batch retry requires one to four unique ordered coverage IDs")
        key_payload = json.dumps({"fill": fill_id, "pairs": rejections,
                                  "coverage_ids": coverage_ids, "reason": note},
                                 sort_keys=True, separators=(",", ":"))
        batch_key = hashlib.sha256(key_payload.encode("utf-8")).hexdigest()
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            fill = s.scalar(select(Fill).where(Fill.id == fill_id).with_for_update())
            if fill is None:
                raise WorkflowError("Batch rejection fill not found")
            rx = self.service._site(s, Prescription, fill.prescription_id, actor)
            # Exact patient/site/position/active-coverage check applies even on
            # replay: never accept an unrelated or stale COB list.
            selected = require_coverages(s, actor, rx, coverage_ids)
            originals = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.fill_id == fill.id,
                SandboxClaimTransaction.operation == "TEST_REJECT")).all()
            if len(originals) != len(ids) or {x.id for x in originals} != set(ids):
                raise WorkflowError("Batch retry must include every rejection for this fill")
            by_id = {event.id: event for event in originals}
            supplied_positions = []
            linked = []
            for item in rejections:
                original = by_id[item["rejection_id"]]
                view = _view(original)
                request = view["request"]
                if (original.outcome != "REJECTED_SYNTHETIC"
                        or original.claim_id is not None
                        or original.original_transaction_id is not None
                        or request.get("fill_id") != fill.id
                        or request.get("coverage_id") != original.coverage_id
                        or request.get("payer_id") != original.payer_id):
                    raise WorkflowError("Original test rejection provenance is inconsistent")
                matched = [(cov, payer) for cov, payer in selected
                           if cov.id == original.coverage_id and payer.id == original.payer_id]
                if len(matched) != 1 or request.get("position") != matched[0][0].position:
                    raise WorkflowError("Rejected coverage does not match the current payer sequence")
                supplied_positions.append(matched[0][0].position)
                resolution = s.scalar(select(SandboxClaimTransaction).where(
                    SandboxClaimTransaction.site_id == actor.site_id,
                    SandboxClaimTransaction.original_transaction_id == original.id,
                    SandboxClaimTransaction.operation == "TEST_RESOLVE"))
                if resolution is None:
                    raise WorkflowError("Every mock rejection needs documented pharmacist resolution")
                details = _view(resolution)
                if (resolution.id != item["expected_resolution_id"]
                        or resolution.outcome != "CLEARED_TEST_HOLD"
                        or resolution.fill_id != fill.id
                        or resolution.claim_id is not None
                        or resolution.payer_id != original.payer_id
                        or resolution.coverage_id != original.coverage_id
                        or details["request"].get("original_transaction_id") != original.id):
                    raise WorkflowError("Pharmacist resolution ID or ancestry changed; refresh")
                retry = s.scalar(select(SandboxClaimTransaction).where(
                    SandboxClaimTransaction.site_id == actor.site_id,
                    SandboxClaimTransaction.original_transaction_id == original.id,
                    SandboxClaimTransaction.operation == "TEST_RETRY"))
                linked.append((original, resolution, retry))
            if supplied_positions != sorted(set(supplied_positions)):
                raise WorkflowError("Rejections must be in increasing COB coverage position order")
            prior = [retry for _, _, retry in linked]
            if any(prior):
                if not all(prior):
                    raise WorkflowError("Partially retried mock rejection chain needs manual reconciliation")
                for original, resolution, retry in linked:
                    rv = _view(retry)
                    req = rv["request"]
                    if (retry.outcome != "RETRIED_SYNTHETIC"
                            or retry.fill_id != fill.id
                            or retry.coverage_id != original.coverage_id
                            or retry.payer_id != original.payer_id
                            or retry.claim_id is not None
                            or req.get("batch_key") != batch_key
                            or req.get("original_rejection_id") != original.id
                            or req.get("resolution_id") != resolution.id
                            or req.get("coverage_ids") != coverage_ids
                            or req.get("reason") != note):
                        raise WorkflowError("Batch retry replay differs from committed correction")
                claims = s.scalars(select(Claim).where(
                    Claim.fill_id == fill.id).order_by(Claim.sequence)).all()
                if len(claims) != len(coverage_ids):
                    raise WorkflowError("Batch retry has no complete prepared payer claims")
                from .cob_attempts import CobAttemptRegistry
                CobAttemptRegistry(self.service)._history_tx(s, actor, fill.id)
                return {
                    "fill_id": fill.id, "rejection_ids": ids,
                    "resolution_ids": [x[1].id for x in linked],
                    "retry_transaction_ids": [x.id for x in prior],
                    "claim_ids": [c.id for c in claims],
                    "replayed": True, "batch_key": batch_key,
                    "external_submission": False, "synthetic_only": True,
                    "fill_status": fill.status,
                }
            if fill.status != "PRODUCT_FILL" or rx.status != "PRODUCT_FILL":
                raise WorkflowError("Only a Product Fill may retry test rejections")
            if (s.scalar(select(Claim.id).where(Claim.fill_id == fill.id))
                    or s.scalar(select(Label.id).where(Label.fill_id == fill.id))):
                raise WorkflowError("Fill already has claim or label history")
            require_no_open_test_rejections(s, actor, fill)
            retry_ids = []
            for original, resolution, _ in linked:
                tx = _record(s, actor, fill.id, "TEST_RETRY", "RETRIED_SYNTHETIC",
                    "synthetic-batch-retry:" + original.id,
                    {"original_rejection_id": original.id, "resolution_id": resolution.id,
                     "coverage_ids": coverage_ids, "batch_key": batch_key,
                     "reason": note},
                    {"outcome": "RETRIED_SYNTHETIC",
                     "message": "All test holds retried locally; no payer contact"},
                    payer_id=original.payer_id, coverage_id=original.coverage_id,
                    original_id=original.id)
                retry_ids.append(tx.id)
            labels = self.service._prepare_for_review_tx(
                s, actor, fill.id, [], coverage_ids=coverage_ids)
            claim_ids = s.scalars(select(Claim.id).where(
                Claim.fill_id == fill.id).order_by(Claim.sequence)).all()
            self.service._audit(s, actor, "SYNTHETIC_TEST_REJECTION_BATCH_RETRIED",
                fill.id, {"rejection_ids": ids,
                          "resolution_ids": [x[1].id for x in linked],
                          "retry_transaction_ids": retry_ids,
                          "claim_ids": claim_ids, "batch_key": batch_key,
                          "external_payer_contact": False, "reason": note})
            return {
                "fill_id": fill.id, "rejection_ids": ids,
                "resolution_ids": [x[1].id for x in linked],
                "retry_transaction_ids": retry_ids, "claim_ids": claim_ids,
                "labels": labels, "replayed": False, "batch_key": batch_key,
                "requires_pharmacist_verification": True,
                "external_submission": False, "synthetic_only": True,
                "fill_status": fill.status,
            }
