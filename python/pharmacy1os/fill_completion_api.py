"""Synthetic physical-part completion endpoints. Never live NCPDP settlement."""
from __future__ import annotations

from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .fill_completion import FillCompletionService
from .service import Actor


class InterruptIn(BaseModel):
    quantity: str
    reason: str = Field(min_length=1, max_length=1000)


class CompleteIn(BaseModel):
    quantity: str | None = None


def make_fill_completion_router(flows: FillCompletionService,
                                actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-physical-fill"])

    @router.post("/fills/{fill_id}/interrupt-as-partial")
    def interrupt(fill_id: str, payload: InterruptIn, actor: Actor = Depends(actor_dependency)):
        return {"obligation_id": flows.interrupt_as_partial(actor, fill_id, **payload.model_dump())}

    @router.post("/fills/{anchor_fill_id}/begin-completion")
    def begin_completion(anchor_fill_id: str, payload: CompleteIn,
                         actor: Actor = Depends(actor_dependency)):
        return {"fill_id": flows.begin_completion(actor, anchor_fill_id, payload.quantity)}

    @router.get("/fills/{anchor_fill_id}/owed-balance")
    def balance(anchor_fill_id: str, actor: Actor = Depends(actor_dependency)):
        return flows.balance(actor, anchor_fill_id)

    return router
