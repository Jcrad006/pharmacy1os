"""Synthetic Will Call custody API; uses existing demo actor dependency."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from .service import Actor
from .willcall import WillCallService

class RebagRequest(BaseModel):
    new_barcode: str = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=1000)

class RelocateRequest(BaseModel):
    new_bin: str = Field(min_length=1, max_length=60)
    reason: str = Field(min_length=1, max_length=1000)

def make_willcall_router(service: WillCallService,
                         actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/will-call", tags=["synthetic-will-call"])

    @router.post("/fills/{fill_id}/rebag")
    def rebag(fill_id: str, body: RebagRequest,
              actor: Actor = Depends(actor_dependency)):
        return {"bag_barcode": service.rebag(actor, fill_id, body.new_barcode, body.reason)}

    @router.post("/fills/{fill_id}/relocate")
    def relocate(fill_id: str, body: RelocateRequest,
                 actor: Actor = Depends(actor_dependency)):
        return {"bin": service.relocate(actor, fill_id, body.new_bin, body.reason)}

    @router.get("/fills/{fill_id}/history")
    def history(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return {"events": service.history(actor, fill_id)}

    return router
