"""Synthetic-only per-fill billing inputs; never transmits payer claims."""
from __future__ import annotations

from typing import Any
from sqlalchemy import select
from .models import Claim, Fill, FillSource, Label, Prescription, Product, Stock
from .service import Actor, PharmacyService, WorkflowError


def validate_days_supply(value: Any, *, allow_none: bool = False) -> int | None:
    if allow_none and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 2147483647:
        raise WorkflowError("Days supply must be a positive whole number")
    return value


class FillBillingDetailService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def update(self, actor: Actor, fill_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        if (not isinstance(changes, dict) or not changes or
                set(changes) - {"days_supply", "billing_product_id"}):
            raise WorkflowError("Provide days_supply and/or billing_product_id")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "process")
            fill = s.scalar(select(Fill).where(Fill.id == fill_id).with_for_update())
            if fill is None:
                raise WorkflowError("Fill not found")
            rx = self.service._site(s, Prescription, fill.prescription_id, actor)
            if fill.status != "PRODUCT_FILL" or rx.status != "PRODUCT_FILL":
                raise WorkflowError("Billing details cannot change after Product Fill")
            if (s.scalar(select(Claim.id).where(Claim.fill_id == fill_id).limit(1))
                    or s.scalar(select(Label.id).where(Label.fill_id == fill_id).limit(1))):
                raise WorkflowError("Claimed or labeled fill requires reversal")
            from .claim_transactions_models import SandboxClaimTransaction
            from .label_printing import LabelPrintJob
            if (s.scalar(select(SandboxClaimTransaction.id).where(
                    SandboxClaimTransaction.fill_id == fill_id).limit(1))
                    or s.scalar(select(LabelPrintJob.id).where(
                    LabelPrintJob.fill_id == fill_id).limit(1))):
                raise WorkflowError("Claim or label print history requires reversal")
            proposed = {}
            if "days_supply" in changes:
                proposed["days_supply"] = validate_days_supply(changes["days_supply"])
            if "billing_product_id" in changes:
                pid = changes["billing_product_id"]
                if pid is not None:
                    if not isinstance(pid, str):
                        raise WorkflowError("Billing product ID must be a string or null")
                    product = s.get(Product, pid)
                    if product is None or product.drug_id != rx.drug_id:
                        raise WorkflowError("Billing product does not match the prescription drug")
                    match = s.scalar(select(FillSource.id).join(
                        Stock, FillSource.stock_id == Stock.id).where(
                        FillSource.fill_id == fill_id, Stock.site_id == actor.site_id,
                        Stock.product_id == pid).limit(1))
                    if match is None:
                        raise WorkflowError("Billing product must match a scanned physical source")
                proposed["billing_product_id"] = pid
            changeset = {k: {"before": getattr(fill, k), "after": v}
                         for k, v in proposed.items() if getattr(fill, k) != v}
            if not changeset:
                raise WorkflowError("Billing details contain no changed values")
            for k, v in proposed.items():
                setattr(fill, k, v)
            self.service._audit(s, actor, "FILL_BILLING_DETAILS_UPDATED", fill.id, {
                "changed": changeset, "synthetic_only": True,
                "physical_quantity": str(fill.quantity),
                "payer_intended_quantity": str(fill.billed_quantity)})
            return {"id": fill.id, "days_supply": fill.days_supply,
                    "billing_product_id": fill.billing_product_id,
                    "physical_quantity": str(fill.quantity),
                    "billed_quantity": str(fill.billed_quantity)}
