"""Opt-in pharmacy-site FEFO settings; synthetic workflow only."""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .inventory_fefo import FefoPolicyService
from .service import Actor


class FefoConfigIn(BaseModel):
    product_id: str
    mode: str = "ADVISORY"
    minimum_shelf_life_days: int = Field(default=0, ge=0, le=3650)
    enabled: bool = True
    reason: str = Field(min_length=12, max_length=1000)


def make_fefo_router(directory: FefoPolicyService,
                     actor_dependency: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/inventory/fefo", tags=["synthetic-fefo"])

    @router.get("/policies")
    def policies(actor: Actor = Depends(actor_dependency)):
        return {"policies": directory.list(actor)}

    @router.post("/policies", status_code=201)
    def configure(payload: FefoConfigIn, actor: Actor = Depends(actor_dependency)):
        return {"id": directory.configure(actor, **payload.model_dump())}

    return router
