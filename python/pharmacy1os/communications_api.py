"""Synthetic-only communications worklist API; NO fax/eRx transport endpoints."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from .service import Actor
from .communications import CommunicationService


class CommunicationIn(BaseModel):
    prescription_id: str
    document_id: str
    direction: str
    channel: str
    destination: str
    summary: str
    request_key: str


class CommunicationEventIn(BaseModel):
    action: str
    note: str = Field(min_length=1, max_length=2000)
    request_key: str


def make_communications_router(service: CommunicationService,
                               actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/communications", tags=["synthetic-communications"])

    @router.get("")
    def list_tasks(status: str | None = None, actor: Actor = Depends(actor_dependency)):
        return {"tasks": service.list(actor, status=status)}

    @router.post("", status_code=201)
    def create_task(payload: CommunicationIn, actor: Actor = Depends(actor_dependency)):
        return {"id": service.create(actor, rx_id=payload.prescription_id, **payload.model_dump(exclude={"prescription_id"}))}

    @router.get("/{task_id}/events")
    def task_history(task_id: str, actor: Actor = Depends(actor_dependency)):
        return {"events": service.history(actor, task_id)}

    @router.post("/{task_id}/events", status_code=201)
    def record_event(task_id: str, payload: CommunicationEventIn,
                     actor: Actor = Depends(actor_dependency)):
        return {"id": service.change(actor, task_id, **payload.model_dump())}

    return router
