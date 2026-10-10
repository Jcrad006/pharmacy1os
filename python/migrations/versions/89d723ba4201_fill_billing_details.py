"""Synthetic per-fill billing inputs.

Revision ID: 89d723ba4201
Revises: d7f2e57b8c94
"""
from alembic import op
import sqlalchemy as sa

revision = "89d723ba4201"
down_revision = "d7f2e57b8c94"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("py_fills") as batch:
        batch.add_column(sa.Column("days_supply", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("billing_product_id", sa.String(36), nullable=True))
        batch.create_foreign_key("fk_py_fills_billing_product", "py_products",
                                 ["billing_product_id"], ["id"])


def downgrade():
    raise RuntimeError("Do not silently erase synthetic fill billing provenance")
