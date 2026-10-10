"""Synthetic FastAPI endpoints for the Python prescriber directory.

These routes reuse the API's existing demo actor dependency and workflow error
handlers. They do not implement production authentication or provider licensing.
"""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from .provider_directory import ProviderDirectory
from .provider_parity import PrescriberParityService
from .service import Actor


class IdentifierIn(BaseModel):
    type: str
    number: str
    jurisdiction: str = ""
    is_primary: bool = False


class ContactIn(BaseModel):
    kind: str
    value: str
    label: str = ""
    extension: str = ""
    is_primary: bool = False


class AddressIn(BaseModel):
    line1: str
    city: str
    state: str
    postal_code: str
    line2: str = ""
    label: str = ""
    is_primary: bool = False


class IdentifierRetireIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


def make_provider_router(directory: ProviderDirectory, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["synthetic-prescriber-directory"])

    @router.get("/prescribers")
    def original_prescribers(
            actor: Actor = Depends(actor_dependency), query: str = "",
            first_name: str = Query("", alias="firstName"),
            last_name: str = Query("", alias="lastName"),
            date_of_birth: str | None = Query(None, alias="dateOfBirth"),
            phone: str = ""):
        return {"prescribers": PrescriberParityService(directory.pharmacy).search(
            actor, query=query, first_name=first_name,
            last_name=last_name, date_of_birth=date_of_birth,
            phone=phone)}

    @router.get("/prescribers/search")
    def search_providers(q: str = "", actor: Actor = Depends(actor_dependency)):
        return {"prescribers": directory.search(actor, q)}

    @router.get("/prescribers/{prescriber_id}/directory")
    def provider_directory(prescriber_id: str, actor: Actor = Depends(actor_dependency)):
        return directory.details(actor, prescriber_id)

    @router.post("/prescribers/{prescriber_id}/identifiers", status_code=201)
    def add_identifier(prescriber_id: str, payload: IdentifierIn,
                       actor: Actor = Depends(actor_dependency)):
        return {"id": directory.add_identifier(actor, prescriber_id, **payload.model_dump())}

    @router.post("/prescribers/{prescriber_id}/contacts", status_code=201)
    def add_contact(prescriber_id: str, payload: ContactIn,
                    actor: Actor = Depends(actor_dependency)):
        return {"id": directory.add_contact(actor, prescriber_id, **payload.model_dump())}

    @router.post("/prescribers/{prescriber_id}/addresses", status_code=201)
    def add_address(prescriber_id: str, payload: AddressIn,
                    actor: Actor = Depends(actor_dependency)):
        return {"id": directory.add_address(actor, prescriber_id, **payload.model_dump())}

    @router.post("/provider-identifiers/{identifier_id}/retire")
    def retire_identifier(identifier_id: str, payload: IdentifierRetireIn,
                          actor: Actor = Depends(actor_dependency)):
        directory.retire_identifier(actor, identifier_id, payload.reason)
        return {"ok": True}

    return router
