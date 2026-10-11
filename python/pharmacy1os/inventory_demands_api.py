"""Synthetic inventory demand/backorder queue and availability reconciliation API."""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .inventory_demands import InventoryDemandService
from .service import Actor


class ManualDemandIn(BaseModel):
    drug_id: str
    quantity: str
    source: str = "MANUAL"
    product_id: str | None = None
    needed_by: str | None = None
    note: str = Field(min_length=12, max_length=1000)


class DemandCancelIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


class DemandReconcileIn(BaseModel):
    drug_id: str


def make_demand_router(demands: InventoryDemandService,
                       actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/inventory/demands", tags=["synthetic-inventory-demands"])

    @router.get("")
    def list_demands(drug_id: str | None = None,
                     actor: Actor = Depends(actor_dependency)):
        return {"demands": demands.list(actor, drug_id=drug_id),
                "warning": "ADVISORY_AVAILABILITY_NOT_ALLOCATED_OR_GUARANTEED"}

    @router.get("/{demand_id}/events")
    def history(demand_id: str, actor: Actor = Depends(actor_dependency)):
        return {"events": demands.history(actor, demand_id)}

    @router.post("/manual", status_code=201)
    def create_manual(payload: ManualDemandIn,
                      actor: Actor = Depends(actor_dependency)):
        return {"id": demands.create_manual(actor, **payload.model_dump()),
                "synthetic_only": True}

    @router.post("/reconcile")
    def reconcile(payload: DemandReconcileIn,
                  actor: Actor = Depends(actor_dependency)):
        return demands.reconcile(actor, payload.drug_id)

    @router.post("/{demand_id}/cancel")
    def cancel(demand_id: str, payload: DemandCancelIn,
               actor: Actor = Depends(actor_dependency)):
        demands.cancel(actor, demand_id, payload.reason)
        return {"ok": True}

    return router
