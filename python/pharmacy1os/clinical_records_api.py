"""Site-scoped original-inspired clinical note endpoints, synthetic only."""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .clinical_records import ClinicalRecordService
from .service import Actor


class DurIssueIn(BaseModel):
    code: str = Field(min_length=1, max_length=70)
    title: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    severity: str = "WARNING"


class DurResolveIn(BaseModel):
    note: str = Field(min_length=1, max_length=4000)


class InterventionIn(BaseModel):
    note: str = Field(min_length=1, max_length=4000)


def make_clinical_record_router(directory: ClinicalRecordService,
                                actor_dependency: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/prescriptions", tags=["synthetic-clinical"])

    @router.get("/{prescription_id}/clinical")
    def clinical(prescription_id: str, actor: Actor = Depends(actor_dependency)):
        return directory.clinical_record(actor, prescription_id)

    @router.post("/{prescription_id}/dur/issues", status_code=201)
    def add_issue(prescription_id: str, payload: DurIssueIn,
                  actor: Actor = Depends(actor_dependency)):
        return {"issue": directory.create_issue(actor, prescription_id, **payload.model_dump())}

    @router.patch("/dur/issues/{issue_id}/resolve")
    def resolve_issue(issue_id: str, payload: DurResolveIn,
                      actor: Actor = Depends(actor_dependency)):
        return {"issue": directory.resolve_issue(actor, issue_id, payload.note)}

    @router.post("/{prescription_id}/interventions", status_code=201)
    def record(prescription_id: str, payload: InterventionIn,
               actor: Actor = Depends(actor_dependency)):
        return {"intervention": directory.record_intervention(
            actor, prescription_id, payload.note)}

    return router


def make_dur_resolution_router(directory: ClinicalRecordService,
                               actor_dependency: Callable) -> APIRouter:
    """Preserve the original Fastify /api/dur/issues/:id/resolve path."""
    router = APIRouter(prefix="/api/dur", tags=["synthetic-clinical"])

    @router.patch("/issues/{issue_id}/resolve")
    def resolve_issue(issue_id: str, payload: DurResolveIn,
                      actor: Actor = Depends(actor_dependency)):
        return {"issue": directory.resolve_issue(actor, issue_id, payload.note)}

    return router
