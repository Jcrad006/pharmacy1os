"""NTI pharmacist consent and read-only source preview, synthetic only."""
from __future__ import annotations

from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .nti_compliance import NtiComplianceService
from .service import Actor


class ConsentIn(BaseModel):
    prior_manufacturer: str = Field(min_length=1, max_length=120)
    new_manufacturer: str = Field(min_length=1, max_length=120)
    prescriber_consent_at: str
    patient_consent_at: str
    note: str = Field(min_length=12, max_length=2000)


def make_nti_router(service: NtiComplianceService,
                    actor_dependency: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/fills", tags=["synthetic-nti"])

    @router.get("/{fill_id}/nti-compliance")
    def preview(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return service.preview(actor, fill_id)

    @router.post("/{fill_id}/nti-manufacturer-consent", status_code=201)
    def document(fill_id: str, payload: ConsentIn,
                 actor: Actor = Depends(actor_dependency)):
        return {"consent": service.document(actor, fill_id, **payload.model_dump())}

    return router
