"""Synthetic-only original-style prescription queue and detail API."""
from __future__ import annotations

from typing import Callable
from fastapi import APIRouter, Depends
from .prescription_directory import PrescriptionDirectory
from .service import Actor


def make_prescription_directory_router(directory: PrescriptionDirectory,
                                       actor_dependency: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/prescriptions", tags=["synthetic-rx-directory"])

    @router.get("/queue")
    def queue(status: str | None = None, query: str = "", sort: str = "oldest",
              limit: int = 100, actor: Actor = Depends(actor_dependency)):
        return directory.queue(actor, status=status, query=query, sort=sort, limit=limit)

    @router.get("/will-call")
    def will_call(actor: Actor = Depends(actor_dependency)):
        result = directory.queue(actor, status="READY", limit=200)
        return {"prescriptions": result["prescriptions"]}

    @router.get("/{prescription_id}/audit")
    def audit(prescription_id: str, limit: int = 200,
              actor: Actor = Depends(actor_dependency)):
        return directory.audit(actor, prescription_id, limit=limit)

    @router.get("/{prescription_id}")
    def detail(prescription_id: str, actor: Actor = Depends(actor_dependency)):
        return directory.detail(actor, prescription_id)

    return router
