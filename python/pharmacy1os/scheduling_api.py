"""Development-only scheduled-fill API; actor is resolved by parent app."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from .scheduling import SchedulingService
from .service import Actor


class NewSchedule(BaseModel):
    prescription_id: str
    due_date: str
    idempotency_key: str = Field(min_length=1, max_length=100)
    quantity: str | None = None


class Reason(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


def make_schedule_router(schedules: SchedulingService, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-future-fills"])

    @router.get("/scheduled-fills")
    def list_schedules(actor: Actor = Depends(actor_dependency)):
        return {"scheduled_fills": schedules.list(actor)}

    @router.post("/scheduled-fills", status_code=201)
    def create_schedule(payload: NewSchedule, actor: Actor = Depends(actor_dependency)):
        return {"id": schedules.schedule(actor, **payload.model_dump())}

    @router.post("/scheduled-fills/{scheduled_id}/start")
    def start_scheduled(scheduled_id: str, actor: Actor = Depends(actor_dependency)):
        return {"fill_id": schedules.start_due(actor, scheduled_id)}

    @router.post("/scheduled-fills/{scheduled_id}/cancel")
    def cancel_scheduled(scheduled_id: str, payload: Reason, actor: Actor = Depends(actor_dependency)):
        schedules.cancel(actor, scheduled_id, payload.reason)
        return {"ok": True}

    @router.post("/prescriptions/{prescription_id}/refill-review")
    def begin_refill(prescription_id: str, payload: Reason, actor: Actor = Depends(actor_dependency)):
        schedules.begin_refill_review(actor, prescription_id, payload.reason)
        return {"ok": True}

    return router
