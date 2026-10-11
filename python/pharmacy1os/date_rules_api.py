"""Synthetic-only read and pharmacist-reviewed date-policy endpoints."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from .service import Actor
from .date_rules import DateRulesService

class DatePolicyIn(BaseModel):
    minimum_days_between_fills: int = Field(ge=0, le=365)
    reason: str = Field(min_length=1, max_length=1000)

def make_date_rules_router(rules: DateRulesService, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-rx-date-rules"])

    @router.get("/prescriptions/{prescription_id}/date-rules")
    def preview(prescription_id: str, target_day: str | None = Query(default=None),
                actor: Actor = Depends(actor_dependency)):
        return rules.preview(actor, prescription_id, target_day=target_day)

    @router.post("/prescriptions/{prescription_id}/date-rules")
    def set_rules(prescription_id: str, payload: DatePolicyIn,
                  actor: Actor = Depends(actor_dependency)):
        rules.set_minimum_days(actor, prescription_id, payload.minimum_days_between_fills, payload.reason)
        return {"ok": True}
    return router
