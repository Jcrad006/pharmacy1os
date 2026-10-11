"""Read-only claim ledger and explicit local *test* rejection injection.

No actual insurance network transport, eligibility checking or authorization.
"""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .claim_transactions import SandboxClaimService
from .rejection_batch import RejectionBatchService
from .service import Actor


class InjectRejectionIn(BaseModel):
    fill_id: str = Field(min_length=1)
    coverage_id: str = Field(min_length=1)
    reject_code: str
    idempotency_key: str = Field(min_length=8, max_length=160)
    reason: str = Field(min_length=12, max_length=2000)


class ClearTestRejectionIn(BaseModel):
    note: str = Field(min_length=12, max_length=2000)


class BatchRejectionPair(BaseModel):
    rejection_id: str = Field(min_length=1)
    expected_resolution_id: str = Field(min_length=1)


class RetryBatchRejectionsIn(BaseModel):
    fill_id: str = Field(min_length=1)
    rejections: list[BatchRejectionPair] = Field(min_length=2, max_length=4)
    coverage_ids: list[str] = Field(min_length=1, max_length=4)
    reason: str = Field(min_length=12, max_length=2000)


class RetryTestRejectionIn(BaseModel):
    expected_resolution_id: str = Field(min_length=1)
    coverage_ids: list[str] = Field(min_length=1, max_length=4)
    reason: str = Field(min_length=12, max_length=2000)


def make_claim_transaction_router(service: SandboxClaimService,
                                  actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-claim-operations"])

    @router.get("/fills/{fill_id}/claim-transactions")
    def transactions(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return {"transactions": service.list_for_fill(actor, fill_id)}

    @router.get("/third-party/test-rejections")
    def rejections(actor: Actor = Depends(actor_dependency)):
        return {"rejections": service.rejection_queue(actor)}

    @router.post("/third-party/test-rejections", status_code=201)
    def inject(payload: InjectRejectionIn, actor: Actor = Depends(actor_dependency)):
        return {"id": service.inject_rejection(actor, **payload.model_dump()),
                "synthetic_only": True}

    @router.post("/third-party/test-rejections/{rejection_id}/clear")
    def clear(rejection_id: str, payload: ClearTestRejectionIn,
              actor: Actor = Depends(actor_dependency)):
        return {"id": service.resolve_rejection(actor, rejection_id, payload.note),
                "synthetic_only": True, "external_approval": False}

    @router.post("/third-party/test-rejections/retry-batch")
    def retry_batch(payload: RetryBatchRejectionsIn,
                    actor: Actor = Depends(actor_dependency)):
        return RejectionBatchService(service.service).retry(
            actor, payload.fill_id,
            rejections=[pair.model_dump() for pair in payload.rejections],
            coverage_ids=payload.coverage_ids, reason=payload.reason)

    @router.post("/third-party/test-rejections/{rejection_id}/retry")
    def retry(rejection_id: str, payload: RetryTestRejectionIn,
              actor: Actor = Depends(actor_dependency)):
        return service.retry_cleared_rejection(
            actor, rejection_id, **payload.model_dump())

    return router
