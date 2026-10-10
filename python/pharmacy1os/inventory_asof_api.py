"""Read-only synthetic as-of lot inventory reconstruction API."""
from __future__ import annotations
from typing import Callable

from fastapi import APIRouter, Depends

from .inventory_asof import HistoricalInventoryService
from .service import Actor


def make_asof_router(history: HistoricalInventoryService,
                     actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(tags=["synthetic-inventory-history"])

    @router.get("/api/inventory/balances/{stock_id}/as-of")
    def as_of(stock_id: str, at: str | None = None,
              actor: Actor = Depends(actor_dependency)):
        return history.as_of(actor, stock_id, at)

    return router
