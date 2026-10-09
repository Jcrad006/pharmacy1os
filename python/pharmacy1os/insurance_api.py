"""Synthetic site-scoped payer/coverage API. No claims leave this application."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .insurance import InsuranceDirectory
from .service import Actor


class PayerCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    bin: str | None = Field(default=None, max_length=12)
    pcn: str | None = Field(default=None, max_length=40)
    default_group_id: str | None = Field(default=None, max_length=100)
    claim_standard: str = "D0"
    billing_ndc_strategy: str = "MAJORITY_SOURCE"


class PayerStatusIn(BaseModel):
    active: bool
    reason: str = Field(min_length=1, max_length=1000)


class CoverageUpsertIn(BaseModel):
    payer_id: str
    member_id: str = Field(min_length=1, max_length=150)
    person_code: str | None = Field(default=None, max_length=30)
    group_id: str | None = Field(default=None, max_length=100)
    relationship: str = "SELF"
    cardholder_name: str | None = Field(default=None, max_length=200)
    cardholder_date_of_birth: str | None = None
    effective_date: str | None = None
    termination_date: str | None = None


class CoverageDeactivateIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


def make_insurance_router(svc: InsuranceDirectory,
                          actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-payers-coverages"])

    @router.get("/third-party/payers")
    def list_payers(actor: Actor = Depends(actor_dependency)):
        return {"payers": svc.list_payers(actor)}

    @router.post("/third-party/payers", status_code=201)
    def create_payer(payload: PayerCreateIn, actor: Actor = Depends(actor_dependency)):
        return {"id": svc.create_payer(actor, **payload.model_dump()),
                "synthetic_only": True}

    @router.patch("/third-party/payers/{payer_id}")
    def set_payer_active(payer_id: str, payload: PayerStatusIn,
                         actor: Actor = Depends(actor_dependency)):
        svc.set_payer_active(actor, payer_id, payload.active, payload.reason)
        return {"ok": True, "synthetic_only": True}

    @router.get("/patients/{patient_id}/coverages")
    def list_coverages(patient_id: str, actor: Actor = Depends(actor_dependency)):
        return {"coverages": svc.list_coverages(actor, patient_id)}

    @router.put("/patients/{patient_id}/coverages/{position}")
    def upsert_coverage(patient_id: str, position: int, payload: CoverageUpsertIn,
                        actor: Actor = Depends(actor_dependency)):
        return {"id": svc.upsert_coverage(
            actor, patient_id, position, **payload.model_dump()),
            "synthetic_only": True}

    @router.delete("/patients/{patient_id}/coverages/{position}")
    def deactivate_coverage(patient_id: str, position: int, payload: CoverageDeactivateIn,
                            actor: Actor = Depends(actor_dependency)):
        svc.deactivate_coverage(actor, patient_id, position, payload.reason)
        return {"ok": True, "synthetic_only": True}

    @router.get("/fills/{fill_id}/coverage-claim-history")
    def coverage_claim_history(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return {"items": svc.fill_claim_history(actor, fill_id)}

    return router
