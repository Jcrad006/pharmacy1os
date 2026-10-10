"""Development-only emergency supply endpoints, protected by the existing actor check."""
from __future__ import annotations

from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .emergency_supply import EmergencySupplyService
from .service import Actor


class AuthorizeEmergencyIn(BaseModel):
    quantity: str
    reason: str = Field(min_length=1, max_length=2000)
    follow_up_due_at: str


class EmergencyFollowUpIn(BaseModel):
    note: str = Field(min_length=1, max_length=2000)


def make_emergency_supply_router(service: EmergencySupplyService,
                                 actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/emergency-supplies", tags=["synthetic-emergency"])

    @router.post("/prescriptions/{prescription_id}/authorize", status_code=201)
    def authorize(prescription_id: str, payload: AuthorizeEmergencyIn,
                  actor: Actor = Depends(actor_dependency)):
        fill_id = service.authorize(actor, prescription_id, **payload.model_dump())
        return {"fill_id": fill_id, "synthetic_only": True}

    @router.get("")
    def list_follow_ups(include_closed: bool = True, actor: Actor = Depends(actor_dependency)):
        return {"emergency_supplies": service.list(actor, include_closed=include_closed)}

    @router.post("/{fill_id}/follow-up/complete")
    def complete_follow_up(fill_id: str, payload: EmergencyFollowUpIn,
                           actor: Actor = Depends(actor_dependency)):
        service.complete_follow_up(actor, fill_id, payload.note)
        return {"ok": True}

    return router
