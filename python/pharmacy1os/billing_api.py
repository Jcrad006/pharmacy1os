"""Only synthetic payer configuration and immutable sandbox claim history."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from .billing import BillingService
from .claim_rebilling import ClaimRebillService
from .third_party_workspace import ThirdPartyWorkspace
from .service import Actor


class RebillRestartIn(BaseModel):
    reason: str = Field(min_length=12, max_length=1000)
    expected_claim_ids: list[str] = Field(min_length=1, max_length=4)


class ProfileVersionIn(BaseModel):
    payer_name: str = Field(min_length=1, max_length=120)
    payer_id: str | None = None
    max_physical_sources: int = Field(ge=1, le=4)
    billing_ndc_strategy: str = "MAJORITY_NDC"
    full_authorized_quantity: bool = True
    reason: str = Field(min_length=1, max_length=2000)


def make_billing_router(billing: BillingService, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-billing"])

    @router.post("/billing/fills/{fill_id}/restart-for-rebill")
    def restart_for_rebill(fill_id: str, payload: RebillRestartIn,
                           actor: Actor = Depends(actor_dependency)):
        return ClaimRebillService(billing.service).restart(
            actor, fill_id, payload.reason, expected_claim_ids=payload.expected_claim_ids)

    @router.get("/billing/fills/{fill_id}/rebill-lineage")
    def rebill_lineage(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return ClaimRebillService(billing.service).lineage(actor, fill_id)

    @router.get("/third-party/workspace")
    def workspace(query: str = "", actor: Actor = Depends(actor_dependency)):
        return ThirdPartyWorkspace(billing.service).snapshot(actor, query=query)

    @router.get("/billing/profiles")
    def profiles(actor: Actor = Depends(actor_dependency)):
        return {"profiles": billing.profiles(actor)}

    @router.post("/billing/profiles", status_code=201)
    def update_profile(payload: ProfileVersionIn, actor: Actor = Depends(actor_dependency)):
        return {"id": billing.update_profile(actor, **payload.model_dump())}

    @router.get("/billing/fills/{fill_id}/claim-history")
    def claim_history(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return {"operations": billing.history(actor, fill_id)}

    return router
