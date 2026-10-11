"""Safety-restricted subset of original PATCH /prescriptions/:id/status.

TypeScript accepts a broad transition graph. Python intentionally exposes
only documented ON_HOLD, CANCELLED, and the exact resume-from-hold transition
here; all other paths must use dedicated clinically guarded workflows.
This is explicit PARTIAL contract parity, not a substitute for fill/verify/POS.
"""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from .lifecycle import LifecycleService
from .prescription_directory import PrescriptionDirectory
from .service import Actor, PharmacyService, WorkflowError


class GuardedStatusTransitionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str = Field(min_length=1, max_length=30)
    # An explicit reason and stale preconditions are intentionally stricter
    # than the original status-only body, to protect pharmacist workflows.
    reason: str = Field(min_length=12, max_length=2000)
    expected_version: int = Field(
        ge=0, strict=True, validation_alias=AliasChoices("expected_version", "expectedVersion"))
    expected_status: str = Field(
        min_length=1, max_length=30,
        validation_alias=AliasChoices("expected_status", "expectedStatus"))


def make_status_parity_router(service: PharmacyService,
                              actor_dependency: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/prescriptions",
                       tags=["synthetic-limited-status-parity"])
    lifecycle = LifecycleService(service)
    directory = PrescriptionDirectory(service)

    @router.patch("/{rx_id}/status")
    def transition_status(rx_id: str, payload: GuardedStatusTransitionIn,
                          actor: Actor = Depends(actor_dependency)):
        target, current = payload.status, payload.expected_status
        if target == "ON_HOLD" and current != "ON_HOLD":
            lifecycle.hold(
                actor, rx_id, payload.reason,
                expected_version=payload.expected_version,
                expected_status=current)
        elif target == "CANCELLED":
            lifecycle.cancel(
                actor, rx_id, payload.reason,
                expected_version=payload.expected_version,
                expected_status=current)
        elif current == "ON_HOLD" and target not in {
                "ON_HOLD", "CANCELLED", "TRANSFERRED"}:
            lifecycle.resume(
                actor, rx_id, payload.reason,
                expected_version=payload.expected_version,
                expected_status=current, target_status=target)
        else:
            raise WorkflowError(
                "Unsafe generic status transition is not supported in synthetic Python; "
                "use the dedicated fill, verification, transfer or POS workflow")
        return {"prescription": directory.detail(actor, rx_id)["prescription"]}

    return router
