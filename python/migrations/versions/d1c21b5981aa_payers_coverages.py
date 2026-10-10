"""Create synthetic payer, coverage and immutable per-claim coverage lineage.

Revision ID: d1c21b5981aa
Revises: 60a79f2cc141

Isolated py_* only, no actual insurance transport, no Prisma changes.
"""
from alembic import op
import sqlalchemy as sa

revision = "d1c21b5981aa"
down_revision = "60a79f2cc141"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "py_insurance_payers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("bin", sa.String(12)),
        sa.Column("pcn", sa.String(40)),
        sa.Column("default_group_id", sa.String(100)),
        sa.Column("claim_standard", sa.String(2), nullable=False, server_default="D0"),
        sa.Column("billing_ndc_strategy", sa.String(30), nullable=False,
                  server_default="MAJORITY_SOURCE"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("site_id", "name", name="uq_py_insurance_payer_site_name"),
        sa.CheckConstraint("claim_standard IN ('D0','F6')",
                           name="ck_py_insurance_claim_standard"),
        sa.CheckConstraint("billing_ndc_strategy IN "
                           "('MAJORITY_SOURCE','REQUIRE_MANUAL_SELECTION','SINGLE_SOURCE_ONLY','PAYER_CONFIGURED')",
                           name="ck_py_insurance_ndc_strategy"),
    )
    op.create_index("ix_py_insurance_payers_site_id", "py_insurance_payers", ["site_id"])

    op.create_table(
        "py_patient_coverages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("patient_id", sa.String(36), sa.ForeignKey("py_patients.id"), nullable=False),
        sa.Column("payer_id", sa.String(36), sa.ForeignKey("py_insurance_payers.id"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("member_id", sa.String(150), nullable=False),
        sa.Column("person_code", sa.String(30)),
        sa.Column("group_id", sa.String(100)),
        sa.Column("relationship", sa.String(10), nullable=False, server_default="SELF"),
        sa.Column("cardholder_name", sa.String(200)),
        sa.Column("cardholder_date_of_birth", sa.String(10)),
        sa.Column("effective_date", sa.String(10)),
        sa.Column("termination_date", sa.String(10)),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("patient_id", "position", name="uq_py_patient_coverage_position"),
        sa.CheckConstraint("position BETWEEN 1 AND 4", name="ck_py_patient_coverage_position"),
        sa.CheckConstraint("relationship IN ('SELF','SPOUSE','CHILD','OTHER')",
                           name="ck_py_patient_coverage_relationship"),
    )
    for suffix, field in (
        ("site_id", "site_id"), ("patient_id", "patient_id"), ("payer_id", "payer_id")
    ):
        op.create_index(f"ix_py_patient_coverages_{suffix}",
                        "py_patient_coverages", [field])

    op.create_table(
        "py_claim_coverage_snapshots",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("claim_id", sa.String(36), sa.ForeignKey("py_claims.id"), unique=True, nullable=False),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False),
        sa.Column("coverage_id", sa.String(36),
                  sa.ForeignKey("py_patient_coverages.id"), nullable=False),
        sa.Column("payer_id", sa.String(36), sa.ForeignKey("py_insurance_payers.id"), nullable=False),
        sa.Column("coverage_position", sa.Integer(), nullable=False),
        sa.Column("payer_name_snapshot", sa.String(120), nullable=False),
        sa.Column("member_id_snapshot", sa.String(150), nullable=False),
        sa.Column("group_id_snapshot", sa.String(100)),
        sa.Column("person_code_snapshot", sa.String(30)),
        sa.Column("claim_standard_snapshot", sa.String(2), nullable=False),
        sa.Column("billing_strategy_snapshot", sa.String(30), nullable=False),
        sa.Column("intended_quantity_snapshot", sa.String(40), nullable=False),
        sa.Column("physical_quantity_snapshot", sa.String(40), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("coverage_position BETWEEN 1 AND 4",
                           name="ck_py_claim_coverage_position"),
    )
    for suffix, field in (
        ("site_id", "site_id"), ("fill_id", "fill_id"), ("coverage_id", "coverage_id")
    ):
        op.create_index(f"ix_py_claim_coverage_snapshots_{suffix}",
                        "py_claim_coverage_snapshots", [field])


def downgrade():
    raise RuntimeError("Cannot erase payer/coverage financial provenance through a downgrade")
