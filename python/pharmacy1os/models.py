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


class Product(Base):
    __tablename__ = "py_products"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    drug_id: Mapped[str] = mapped_column(ForeignKey("py_drugs.id"), index=True)
    ndc: Mapped[str] = mapped_column(String(30), unique=True)
    manufacturer: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(200))
    unit: Mapped[str] = mapped_column(String(10), default="each")
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=Decimal("0"))


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
    __table_args__ = (
        UniqueConstraint("site_id", "rx_number"),
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


class Fill(Base):
    __tablename__ = "py_fills"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    prescription_id: Mapped[str] = mapped_column(ForeignKey("py_prescriptions.id"), index=True)
    fill_number: Mapped[int] = mapped_column(Integer)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(30), default="PRODUCT_FILL")
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    billed_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
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
