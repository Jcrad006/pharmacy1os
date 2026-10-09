"""New Python-native schema. Kept separate from the legacy Prisma schema."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import (
    Boolean, CheckConstraint, DateTime, ForeignKey, Integer, Numeric,
    String, Text, UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def uuid() -> str:
    return str(uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Site(Base):
    __tablename__ = "py_sites"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    name: Mapped[str] = mapped_column(String(150))


class Staff(Base):
    __tablename__ = "py_staff"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(30))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Patient(Base):
    __tablename__ = "py_patients"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100), index=True)
    date_of_birth: Mapped[str | None] = mapped_column(String(10), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(254), nullable=True)


class Prescriber(Base):
    __tablename__ = "py_prescribers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100), index=True)
    practice_level: Mapped[str] = mapped_column(String(30))
    npi: Mapped[str | None] = mapped_column(String(20), nullable=True)
    dea: Mapped[str | None] = mapped_column(String(30), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    fax: Mapped[str | None] = mapped_column(String(50), nullable=True)


class Drug(Base):
    __tablename__ = "py_drugs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    name: Mapped[str] = mapped_column(String(200), index=True)
    strength: Mapped[str] = mapped_column(String(70))
    dosage_form: Mapped[str] = mapped_column(String(70))
    controlled: Mapped[bool] = mapped_column(Boolean, default=False)
    brand_name: Mapped[str | None] = mapped_column(String(180), nullable=True)
    route: Mapped[str | None] = mapped_column(String(80), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    controlled_substance_schedule: Mapped[str] = mapped_column(
        String(20), nullable=False, default="UNCLASSIFIED", server_default="UNCLASSIFIED")
    nc_narrow_therapeutic_index: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")
    is_biological: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")
    has_fda_interchangeable_biologic_alternative: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")
    requires_cold_chain: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")


class Product(Base):
    __tablename__ = "py_products"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    drug_id: Mapped[str] = mapped_column(ForeignKey("py_drugs.id"), index=True)
    ndc: Mapped[str] = mapped_column(String(30), unique=True)
    manufacturer: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(200))
    unit: Mapped[str] = mapped_column(String(10), default="each")
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=Decimal("0"))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    package_description: Mapped[str | None] = mapped_column(String(240), nullable=True)
    package_type: Mapped[str | None] = mapped_column(String(80), nullable=True)
    units_per_package: Mapped[Decimal | None] = mapped_column(Numeric(12, 3), nullable=True)
    package_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 4), nullable=True)
    therapeutic_equivalence_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    is_interchangeable_biological: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")
    __table_args__ = (
        CheckConstraint("units_per_package IS NULL OR units_per_package > 0",
                        name="ck_py_product_package_units_positive"),
        CheckConstraint("package_price IS NULL OR package_price >= 0",
                        name="ck_py_product_package_price_nonnegative"),
    )


class Barcode(Base):
    __tablename__ = "py_barcodes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    product_id: Mapped[str] = mapped_column(ForeignKey("py_products.id"))
    value: Mapped[str] = mapped_column(String(160), unique=True)


class Stock(Base):
    __tablename__ = "py_stock"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("py_products.id"))
    lot: Mapped[str] = mapped_column(String(100))
    expires: Mapped[str] = mapped_column(String(10))
    on_hand: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("0"))
    reserved: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("0"))
    quarantined: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("0"))
    location_tracking_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")
    __table_args__ = (
        UniqueConstraint("site_id", "product_id", "lot", "expires"),
        CheckConstraint("on_hand >= 0 AND reserved >= 0 AND quarantined >= 0"),
        CheckConstraint("reserved + quarantined <= on_hand"),
    )


class Prescription(Base):
    __tablename__ = "py_prescriptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("py_patients.id"))
    prescriber_id: Mapped[str] = mapped_column(ForeignKey("py_prescribers.id"))
    drug_id: Mapped[str] = mapped_column(ForeignKey("py_drugs.id"))
    rx_number: Mapped[str] = mapped_column(String(30))
    sig: Mapped[str] = mapped_column(Text)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    refills_allowed: Mapped[int] = mapped_column(Integer, default=0)
    refills_used: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(30), default="RECEIVED")
    held_from: Mapped[str | None] = mapped_column(String(30))
    do_not_fill_before: Mapped[str | None] = mapped_column(String(10))
    expiration_date: Mapped[str | None] = mapped_column(String(10))
    version: Mapped[int] = mapped_column(Integer, default=0)
    source_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="MANUAL", server_default="MANUAL")
    written_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    electronic_message_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    electronic_raw_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    prescribed_product_id: Mapped[str | None] = mapped_column(
        ForeignKey("py_products.id"), nullable=True)
    product_selection_directive: Mapped[str] = mapped_column(
        String(35), nullable=False, default="UNSPECIFIED", server_default="UNSPECIFIED")
    __table_args__ = (
        UniqueConstraint("site_id", "rx_number"),
        CheckConstraint("source_type IN ('MANUAL','PAPER','FAX','ELECTRONIC','VERBAL','TRANSFER')",
                        name="ck_py_rx_source_type"),
        CheckConstraint("product_selection_directive IN "
                        "('UNSPECIFIED','SELECTION_PERMITTED','DISPENSE_AS_WRITTEN')",
                        name="ck_py_rx_product_selection"),
        CheckConstraint("quantity > 0 AND refills_used >= 0 AND refills_allowed >= 0"),
    )


class DUR(Base):
    __tablename__ = "py_dur_issues"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), index=True)
    severity: Mapped[str] = mapped_column(String(20))
    code: Mapped[str] = mapped_column(String(70))
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    resolution: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("py_staff.id", name="fk_py_dur_resolved_by"))
    resolved_automatically: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")


class Fill(Base):
    __tablename__ = "py_fills"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), index=True)
    fill_number: Mapped[int] = mapped_column(Integer)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(30), default="PRODUCT_FILL")
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    billed_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    dispensed_in_original_container: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")
    patient_discard_date: Mapped[str | None] = mapped_column(String(10))
    packaging_reviewed_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id", name="fk_py_fills_packaging_reviewer"))
    packaging_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    packaging_note: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (UniqueConstraint("prescription_id", "fill_number", "attempt"),)


class FillSource(Base):
    __tablename__ = "py_fill_sources"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), index=True)
    stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    __table_args__ = (UniqueConstraint("fill_id", "stock_id"),)


class Claim(Base):
    __tablename__ = "py_claims"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), index=True)
    payer: Mapped[str] = mapped_column(String(120))
    sequence: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(25))
    billed_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    __table_args__ = (UniqueConstraint("fill_id", "sequence"),)


class Label(Base):
    __tablename__ = "py_labels"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), index=True)
    bottle_number: Mapped[int] = mapped_column(Integer)
    bottle_count: Mapped[int] = mapped_column(Integer)
    ndc: Mapped[str] = mapped_column(String(30))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    total: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    description: Mapped[str] = mapped_column(String(200))
    __table_args__ = (UniqueConstraint("fill_id", "bottle_number"),)


class WillCall(Base):
    __tablename__ = "py_will_call"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), unique=True)
    bag_barcode: Mapped[str] = mapped_column(String(100), unique=True)
    bin_name: Mapped[str] = mapped_column(String(60))
    status: Mapped[str] = mapped_column(String(20), default="STAGED")


class Sale(Base):
    __tablename__ = "py_sales"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), unique=True)
    verified_identity: Mapped[bool] = mapped_column(Boolean)
    signature_attested: Mapped[bool] = mapped_column(Boolean)
    tender: Mapped[str] = mapped_column(String(30))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))


class Audit(Base):
    __tablename__ = "py_audit"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    kind: Mapped[str] = mapped_column(String(90))
    subject_id: Mapped[str] = mapped_column(String(36))
    detail: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Document(Base):
    """Immutable source metadata; original bytes live in the local vault."""
    __tablename__ = "py_documents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("py_patients.id"))
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), index=True)
    source_type: Mapped[str] = mapped_column(String(25))
    mime_type: Mapped[str] = mapped_column(String(100))
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    storage_key: Mapped[str] = mapped_column(String(180), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int] = mapped_column(Integer)
    encrypted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (CheckConstraint("byte_size > 0 AND byte_size <= 26214400"),)


class DocumentAnnotation(Base):
    __tablename__ = "py_document_annotations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("py_documents.id"), index=True)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), index=True)
    text: Mapped[str] = mapped_column(Text)
    x: Mapped[Decimal] = mapped_column(Numeric(9, 6))
    y: Mapped[Decimal] = mapped_column(Numeric(9, 6))
    width: Mapped[Decimal] = mapped_column(Numeric(9, 6))
    height: Mapped[Decimal] = mapped_column(Numeric(9, 6))
    status: Mapped[str] = mapped_column(String(20), default="ACTIVE")
    supersedes_id: Mapped[str | None] = mapped_column(ForeignKey("py_document_annotations.id"), nullable=True, unique=True)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        CheckConstraint("x >= 0 AND y >= 0 AND width >= 0.01 AND height >= 0.01"),
        CheckConstraint("x + width <= 1.000001 AND y + height <= 1.000001"),
        CheckConstraint("status IN ('ACTIVE', 'SUPERSEDED')"),
    )


class DocumentChange(Base):
    """Separate legal/provenance record; DOES NOT mutate prescription fields."""
    __tablename__ = "py_document_changes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), index=True)
    annotation_id: Mapped[str] = mapped_column(ForeignKey("py_document_annotations.id"), unique=True)
    change_type: Mapped[str] = mapped_column(String(30))
    what_changed: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text)
    communication_method: Mapped[str | None] = mapped_column(String(20))
    contacted_party: Mapped[str | None] = mapped_column(String(200))
    authorizing_prescriber: Mapped[str | None] = mapped_column(String(200))
    note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="ACTIVE")
    supersedes_id: Mapped[str | None] = mapped_column(ForeignKey("py_document_changes.id"), nullable=True, unique=True)
    changed_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (CheckConstraint("status IN ('ACTIVE', 'SUPERSEDED')"),)


class InventoryMovement(Base):
    """Append-only synthetic per-stock inventory movement history."""
    __tablename__ = "py_inventory_movements"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    kind: Mapped[str] = mapped_column(String(35))
    on_hand_delta: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal('0'))
    reserved_delta: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal('0'))
    quarantined_delta: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal('0'))
    before_snapshot: Mapped[str] = mapped_column(Text)
    after_snapshot: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InventoryHold(Base):
    __tablename__ = "py_inventory_holds"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"), index=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(25), default="ACTIVE")
    recall_id: Mapped[str | None] = mapped_column(ForeignKey("py_recall_cases.id"), nullable=True, index=True)
    resolution_reason: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    resolved_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __table_args__ = (
        CheckConstraint("quantity > 0"),
        CheckConstraint("status IN ('ACTIVE','RELEASED','DISPOSED')"),
    )


class PurchaseOrder(Base):
    __tablename__ = "py_purchase_orders"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    vendor: Mapped[str] = mapped_column(String(180))
    reference: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(25), default="OPEN")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("site_id", "reference"),
        CheckConstraint("status IN ('OPEN','PARTIAL','RECEIVED','CANCELLED')"),
    )


class PurchaseOrderLine(Base):
    __tablename__ = "py_purchase_order_lines"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("py_purchase_orders.id"), index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("py_products.id"))
    ordered: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    received: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("0"))
    __table_args__ = (
        UniqueConstraint("order_id", "product_id"),
        CheckConstraint("ordered > 0 AND received >= 0 AND received <= ordered"),
    )


class PurchaseOrderReceipt(Base):
    __tablename__ = "py_purchase_order_receipts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    line_id: Mapped[str] = mapped_column(ForeignKey("py_purchase_order_lines.id"), index=True)
    stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    invoice: Mapped[str] = mapped_column(String(140))
    received_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (CheckConstraint("quantity > 0"),)


class InventoryTransfer(Base):
    __tablename__ = "py_inventory_transfers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    from_site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    to_site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    source_stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"))
    received_stock_id: Mapped[str | None] = mapped_column(ForeignKey("py_stock.id"), nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    status: Mapped[str] = mapped_column(String(25), default="IN_TRANSIT")
    reason: Mapped[str] = mapped_column(Text)
    shipped_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    closed_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __table_args__ = (
        CheckConstraint("quantity > 0"),
        CheckConstraint("from_site_id <> to_site_id"),
        CheckConstraint("status IN ('IN_TRANSIT','RECEIVED','CANCELLED')"),
    )


class CycleCountSession(Base):
    __tablename__ = "py_cycle_count_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    status: Mapped[str] = mapped_column(String(25), default="OPEN")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    reviewed_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"), nullable=True)
    review_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (CheckConstraint("status IN ('OPEN','SUBMITTED','APPROVED','REJECTED')"),)


class CycleCountLine(Base):
    __tablename__ = "py_cycle_count_lines"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    session_id: Mapped[str] = mapped_column(ForeignKey("py_cycle_count_sessions.id"), index=True)
    stock_id: Mapped[str] = mapped_column(ForeignKey("py_stock.id"), index=True)
    counted_on_hand: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    baseline_on_hand: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    baseline_reserved: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    baseline_quarantined: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    movement_count: Mapped[int] = mapped_column(Integer)
    counted_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    __table_args__ = (
        UniqueConstraint("session_id", "stock_id"),
        CheckConstraint("counted_on_hand >= 0 AND baseline_on_hand >= 0 AND movement_count >= 0"),
    )


class RecallCase(Base):
    __tablename__ = "py_recall_cases"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("py_products.id"), index=True)
    lot: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reference: Mapped[str] = mapped_column(String(140))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(25), default="ACTIVE")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"))
    closed_by_id: Mapped[str | None] = mapped_column(ForeignKey("py_staff.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __table_args__ = (
        UniqueConstraint("site_id", "reference"),
        CheckConstraint("status IN ('ACTIVE','CLOSED')"),
    )


class RecallExposure(Base):
    """Historical fills affected at recall discovery; must not be erased on closure."""
    __tablename__ = "py_recall_exposures"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    recall_id: Mapped[str] = mapped_column(ForeignKey("py_recall_cases.id"), index=True)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"))
    status_at_discovery: Mapped[str] = mapped_column(String(30))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (UniqueConstraint("recall_id", "fill_id"),)
