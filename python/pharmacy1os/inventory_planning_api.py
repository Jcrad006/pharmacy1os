"""Synthetic replenishment policy API. No automatic purchasing or live ordering."""
from typing import Callable

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .inventory_planning import InventoryPlanningService
from .service import Actor


class ReorderPolicyInput(BaseModel):
    product_id: str
    minimum: str
    target: str
    reason: str


class ReorderDisableInput(BaseModel):
    reason: str


def make_planning_router(planning: InventoryPlanningService, actor_dependency: Callable):
    router = APIRouter(prefix="/api/inventory/replenishment", tags=["synthetic-inventory"])
    actor = Depends(actor_dependency)

    @router.get("")
    def recommendations(include_all: bool = False, staff: Actor = actor):
        return {"recommendations": planning.recommendations(staff, include_all=include_all)}

    @router.post("/policies")
    def configure(payload: ReorderPolicyInput, staff: Actor = actor):
        return {"id": planning.configure(staff, **payload.model_dump())}

    @router.post("/policies/{product_id}/disable")
    def disable(product_id: str, payload: ReorderDisableInput, staff: Actor = actor):
        planning.disable(staff, product_id, payload.reason)
        return {"ok": True}

    return router
