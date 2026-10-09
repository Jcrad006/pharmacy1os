"""Original-inspired NTI manufacturer continuity and consent; SYNTHETIC ONLY.

Patient/prescriber consent is a pharmacist's *documentation assertion* here,
not an authenticated communication or legal determination. Manufacturer string
keys are a temporary replacement for the original manufacturer master table.
Biologics, controlled drugs and cold-chain drugs remain fail-closed.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (CheckConstraint, DateTime, ForeignKey, Index, String,
                        Text, UniqueConstraint, select)
from sqlalchemy.orm import Mapped, Session, mapped_column

from .date_rules import FillSaleTimestamp
from .models import (Base, Drug, Fill, FillSource, Prescription, Product, Stock,
                     utcnow, uuid)
from .service import Actor, PharmacyService, WorkflowError


class NtiManufacturerConsent(Base):
    __tablename__ = "py_nti_manufacturer_consents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, index=True)
    prior_manufacturer: Mapped[str] = mapped_column(String(120), nullable=False)
    new_manufacturer: Mapped[str] = mapped_column(String(120), nullable=False)
    prescriber_consent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    patient_consent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    documented_by_id: Mapped[str] = mapped_column(
        ForeignKey("py_staff.id"), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("fill_id", "prior_manufacturer", "new_manufacturer",
                         name="uq_py_nti_fill_manufacturer_pair"),
        CheckConstraint("prior_manufacturer <> new_manufacturer",
                        name="ck_py_nti_different_manufacturers"),
        CheckConstraint("length(trim(note)) BETWEEN 12 AND 2000",
                        name="ck_py_nti_documentation_note"),
        Index("ix_py_nti_site_fill", "site_id", "fill_id"),
    )


def _manufacturer(raw: str) -> str:
    """Temporary normalized *catalog label*, not verified manufacturer identity."""
    value = raw.strip().casefold() if isinstance(raw, str) else ""
    if not 1 <= len(value) <= 120:
        raise WorkflowError("Known catalog manufacturer name required")
    return value


def _utc(value: datetime) -> datetime:
    return (value.replace(tzinfo=timezone.utc)
            if value.tzinfo is None else value.astimezone(timezone.utc))


def _parse_consent_time(raw: str, label: str) -> datetime:
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 45:
        raise WorkflowError(f"{label} must be an offset-aware ISO 8601 timestamp")
    try:
        value = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise WorkflowError(f"Invalid {label} timestamp") from exc
    if value.tzinfo is None:
        raise WorkflowError(f"{label} must include a timezone offset")
    value = _utc(value)
    if value > utcnow():
        raise WorkflowError(f"{label} cannot be in the future")
    return value


def _prior_sold_manufacturer(session: Session, rx: Prescription,
                              current_fill_id: str) -> tuple[str, datetime] | None:
    """Most recently timestamped sold fill for this patient, drug and site.

    Legacy 'SOLD' rows without an independently recorded sale timestamp cannot
    safely establish order/continuity, so the workflow fails closed.
    """
    rows = session.execute(
        select(Fill.id, FillSaleTimestamp.sold_at)
        .join(Prescription, Fill.prescription_id == Prescription.id)
        .outerjoin(FillSaleTimestamp, FillSaleTimestamp.fill_id == Fill.id)
        .where(Prescription.site_id == rx.site_id,
               Prescription.patient_id == rx.patient_id,
               Prescription.drug_id == rx.drug_id,
               Fill.status == "SOLD", Fill.id != current_fill_id)).all()
    if not rows:
        return None
    if any(stamp is None for _, stamp in rows):
        raise WorkflowError("NTI history contains sold fills without verifiable sale timestamps")
    prior_fill_id, sold_at = max(rows, key=lambda row: (_utc(row[1]), row[0]))
    sources = session.scalars(select(FillSource).where(
        FillSource.fill_id == prior_fill_id)).all()
    if not sources:
        raise WorkflowError("NTI history is missing the prior sold physical product source")
    names = set()
    for source in sources:
        stock = session.get(Stock, source.stock_id)
        if stock is None or stock.site_id != rx.site_id:
            raise WorkflowError("NTI historical stock is missing or belongs to another site")
        product = session.get(Product, stock.product_id)
        if product is None or product.drug_id != rx.drug_id:
            raise WorkflowError("NTI historical NDC does not match the medication")
        names.add(_manufacturer(product.manufacturer))
    if len(names) != 1:
        raise WorkflowError("NTI prior sold fill has ambiguous manufacturer history")
    return names.pop(), _utc(sold_at)


def require_nti_source(session: Session, rx: Prescription, fill: Fill,
                       product: Product, existing_sources: list[FillSource]) -> None:
    """Fail closed on NTI split manufacturers and unconsented new manufacturer."""
    drug = session.get(Drug, rx.drug_id)
    if drug is None or not drug.nc_narrow_therapeutic_index:
        return
    candidate = _manufacturer(product.manufacturer)
    for source in existing_sources:
        stock = session.get(Stock, source.stock_id)
        if stock is None or stock.site_id != rx.site_id:
            raise WorkflowError("NTI scanned source stock is invalid")
        other = session.get(Product, stock.product_id)
        if other is None or other.drug_id != rx.drug_id:
            raise WorkflowError("NTI existing source product is invalid")
        if _manufacturer(other.manufacturer) != candidate:
            raise WorkflowError("NTI split-manufacturer fill is prohibited; separate lots of one manufacturer only")
        if (other.id != product.id and other.therapeutic_equivalence_code
                and product.therapeutic_equivalence_code
                and other.therapeutic_equivalence_code != product.therapeutic_equivalence_code):
            raise WorkflowError("Configured therapeutic-equivalence codes differ between NTI sources")
    prior = _prior_sold_manufacturer(session, rx, fill.id)
    if prior is None or prior[0] == candidate:
        return
    consent = session.scalar(select(NtiManufacturerConsent).where(
        NtiManufacturerConsent.site_id == rx.site_id,
        NtiManufacturerConsent.fill_id == fill.id,
        NtiManufacturerConsent.prior_manufacturer == prior[0],
        NtiManufacturerConsent.new_manufacturer == candidate))
    if consent is None:
        raise WorkflowError("NTI manufacturer change requires independently documented prescriber and patient consent")
    if (_utc(consent.prescriber_consent_at) < prior[1]
            or _utc(consent.patient_consent_at) < prior[1]):
        raise WorkflowError("NTI manufacturer consent predates the prior sold therapy")


def require_nti_fill(session: Session, rx: Prescription, fill: Fill,
                     sources: list[FillSource]) -> None:
    drug = session.get(Drug, rx.drug_id)
    if drug is None or not drug.nc_narrow_therapeutic_index:
        return
    for source in sources:
        stock = session.get(Stock, source.stock_id)
        if stock is None or stock.site_id != rx.site_id:
            raise WorkflowError("NTI fill source stock is unavailable")
        product = session.get(Product, stock.product_id)
        if product is None:
            raise WorkflowError("NTI source product cannot be resolved")
        require_nti_source(session, rx, fill, product,
                           [row for row in sources if row.id != source.id])


class NtiComplianceService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def _fill(self, session: Session, actor: Actor, fill_id: str):
        fill = session.scalar(select(Fill).where(Fill.id == fill_id).with_for_update())
        if fill is None:
            raise WorkflowError("NTI fill not found")
        rx = self.service._site(session, Prescription, fill.prescription_id, actor)
        drug = session.get(Drug, rx.drug_id)
        if drug is None or not drug.nc_narrow_therapeutic_index:
            raise WorkflowError("This prescription is not for a configured NTI medication")
        return fill, rx

    def preview(self, actor: Actor, fill_id: str) -> dict[str, Any]:
        with self.service.sessions() as session:
            self.service._authorized(session, actor, "read")
            fill, rx = self._fill(session, actor, fill_id)
            prior = _prior_sold_manufacturer(session, rx, fill.id)
            products = session.scalars(select(Product).where(
                Product.drug_id == rx.drug_id, Product.active.is_(True))
                .order_by(Product.ndc)).all()
            consents = session.scalars(select(NtiManufacturerConsent).where(
                NtiManufacturerConsent.site_id == rx.site_id,
                NtiManufacturerConsent.fill_id == fill.id)).all()
            return {
                "fill_id": fill.id, "prior_manufacturer": prior[0] if prior else None,
                "prior_sale_time": prior[1].isoformat() if prior else None,
                "active_manufacturers": sorted({
                    _manufacturer(p.manufacturer) for p in products}),
                "documented_changes": [{
                    "id": c.id, "prior_manufacturer": c.prior_manufacturer,
                    "new_manufacturer": c.new_manufacturer,
                    "prescriber_consent_at": _utc(c.prescriber_consent_at).isoformat(),
                    "patient_consent_at": _utc(c.patient_consent_at).isoformat(),
                    "documented_by_id": c.documented_by_id,
                    "note": c.note,
                } for c in consents],
                "warning": "SYNTHETIC_ASSERTION_NOT_VERIFIED_LEGAL_CONSENT",
            }

    def document(self, actor: Actor, fill_id: str, prior_manufacturer: str,
                 new_manufacturer: str, prescriber_consent_at: str,
                 patient_consent_at: str, note: str) -> dict[str, Any]:
        prior_name = _manufacturer(prior_manufacturer)
        new_name = _manufacturer(new_manufacturer)
        if prior_name == new_name:
            raise WorkflowError("A manufacturer change must identify two distinct manufacturers")
        prescriber_at = _parse_consent_time(prescriber_consent_at, "Prescriber consent")
        patient_at = _parse_consent_time(patient_consent_at, "Patient consent")
        clean_note = note.strip() if isinstance(note, str) else ""
        if not 12 <= len(clean_note) <= 2000:
            raise WorkflowError("NTI consent note must contain 12–2000 characters")
        with self.service.sessions.begin() as session:
            self.service._authorized(session, actor, "clinical")
            fill, rx = self._fill(session, actor, fill_id)
            if fill.status != "PRODUCT_FILL":
                raise WorkflowError("Document NTI manufacturer change before fill preparation")
            prior = _prior_sold_manufacturer(session, rx, fill.id)
            if prior is None or prior[0] != prior_name:
                raise WorkflowError("NTI prior manufacturer does not match verified sold therapy")
            if prescriber_at < prior[1] or patient_at < prior[1]:
                raise WorkflowError("Consent must follow the most recent sold therapy")
            if not session.scalar(select(Product.id).where(
                    Product.drug_id == rx.drug_id, Product.active.is_(True),
                    Product.manufacturer.in_([
                        p.manufacturer for p in session.scalars(select(Product).where(
                            Product.drug_id == rx.drug_id, Product.active.is_(True)))
                        if _manufacturer(p.manufacturer) == new_name]))):
                raise WorkflowError("New NTI manufacturer must exist on an active catalog product")
            if session.scalar(select(NtiManufacturerConsent.id).where(
                    NtiManufacturerConsent.fill_id == fill.id,
                    NtiManufacturerConsent.prior_manufacturer == prior_name,
                    NtiManufacturerConsent.new_manufacturer == new_name)):
                raise WorkflowError("NTI manufacturer change is already documented; never overwrite evidence")
            item = NtiManufacturerConsent(site_id=actor.site_id, fill_id=fill.id,
                prior_manufacturer=prior_name, new_manufacturer=new_name,
                prescriber_consent_at=prescriber_at, patient_consent_at=patient_at,
                documented_by_id=actor.id, note=clean_note)
            session.add(item)
            session.flush()
            self.service._audit(session, actor,
                "NC_NTI_MANUFACTURER_CHANGE_CONSENT_DOCUMENTED", item.id,
                {"fill_id": fill.id, "prior_manufacturer": prior_name,
                 "new_manufacturer": new_name, "documented_by_id": actor.id})
            return {"id": item.id, "fill_id": fill.id,
                    "prior_manufacturer": prior_name, "new_manufacturer": new_name,
                    "documented_by_id": actor.id,
                    "prescriber_consent_at": prescriber_at.isoformat(),
                    "patient_consent_at": patient_at.isoformat(),
                    "note": clean_note,
                    "warning": "SYNTHETIC_DOCUMENTATION_ASSERTION_ONLY"}
