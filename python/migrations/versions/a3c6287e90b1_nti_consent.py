"""Synthetic, site-scoped NTI manufacturer-change attestation ledger.

Revision ID: a3c6287e90b1
Revises: f2a19480c63e
"""
from alembic import op
import sqlalchemy as sa

revision = "a3c6287e90b1"
down_revision = "f2a19480c63e"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_nti_manufacturer_consents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False),
        sa.Column("prior_manufacturer", sa.String(120), nullable=False),
        sa.Column("new_manufacturer", sa.String(120), nullable=False),
        sa.Column("prescriber_consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("patient_consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("documented_by_id", sa.String(36), sa.ForeignKey("py_staff.id"),
                  nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("fill_id", "prior_manufacturer", "new_manufacturer",
            name="uq_py_nti_fill_manufacturer_pair"),
        sa.CheckConstraint("prior_manufacturer <> new_manufacturer",
            name="ck_py_nti_different_manufacturers"),
        sa.CheckConstraint("length(trim(note)) BETWEEN 12 AND 2000",
            name="ck_py_nti_documentation_note"))
    op.create_index("ix_py_nti_manufacturer_consents_site_id",
                    "py_nti_manufacturer_consents", ["site_id"])
    op.create_index("ix_py_nti_manufacturer_consents_fill_id",
                    "py_nti_manufacturer_consents", ["fill_id"])
    op.create_index("ix_py_nti_site_fill", "py_nti_manufacturer_consents",
                    ["site_id", "fill_id"])


def downgrade():
    raise RuntimeError("NTI pharmacist consent attestation history must not be deleted by downgrade")
