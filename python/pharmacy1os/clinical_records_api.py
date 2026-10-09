"""Site-scoped original-inspired clinical note endpoints, synthetic only."""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .clinical_records import ClinicalRecordService
from .service import Actor


class InterventionIn(BaseModel):
    note: str = Field(min_length=1, max_length=4000)


def make_clinical_record_router(directory: ClinicalRecordService,
                                actor_dependency: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/prescriptions", tags=["synthetic-clinical"])

    @router.get("/{prescription_id}/clinical")
    def clinical(prescription_id: str, actor: Actor = Depends(actor_dependency)):
        return directory.clinical_record(actor, prescription_id)

    @router.post("/{prescription_id}/interventions", status_code=201)
    def record(prescription_id: str, payload: InterventionIn,
               actor: Actor = Depends(actor_dependency)):
        return {"intervention": directory.record_intervention(
            actor, prescription_id, payload.note)}

    return router
