"""Add synthetic-only site-scoped replenishment thresholds.

Revision ID: e2a9401f67c3
Revises: a7e4c129ad67
This revision does not access or modify legacy Prisma tables.
"""
from alembic import op
import sqlalchemy as sa

revision = "e2a9401f67c3"
down_revision = "a7e4c129ad67"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "py_reorder_policies",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("py_products.id"), nullable=False),
        sa.Column("minimum", sa.Numeric(12, 3), nullable=False),
        sa.Column("target", sa.Numeric(12, 3), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("site_id", "product_id", name="uq_py_reorder_site_product"),
        sa.CheckConstraint("minimum >= 0 AND target > minimum", name="ck_py_reorder_bounds"),
    )
    op.create_index("ix_py_reorder_policies_site_id", "py_reorder_policies", ["site_id"])


def downgrade() -> None:
    raise RuntimeError("Destructive downgrade of reorder policy/audit records is not supported")
