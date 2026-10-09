"""Synthetic append-only claims, stable payer profile identity.

Revision ID: e48f2d6a47cb
Revises: d1c21b5981aa
"""
from alembic import op
import sqlalchemy as sa

revision = "e48f2d6a47cb"
down_revision = "d1c21b5981aa"
branch_labels = None
depends_on = None


def upgrade():
    # SQLite requires an inline REFERENCES clause for ALTER ADD COLUMN.
    if op.get_bind().dialect.name == "sqlite":
        op.execute("ALTER TABLE py_payer_billing_profiles ADD COLUMN "
                   "payer_id VARCHAR(36) REFERENCES py_insurance_payers (id)")
    else:
        op.add_column("py_payer_billing_profiles",
            sa.Column("payer_id", sa.String(36),
                      sa.ForeignKey("py_insurance_payers.id"), nullable=True))
    op.create_index("ix_py_payer_billing_profiles_payer_id",
                    "py_payer_billing_profiles", ["payer_id"])
    op.create_table(
        "py_sandbox_claim_transactions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False),
        sa.Column("claim_id", sa.String(36), sa.ForeignKey("py_claims.id"), nullable=True),
        sa.Column("payer_id", sa.String(36), sa.ForeignKey("py_insurance_payers.id")),
        sa.Column("coverage_id", sa.String(36), sa.ForeignKey("py_patient_coverages.id")),
        sa.Column("original_transaction_id", sa.String(36),
                  sa.ForeignKey("py_sandbox_claim_transactions.id")),
        sa.Column("operation", sa.String(24), nullable=False),
        sa.Column("outcome", sa.String(26), nullable=False),
        sa.Column("idempotency_key", sa.String(160), unique=True, nullable=False),
        sa.Column("request_json", sa.Text(), nullable=False),
        sa.Column("response_json", sa.Text(), nullable=False),
        sa.Column("request_sha256", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("original_transaction_id", "operation",
                            name="uq_py_sandbox_claim_original_operation"),
        sa.CheckConstraint("operation IN ('BILL','REVERSE','TEST_REJECT','TEST_RESOLVE')",
                           name="ck_py_sandbox_claim_operation"),
        sa.CheckConstraint("outcome IN ('PAID_SYNTHETIC','REVERSED_SYNTHETIC',"
                           "'REJECTED_SYNTHETIC','CLEARED_TEST_HOLD')",
                           name="ck_py_sandbox_claim_outcome"),
    )
    for col in ("site_id", "fill_id", "claim_id"):
        op.create_index(f"ix_py_sandbox_claim_transactions_{col}",
                        "py_sandbox_claim_transactions", [col])
    op.create_index("ix_py_sandbox_claim_site_operation", "py_sandbox_claim_transactions",
                    ["site_id", "operation"])


def downgrade():
    raise RuntimeError("Immutable insurance operation history may not be discarded")
