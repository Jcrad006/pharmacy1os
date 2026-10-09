"""Synthetic payer billing configuration and immutable claim history.

Never transmits NCPDP claims. Selection of one billing NDC from split physical
sources is ONLY a test-model assumption, not an asserted payer/legal rule.
"""
from __future__ import annotations
import json
from decimal import Decimal
from typing import Any
from sqlalchemy import select
from .billing_models import ClaimOperation, PayerBillingProfile
from .models import Claim, Fill, FillSource, Product, Stock
from .service import Actor, PharmacyService, WorkflowError


def _configuration(profile: PayerBillingProfile | None) -> dict[str, Any]:
    if profile is None:
        return {"profile_id": None, "version": None,
                "max_physical_sources": 4, "billing_ndc_strategy": "MAJORITY_NDC",
                "full_authorized_quantity": True}
    return {"profile_id": profile.id, "version": profile.version,
            "max_physical_sources": profile.max_physical_sources,
            "billing_ndc_strategy": profile.billing_ndc_strategy,
            "full_authorized_quantity": profile.full_authorized_quantity}


def _active_profile(s, site_id: str, name: str) -> PayerBillingProfile | None:
    from .insurance_models import InsurancePayer
    canonical = s.scalar(select(InsurancePayer).where(
        InsurancePayer.site_id == site_id, InsurancePayer.name == name))
    if canonical is not None:
        direct = s.scalar(select(PayerBillingProfile).where(
            PayerBillingProfile.site_id == site_id,
            PayerBillingProfile.payer_id == canonical.id,
            PayerBillingProfile.effective.is_(True))
            .order_by(PayerBillingProfile.version.desc()).limit(1))
        if direct is not None:
            return direct
    # Backward-compatible name-only profiles remain usable for existing demos.
    return s.scalar(select(PayerBillingProfile)
                    .where(PayerBillingProfile.site_id == site_id,
                           PayerBillingProfile.payer_name == name,
                           PayerBillingProfile.effective.is_(True))
                    .order_by(PayerBillingProfile.version.desc()).limit(1))


def profile_snapshot(s, site_id: str, payer: str, sources: list[FillSource]) -> dict[str, Any]:
    profile = _active_profile(s, site_id, payer)
    cfg = _configuration(profile)
    if len(sources) > cfg["max_physical_sources"]:
        raise WorkflowError("Configured payer requires fewer physical manufacturer sources")
    return cfg


def record_paid(s, actor: Actor, claim: Claim, sources: list[FillSource]) -> None:
    """Called inside the same DB transaction as legacy sandbox adjudication."""
    cfg = profile_snapshot(s, actor.site_id, claim.payer, sources)
    enriched = []
    for src in sources:
        stock = s.get(Stock, src.stock_id)
        if stock is None or stock.site_id != actor.site_id:
            raise WorkflowError("Cross-site fill source cannot be billed")
        product = s.get(Product, stock.product_id)
        if product is None:
            raise WorkflowError("Physical source product not found")
        enriched.append({"ndc": product.ndc, "stock_id": stock.id,
                         "quantity": str(src.quantity), "lot": stock.lot, "expires": stock.expires})
    if not enriched:
        raise WorkflowError("Claims require verified physical source records")
    if cfg["billing_ndc_strategy"] == "FIRST_SCANNED":
        chosen = enriched[0]
    else:
        chosen = sorted(enriched, key=lambda r: (-Decimal(r["quantity"]), r["ndc"], r["stock_id"]))[0]
    payload = {"physical_sources": enriched, "billing_profile": cfg,
               "warning": "SYNTHETIC_ONLY; DO_NOT_SEND_TO_PAYER"}
    s.add(ClaimOperation(site_id=actor.site_id, claim_id=claim.id,
                         profile_id=cfg["profile_id"], operation="SYNTHETIC_PAID",
                         payer_name=claim.payer, selected_ndc=chosen["ndc"],
                         billed_quantity=claim.billed_quantity,
                         source_snapshot=json.dumps(payload, sort_keys=True),
                         actor_id=actor.id, reason="Sandbox adjudication only"))


