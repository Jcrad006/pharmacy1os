"""Only synthetic payer configuration and immutable sandbox claim history."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from .billing import BillingService
from .service import Actor


class ProfileVersionIn(BaseModel):
    payer_name: str = Field(min_length=1, max_length=120)
    payer_id: str | None = None
    max_physical_sources: int = Field(ge=1, le=4)
    billing_ndc_strategy: str = "MAJORITY_NDC"
    full_authorized_quantity: bool = True
    reason: str = Field(min_length=1, max_length=2000)


def make_billing_router(billing: BillingService, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-billing"])

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
