"""Prescription/product selection safety gates used across synthetic dispensing.

Catalog metadata is preserved independently of certified clinical substitution,
cold-chain, NTI, biologic and transfer-in policy. These remain fail-closed.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Drug, Fill, FillSource, Prescription, Product, Stock
from .service import WorkflowError


def require_medication_eligible(s: Session, rx: Prescription) -> Drug:
    drug = s.get(Drug, rx.drug_id)
    if drug is None or not drug.active:
        raise WorkflowError("The prescribed medication is missing or inactive")
    if drug.controlled or drug.controlled_substance_schedule != "NONE":
        raise WorkflowError("controlled or unclassified medications require a validated workflow")
    if drug.nc_narrow_therapeutic_index:
        raise WorkflowError("NTI medication requires the unported manufacturer-consent workflow")
    if drug.is_biological or drug.has_fda_interchangeable_biologic_alternative:
        raise WorkflowError("Biologic substitution and required communication are not yet validated")
    if drug.requires_cold_chain:
        raise WorkflowError("Cold-chain product handling has not been validated")
    if rx.source_type == "TRANSFER":
        raise WorkflowError("Transfer-in source cannot be dispensed until a validated intake exists")
    if rx.product_selection_directive not in {
            "UNSPECIFIED", "SELECTION_PERMITTED", "DISPENSE_AS_WRITTEN"}:
        raise WorkflowError("Unknown product selection directive")
    if rx.product_selection_directive == "DISPENSE_AS_WRITTEN" and not rx.prescribed_product_id:
        raise WorkflowError("Dispense-as-written requires the specified product")
    if rx.prescribed_product_id:
        specified = s.get(Product, rx.prescribed_product_id)
        if specified is None or not specified.active or specified.drug_id != rx.drug_id:
            raise WorkflowError("Prescribed product is not an active NDC under the selected medication")
    return drug


def require_product_eligible(s: Session, rx: Prescription, product: Product | None) -> None:
    require_medication_eligible(s, rx)
    if product is None or not product.active or product.drug_id != rx.drug_id:
        raise WorkflowError("Selected physical product is inactive or does not match the prescribed drug")
    if (rx.product_selection_directive == "DISPENSE_AS_WRITTEN"
            and product.id != rx.prescribed_product_id):
        raise WorkflowError("Dispense-as-written prohibits this alternate NDC")


def require_fill_sources_eligible(s: Session, rx: Prescription, fill: Fill) -> None:
    require_medication_eligible(s, rx)
    for source in s.scalars(select(FillSource).where(FillSource.fill_id == fill.id)):
        stock = s.get(Stock, source.stock_id)
        if stock is None or stock.site_id != rx.site_id:
            raise WorkflowError("Physical source was lost or assigned to another site")
        require_product_eligible(s, rx, s.get(Product, stock.product_id))
