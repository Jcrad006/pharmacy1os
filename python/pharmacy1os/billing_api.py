"""Only synthetic payer configuration and immutable sandbox claim history."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from .billing import BillingService
from .claim_rebilling import ClaimRebillService
from .third_party_workspace import ThirdPartyWorkspace
from .fill_claim_review import FillClaimReview
from .cob_correction_plan import CobCorrectionPlanner
from .cob_attempts import CobAttemptRegistry
from .cob_selective_correction import SyntheticCobCorrectionService
from .service import Actor


class SelectiveCobCorrectionIn(BaseModel):
    target_position: int = Field(ge=1, le=4)
    expected_active_paid_transaction_ids: list[str] = Field(min_length=1, max_length=4)
    corrected_billing_ndc: str = Field(min_length=1, max_length=30)
    reason: str = Field(min_length=12, max_length=1000)


class CurrentCobReversalIn(BaseModel):
    reason: str = Field(min_length=12, max_length=1000)
    expected_active_paid_transaction_ids: list[str] = Field(min_length=2, max_length=4)


class FullCobReversalIn(BaseModel):
    fill_id: str = Field(min_length=1)
    reason: str = Field(min_length=12, max_length=1000)
    expected_paid_transaction_ids: list[str] = Field(min_length=2, max_length=4)


class SinglePayerReversalIn(BaseModel):
    expected_claim_id: str = Field(min_length=1)
    reason: str = Field(min_length=12, max_length=1000)


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

    @router.post("/third-party/fills/{fill_id}/correct-cob")
    def correct_cob(fill_id: str, payload: SelectiveCobCorrectionIn,
                    actor: Actor = Depends(actor_dependency)):
        return SyntheticCobCorrectionService(billing.service).correct(
            actor, fill_id, payload.reason,
            target_position=payload.target_position,
            expected_active_paid_transaction_ids=payload.expected_active_paid_transaction_ids,
            corrected_billing_ndc=payload.corrected_billing_ndc)

    @router.post("/third-party/fills/{fill_id}/reverse-current-cob")
    def reverse_current_cob(fill_id: str, payload: CurrentCobReversalIn,
                            actor: Actor = Depends(actor_dependency)):
        return ClaimRebillService(billing.service).reverse_current_cob(
            actor, fill_id, payload.reason,
            expected_active_paid_transaction_ids=payload.expected_active_paid_transaction_ids)

    @router.post("/third-party/claims/reverse-cob")
    def reverse_cob(payload: FullCobReversalIn,
                    actor: Actor = Depends(actor_dependency)):
        return ClaimRebillService(billing.service).reverse_cob_transactions(
            actor, payload.fill_id, payload.reason,
            expected_paid_transaction_ids=payload.expected_paid_transaction_ids)

    @router.post("/third-party/claims/{transaction_id}/reverse")
    def reverse_single_payer(transaction_id: str, payload: SinglePayerReversalIn,
                             actor: Actor = Depends(actor_dependency)):
        return ClaimRebillService(billing.service).reverse_single_transaction(
            actor, transaction_id, payload.reason,
            expected_claim_id=payload.expected_claim_id)

    @router.post("/billing/fills/{fill_id}/restart-for-rebill")
    def restart_for_rebill(fill_id: str, payload: RebillRestartIn,
                           actor: Actor = Depends(actor_dependency)):
        return ClaimRebillService(billing.service).restart(
            actor, fill_id, payload.reason, expected_claim_ids=payload.expected_claim_ids)

    @router.get("/third-party/fills/{fill_id}/cob-correction-plan")
    def cob_correction_plan(fill_id: str, target_position: int,
                            actor: Actor = Depends(actor_dependency)):
        return CobCorrectionPlanner(billing.service).plan(
            actor, fill_id, target_position=target_position)

    @router.get("/third-party/fills/{fill_id}/cob-attempts")
    def cob_attempts(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return CobAttemptRegistry(billing.service).history(actor, fill_id)

    @router.get("/fills/{fill_id}/claims")
    def fill_claims(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return FillClaimReview(billing.service).detail(actor, fill_id)

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
