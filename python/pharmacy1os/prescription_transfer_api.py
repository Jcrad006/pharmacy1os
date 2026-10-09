"""Synthetic transfer-out handoff routes. No fax/eRx or external delivery."""
from __future__ import annotations

from typing import Callable
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .prescription_transfer import TransferService
from .service import Actor


class TransferRequestIn(BaseModel):
    prescription_id: str
    destination_name: str = Field(min_length=1, max_length=180)
    destination_phone: str = Field(min_length=1, max_length=60)
    reason: str = Field(min_length=1, max_length=1000)
    request_key: str = Field(min_length=1, max_length=120)


class TransferAttestationIn(BaseModel):
    receiving_pharmacist: str = Field(min_length=1, max_length=150)
    handoff_reference: str = Field(min_length=1, max_length=150)
    note: str = Field(min_length=1, max_length=2000)
    personally_confirmed: bool


class TransferWithdrawalIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


def make_transfer_router(svc: TransferService, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/prescription-transfers-out", tags=["synthetic-transfer-out"])

    @router.post("", status_code=201)
    def request(payload: TransferRequestIn, actor: Actor = Depends(actor_dependency)):
        return {"id": svc.request(actor, **payload.model_dump()), "externally_sent": False}

    @router.get("")
    def list_outgoing(actor: Actor = Depends(actor_dependency)):
        return {"items": svc.list(actor)}

    @router.get("/{transfer_id}")
    def detail(transfer_id: str, actor: Actor = Depends(actor_dependency)):
        return svc.get(actor, transfer_id)

    @router.post("/{transfer_id}/attest")
    def attest(transfer_id: str, payload: TransferAttestationIn,
               actor: Actor = Depends(actor_dependency)):
        svc.attest_out(actor, transfer_id, **payload.model_dump())
        return {"ok": True, "externally_sent": False}

    @router.post("/{transfer_id}/withdraw")
    def withdraw(transfer_id: str, payload: TransferWithdrawalIn,
                 actor: Actor = Depends(actor_dependency)):
        svc.withdraw(actor, transfer_id, payload.reason)
        return {"ok": True}

    return router
