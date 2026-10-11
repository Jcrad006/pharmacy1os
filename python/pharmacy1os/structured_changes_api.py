"""Development-only API for documented prescription data changes."""
from __future__ import annotations
from typing import Any, Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from .service import Actor
from .structured_changes import StructuredChangeService

class ApplyChangeIn(BaseModel):
    value: Any
    approval_note: str = Field(min_length=8, max_length=2000)
    expected_version: int = Field(ge=0)


def make_structured_changes_router(service: StructuredChangeService,
                                   actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-structured-changes"])

    @router.post("/prescription-changes/{record_id}/apply")
    def apply(record_id: str, payload: ApplyChangeIn, actor: Actor = Depends(actor_dependency)):
        return service.apply(actor, record_id, payload.value, payload.approval_note,
                             expected_version=payload.expected_version)

    @router.get("/prescriptions/{rx_id}/structured-change-history")
    def history(rx_id: str, actor: Actor = Depends(actor_dependency)):
        return {"applications": service.history(actor, rx_id)}
    return router
