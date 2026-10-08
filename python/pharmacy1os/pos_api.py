"""Synthetic-only Python POS API. No live payment authorization or PHI."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from .pos import PosService
from .service import Actor


class CheckoutLineIn(BaseModel):
    fill_id: str
    amount: str


class TenderIn(BaseModel):
    method: str
    amount: str
    reference: str = ""


class CheckoutIn(BaseModel):
    lines: list[CheckoutLineIn] = Field(min_length=1, max_length=20)
    tenders: list[TenderIn] = Field(max_length=8)
    scanned_bags: dict[str, str] = Field(default_factory=dict)
    recipient_name: str
    identity_method: str
    signature_method: str
    signature_attested: bool
    idempotency_key: str
    relationship: str = ""
    mode: str = "WILL_CALL"


class FinancialIn(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)
    request_key: str = Field(min_length=1, max_length=120)


class RefundIn(FinancialIn):
    amount: str
    method: str


def make_pos_router(pos: PosService, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/pos", tags=["synthetic-pos"])

    @router.get("/transactions")
    def list_transactions(actor: Actor = Depends(actor_dependency)):
        return {"transactions": pos.list(actor)}

    @router.post("/transactions", status_code=201)
    def checkout(payload: CheckoutIn, actor: Actor = Depends(actor_dependency)):
        return pos.checkout(actor, lines=[x.model_dump() for x in payload.lines],
                            tenders=[x.model_dump() for x in payload.tenders],
                            scanned_bags=payload.scanned_bags, recipient_name=payload.recipient_name,
                            identity_method=payload.identity_method,
                            signature_method=payload.signature_method,
                            signature_attested=payload.signature_attested,
                            idempotency_key=payload.idempotency_key,
                            relationship=payload.relationship, mode=payload.mode)

    @router.get("/transactions/{transaction_id}")
    def transaction(transaction_id: str, actor: Actor = Depends(actor_dependency)):
        return pos.get(actor, transaction_id)

    @router.get("/transactions/{transaction_id}/receipt")
    def receipt(transaction_id: str, actor: Actor = Depends(actor_dependency)):
        return Response(pos.receipt(actor, transaction_id), media_type="text/plain", headers={"Cache-Control": "no-store"})

    @router.get("/transactions/{transaction_id}/events")
    def events(transaction_id: str, actor: Actor = Depends(actor_dependency)):
        return {"events": pos.ledger(actor, transaction_id)}

    @router.post("/transactions/{transaction_id}/refund")
    def refund(transaction_id: str, payload: RefundIn, actor: Actor = Depends(actor_dependency)):
        return pos.refund(actor, transaction_id, **payload.model_dump())

    @router.post("/transactions/{transaction_id}/void")
    def void(transaction_id: str, payload: FinancialIn, actor: Actor = Depends(actor_dependency)):
        return pos.void(actor, transaction_id, **payload.model_dump())

    return router
