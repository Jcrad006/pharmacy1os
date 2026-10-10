"""Site-scoped, opt-in physical product FEFO scan safeguards.

Revision ID: c8f20b42d531
Revises: b7e362a05c91
"""
from alembic import op
import sqlalchemy as sa

revision = "c8f20b42d531"
down_revision = "b7e362a05c91"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_fefo_policies",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("py_products.id"), nullable=False),
        sa.Column("mode", sa.String(20), nullable=False),
        sa.Column("minimum_shelf_life_days", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.UniqueConstraint("site_id", "product_id", name="uq_py_fefo_site_product"),
        sa.CheckConstraint("mode IN ('ADVISORY','ENFORCE')", name="ck_py_fefo_mode"),
        sa.CheckConstraint("minimum_shelf_life_days BETWEEN 0 AND 3650",
                           name="ck_py_fefo_shelf_days"))
    op.create_index("ix_py_fefo_policies_site_id", "py_fefo_policies", ["site_id"])
    op.create_index("ix_py_fefo_policies_product_id", "py_fefo_policies", ["product_id"])


def downgrade():
    raise RuntimeError("Active pharmacist FEFO policy safeguards must not be dropped silently")
