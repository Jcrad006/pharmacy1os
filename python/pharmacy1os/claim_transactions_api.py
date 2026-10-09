"""Read-only claim ledger and explicit local *test* rejection injection.

No actual insurance network transport, eligibility checking or authorization.
"""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .claim_transactions import SandboxClaimService
from .service import Actor


class InjectRejectionIn(BaseModel):
    fill_id: str = Field(min_length=1)
    coverage_id: str = Field(min_length=1)
    reject_code: str
    idempotency_key: str = Field(min_length=8, max_length=160)
    reason: str = Field(min_length=12, max_length=2000)


class ClearTestRejectionIn(BaseModel):
    note: str = Field(min_length=12, max_length=2000)


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

    return router
