"""Explicit synthetic stock-exception refresh, queue and review endpoints."""
from __future__ import annotations
from typing import Callable

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .inventory_exceptions import InventoryExceptionRegistry
from .service import Actor


class ExceptionNoteIn(BaseModel):
    note: str = Field(min_length=12, max_length=2000)


def make_inventory_exception_router(registry: InventoryExceptionRegistry,
                                    actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/inventory/exceptions",
                       tags=["synthetic-inventory-exceptions"])

    @router.get("")
    def list_exceptions(status: str | None = None,
                        actor: Actor = Depends(actor_dependency)):
        return {"exceptions": registry.list(actor, status),
                "warning": "EXPLICIT_REFRESH_REQUIRED_NOT_EXHAUSTIVE"}

    @router.post("/refresh")
    def refresh(actor: Actor = Depends(actor_dependency)):
        return registry.refresh(actor)

    @router.get("/{exception_id}/events")
    def events(exception_id: str, actor: Actor = Depends(actor_dependency)):
        return {"events": registry.history(actor, exception_id)}

    @router.post("/{exception_id}/acknowledge")
    def acknowledge(exception_id: str, payload: ExceptionNoteIn,
                    actor: Actor = Depends(actor_dependency)):
        return {"exception": registry.acknowledge(actor, exception_id, payload.note)}

    @router.post("/{exception_id}/resolve")
    def resolve(exception_id: str, payload: ExceptionNoteIn,
                actor: Actor = Depends(actor_dependency)):
        return {"exception": registry.resolve(actor, exception_id, payload.note)}

    return router
