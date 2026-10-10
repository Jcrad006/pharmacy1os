"""Synthetic Python exception board; read-only, not a clinical risk engine."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends
from .exceptions import ExceptionService
from .service import Actor

def make_exceptions_router(exceptions: ExceptionService, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api",tags=["synthetic-exceptions"])
    @router.get("/exceptions")
    def list_exceptions(kind: str | None = None, query: str = "", limit: int = 200,
                        actor: Actor = Depends(actor_dependency)):
        return {"items": exceptions.list(actor,kind=kind,query=query,limit=limit)}
    return router
