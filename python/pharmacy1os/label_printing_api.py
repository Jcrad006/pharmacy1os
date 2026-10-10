"""Synthetic bottle-label preview and audited print intent (no automatic hardware)."""
from __future__ import annotations

from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .label_printing import LabelPrintService
from .service import Actor


class PrintAttemptIn(BaseModel):
    request_key: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=1000)


def make_label_print_router(printer: LabelPrintService,
                            actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/label-print-jobs", tags=["synthetic-label-print"])

    @router.get("/fills/{fill_id}")
    def list_for_fill(fill_id: str, actor: Actor = Depends(actor_dependency)):
        return {"jobs": printer.list(actor, fill_id)}

    @router.get("/{job_id}/preview")
    def preview(job_id: str, actor: Actor = Depends(actor_dependency)):
        return {"label_text": printer.preview(actor, job_id), "synthetic_only": True}

    @router.post("/{job_id}/test-reprint")
    def test_reprint(job_id: str, payload: PrintAttemptIn,
                     actor: Actor = Depends(actor_dependency)):
        return {"id": printer.record_output_attempt(actor, job_id,
                   payload.request_key, payload.reason), "physical_print_verified": False}

    return router
