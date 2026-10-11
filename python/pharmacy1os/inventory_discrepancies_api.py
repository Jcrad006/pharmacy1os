"""Site-scoped, synthetic-only receiving discrepancy reporting API."""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .inventory_discrepancies import ReceivingDiscrepancyService
from .service import Actor


class ReceivingDiscrepancyIn(BaseModel):
    type: str
    note: str = Field(min_length=12, max_length=3000)
    purchase_order_id: str | None = None
    purchase_order_line_id: str | None = None
    receipt_id: str | None = None
    expected_product_id: str | None = None
    observed_product_id: str | None = None
    expected_quantity: str | None = None
    observed_quantity: str | None = None
    evidence_reference: str | None = Field(default=None, max_length=250)


class DiscrepancyResolutionIn(BaseModel):
    resolution_note: str = Field(min_length=12, max_length=3000)
    adjustment_movement_id: str | None = None


def make_discrepancy_router(directory: ReceivingDiscrepancyService,
                            actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/inventory/discrepancies",
                       tags=["synthetic-receiving-discrepancies"])

    @router.get("")
    def list_discrepancies(status: str | None = None,
                           actor: Actor = Depends(actor_dependency)):
        return {"discrepancies": directory.list(actor, status),
                "warning": "REVIEW_AND_DOCUMENTATION_ONLY_NO_STOCK_ADJUSTMENT"}

    @router.get("/{discrepancy_id}/events")
    def events(discrepancy_id: str, actor: Actor = Depends(actor_dependency)):
        return {"events": directory.history(actor, discrepancy_id)}

    @router.post("", status_code=201)
    def open_discrepancy(payload: ReceivingDiscrepancyIn,
                         actor: Actor = Depends(actor_dependency)):
        discrepancy_id = directory.open(actor, **payload.model_dump())
        return {"discrepancy_id": discrepancy_id, "synthetic_only": True}

    @router.post("/{discrepancy_id}/resolve")
    def resolve_discrepancy(discrepancy_id: str, payload: DiscrepancyResolutionIn,
                            actor: Actor = Depends(actor_dependency)):
        return {"discrepancy": directory.resolve(
            actor, discrepancy_id, **payload.model_dump())}

    return router
