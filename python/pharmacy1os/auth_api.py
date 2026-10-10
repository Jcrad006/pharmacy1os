"""Synthetic authenticated-session API. No header-based identity selection in this mode."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from .auth import AuthService
from .service import Actor


class LoginIn(BaseModel):
    username: str = Field(max_length=100)
    password: str = Field(max_length=256)


class EnrollIn(BaseModel):
    staff_id: str
    username: str
    password: str


class PasswordIn(BaseModel):
    old_password: str
    new_password: str


def make_auth_router(auth: AuthService, actor_dependency):
    router = APIRouter(prefix="/api/auth", tags=["synthetic-auth"])

    def bearer(authorization: Annotated[str | None, Header()] = None) -> str:
        if not authorization:
            raise HTTPException(status_code=401, detail="Authentication required",
                                headers={"WWW-Authenticate": "Bearer"})
        scheme, sep, token = authorization.partition(" ")
        if not sep or scheme.lower() != "bearer" or not token or " " in token:
            raise HTTPException(status_code=401, detail="Authentication required",
                                headers={"WWW-Authenticate": "Bearer"})
        return token

    @router.post("/login")
    def login(payload: LoginIn):
        return auth.login(payload.username, payload.password)

    @router.get("/me")
    def whoami(actor: Actor = Depends(actor_dependency)):
        return {"staff_id": actor.id, "site_id": actor.site_id, "role": actor.role,
                "synthetic_only": True}

    @router.post("/logout")
    def logout(token: str = Depends(bearer)):
        auth.logout(token)
        return {"ok": True}

    @router.post("/password")
    def password(payload: PasswordIn, token: str = Depends(bearer)):
        auth.rotate_password(token, payload.old_password, payload.new_password)
        return {"ok": True, "all_sessions_revoked": True}

    @router.post("/admin/enroll")
    def enroll(payload: EnrollIn, actor: Actor = Depends(actor_dependency)):
        return {"staff_id": auth.provision(actor, payload.staff_id, payload.username, payload.password)}

    @router.post("/admin/disable/{staff_id}")
    def disable(staff_id: str, actor: Actor = Depends(actor_dependency)):
        auth.disable(actor, staff_id)
        return {"ok": True}

    return router
