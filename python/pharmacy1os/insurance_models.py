"""Site-scoped synthetic insurance payer, patient coverage and claim provenance.

Port of the core Payer/PatientCoverage *data shape* from Prisma. This never
performs payer eligibility, COB payment coordination, or NCPDP transmission.
"""
from __future__ import annotations
from datetime import datetime
from sqlalchemy import (
    Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text,
    UniqueConstraint, Index,
)
from sqlalchemy.orm import Mapped, mapped_column
from .models import Base, uuid, utcnow


class InsurancePayer(Base):
    __tablename__ = "py_insurance_payers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    bin: Mapped[str | None] = mapped_column(String(12))
    pcn: Mapped[str | None] = mapped_column(String(40))
    default_group_id: Mapped[str | None] = mapped_column(String(100))
    claim_standard: Mapped[str] = mapped_column(String(2), nullable=False, default="D0", server_default="D0")
    billing_ndc_strategy: Mapped[str] = mapped_column(
        String(30), nullable=False, default="MAJORITY_SOURCE", server_default="MAJORITY_SOURCE")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("site_id", "name", name="uq_py_insurance_payer_site_name"),
        CheckConstraint("claim_standard IN ('D0','F6')", name="ck_py_insurance_claim_standard"),
        CheckConstraint("billing_ndc_strategy IN "
                        "('MAJORITY_SOURCE','REQUIRE_MANUAL_SELECTION','SINGLE_SOURCE_ONLY','PAYER_CONFIGURED')",
                        name="ck_py_insurance_ndc_strategy"),
    )


class PatientCoverage(Base):
    __tablename__ = "py_patient_coverages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("py_patients.id"), nullable=False, index=True)
    payer_id: Mapped[str] = mapped_column(ForeignKey("py_insurance_payers.id"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    member_id: Mapped[str] = mapped_column(String(150), nullable=False)
    person_code: Mapped[str | None] = mapped_column(String(30))
    group_id: Mapped[str | None] = mapped_column(String(100))
    relationship: Mapped[str] = mapped_column(String(10), nullable=False, default="SELF", server_default="SELF")
    cardholder_name: Mapped[str | None] = mapped_column(String(200))
    cardholder_date_of_birth: Mapped[str | None] = mapped_column(String(10))
    effective_date: Mapped[str | None] = mapped_column(String(10))
    termination_date: Mapped[str | None] = mapped_column(String(10))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("patient_id", "position", name="uq_py_patient_coverage_position"),
        CheckConstraint("position BETWEEN 1 AND 4", name="ck_py_patient_coverage_position"),
        CheckConstraint("relationship IN ('SELF','SPOUSE','CHILD','OTHER')",
                        name="ck_py_patient_coverage_relationship"),
    )


class ClaimCoverageSnapshot(Base):
    """Immutable claim→coverage lineage; separate from the legacy sandbox claim."""
    __tablename__ = "py_claim_coverage_snapshots"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    claim_id: Mapped[str] = mapped_column(ForeignKey("py_claims.id"), unique=True, nullable=False)
    fill_id: Mapped[str] = mapped_column(ForeignKey("py_fills.id"), nullable=False, index=True)
    coverage_id: Mapped[str] = mapped_column(
        ForeignKey("py_patient_coverages.id"), nullable=False, index=True)
    payer_id: Mapped[str] = mapped_column(ForeignKey("py_insurance_payers.id"), nullable=False)
    coverage_position: Mapped[int] = mapped_column(Integer, nullable=False)
    payer_name_snapshot: Mapped[str] = mapped_column(String(120), nullable=False)
    member_id_snapshot: Mapped[str] = mapped_column(String(150), nullable=False)
    group_id_snapshot: Mapped[str | None] = mapped_column(String(100))
    person_code_snapshot: Mapped[str | None] = mapped_column(String(30))
    claim_standard_snapshot: Mapped[str] = mapped_column(String(2), nullable=False)
    billing_strategy_snapshot: Mapped[str] = mapped_column(String(30), nullable=False)
    intended_quantity_snapshot: Mapped[str] = mapped_column(String(40), nullable=False)
    physical_quantity_snapshot: Mapped[str] = mapped_column(String(40), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    __table_args__ = (
        CheckConstraint("coverage_position BETWEEN 1 AND 4",
                        name="ck_py_claim_coverage_position"),
    )