def record_reversal(s, actor: Actor, claim: Claim, reason: str) -> None:
    """Record a reversal before ending a transaction; preserve original paid event."""
    if not reason.strip():
        raise WorkflowError("Reversal needs documented reason")
    paid = s.scalar(select(ClaimOperation).where(ClaimOperation.claim_id == claim.id,
                                                ClaimOperation.operation == "SYNTHETIC_PAID"))
    if paid is None:
        # Existing synthetic claims created before this module carry no source snapshot.
        # Preserve legacy provenance limitations rather than fabricating one.
        selected, profile_id, snapshot = "LEGACY_UNKNOWN", None, json.dumps({"historical_event_missing": True})
    else:
        selected, profile_id, snapshot = paid.selected_ndc, paid.profile_id, paid.source_snapshot
    s.add(ClaimOperation(site_id=actor.site_id, claim_id=claim.id,
                         profile_id=profile_id, operation="SYNTHETIC_REVERSED",
                         payer_name=claim.payer, selected_ndc=selected,
                         billed_quantity=claim.billed_quantity,
                         source_snapshot=snapshot, reason=reason.strip()[:500], actor_id=actor.id))
    from .claim_transactions import record_test_reversal
    record_test_reversal(s, actor, claim, reason)


class BillingService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def update_profile(self, actor: Actor, payer_name: str, *, max_physical_sources: int,
                       billing_ndc_strategy: str = "MAJORITY_NDC",
                       full_authorized_quantity: bool = True, reason: str,
                       payer_id: str | None = None) -> str:
        name = payer_name.strip() if isinstance(payer_name, str) else ""
        if not name or len(name) > 120 or not reason or not reason.strip():
            raise WorkflowError("Payer name and change reason required")
        if len(reason.strip()) > 2000:
            raise WorkflowError("Profile reason too long")
        if max_physical_sources not in (1, 2, 3, 4):
            raise WorkflowError("Physical source maximum must be 1-4")
        if billing_ndc_strategy not in ("MAJORITY_NDC", "FIRST_SCANNED"):
            raise WorkflowError("Unsupported synthetic billing NDC selection")
        if not full_authorized_quantity:
            raise WorkflowError("Prototype supports only the full-authorized-quantity billing assumption")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            if payer_id is not None:
                from .insurance_models import InsurancePayer
                payer = s.scalar(select(InsurancePayer).where(
                    InsurancePayer.id == payer_id,
                    InsurancePayer.site_id == actor.site_id))
                if payer is None or not payer.active or payer.name != name:
                    raise WorkflowError("Linked payer must be active, belong to site and match profile name")
            old = _active_profile(s, actor.site_id, name)
            if old:
                old.effective = False
            new = PayerBillingProfile(site_id=actor.site_id, payer_name=name,
                payer_id=payer_id or (old.payer_id if old else None),
                version=(old.version + 1 if old else 1), max_physical_sources=max_physical_sources,
                billing_ndc_strategy=billing_ndc_strategy, full_authorized_quantity=True,
                effective=True, reason=reason.strip(), created_by_id=actor.id)
            s.add(new);s.flush()
            self.service._audit(s, actor, "PAYER_PROFILE_VERSION_CREATED", new.id,
                {"payer":name,"payer_id":new.payer_id,"version":new.version,
                 "prev":old.id if old else None,
                 "max_sources":max_physical_sources, "ndc_strategy":billing_ndc_strategy,
                 "reason":reason.strip()})
            return new.id

    def profiles(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            p=s.scalars(select(PayerBillingProfile).where(PayerBillingProfile.site_id==actor.site_id)
                        .order_by(PayerBillingProfile.payer_name, PayerBillingProfile.version)).all()
            return [{"id":x.id,"payer":x.payer_name,"payer_id":x.payer_id,
                     "version":x.version,
                     "max_physical_sources":x.max_physical_sources,
                     "billing_ndc_strategy":x.billing_ndc_strategy,"effective":x.effective} for x in p]

    def history(self, actor: Actor, fill_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill=s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            from .models import Prescription
            self.service._site(s, Prescription, fill.prescription_id, actor)
            claims=s.scalars(select(Claim).where(Claim.fill_id==fill_id)).all()
            output=[]
            for claim in claims:
                for e in s.scalars(select(ClaimOperation).where(ClaimOperation.claim_id==claim.id)
                                   .order_by(ClaimOperation.created_at, ClaimOperation.id)):
                    output.append({"id":e.id,"claim_id":claim.id,"sequence":claim.sequence,
                                   "payer":e.payer_name,"operation":e.operation,
                                   "selected_ndc":e.selected_ndc,"billed_quantity":str(e.billed_quantity),
                                   "source_snapshot":json.loads(e.source_snapshot),"reason":e.reason})
            return output
