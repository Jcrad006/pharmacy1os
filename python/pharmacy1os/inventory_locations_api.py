"""Site-scoped synthetic physical inventory and FEFO advisory API."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .inventory_locations import InventoryLocationService
from .inventory_allocations import InventoryAllocationService
from .service import Actor


class LocationIn(BaseModel):
    code: str = Field(min_length=1, max_length=48)
    name: str = Field(min_length=1, max_length=160)
    type: str
    barcode: str | None = Field(default=None, max_length=100)
    is_default_receiving: bool = False
    is_default_dispensing: bool = False
    is_quarantine: bool = False
    temperature_min_c: str | None = None
    temperature_max_c: str | None = None


class LocationReconcileIn(BaseModel):
    location_id: str
    attestation: str = Field(min_length=12, max_length=2000)


class MovePositionIn(BaseModel):
    stock_id: str
    from_location_id: str
    to_location_id: str
    quantity: str
    reason: str = Field(min_length=1, max_length=2000)


def make_inventory_location_router(directory: InventoryLocationService,
                                   actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/inventory", tags=["synthetic-inventory-locations"])

    @router.get("/locations")
    def locations(actor: Actor = Depends(actor_dependency)):
        return {"locations": directory.locations(actor)}

    @router.post("/locations", status_code=201)
    def create_location(payload: LocationIn, actor: Actor = Depends(actor_dependency)):
        return {"id": directory.create(actor, **payload.model_dump())}

    @router.post("/locations/activate/{stock_id}")
    def activate_stock(stock_id: str, payload: LocationReconcileIn,
                       actor: Actor = Depends(actor_dependency)):
        directory.activate_stock(actor, stock_id, payload.location_id, payload.attestation)
        return {"ok": True, "warning": "VERIFIED_SYNTHETIC_LOCATION_BASELINE_ONLY"}

    @router.get("/locations/stock/{stock_id}")
    def positions(stock_id: str, actor: Actor = Depends(actor_dependency)):
        return {"positions": directory.positions(actor, stock_id)}

    @router.post("/locations/move")
    def move(payload: MovePositionIn, actor: Actor = Depends(actor_dependency)):
        directory.move(actor, **payload.model_dump())
        return {"ok": True}

    @router.get("/fills/{fill_id}/allocations")
    def fill_allocations(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return {"allocations": InventoryAllocationService(directory.service).for_fill(
            actor, fill_id)}

    @router.get("/fefo")
    def fefo(product_id: str, minimum_shelf_life_days: int = 0,
             actor: Actor = Depends(actor_dependency)):
        return {"recommendations": directory.fefo_recommendations(
            actor, product_id, minimum_shelf_life_days=minimum_shelf_life_days),
            "warning": "ADVISORY_ONLY_NO_AUTOMATIC_FEFO_ALLOCATION"}

    return router
