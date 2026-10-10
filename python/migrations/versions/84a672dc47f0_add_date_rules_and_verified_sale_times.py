"""Add Rx interval rules and verified pickup events; synthetic Python schema only.

Revision ID: 84a672dc47f0
Revises: 56b4b973cdea
"""
from alembic import op
import sqlalchemy as sa
revision = "84a672dc47f0"
down_revision = "56b4b973cdea"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("py_rx_date_policies",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("prescription_id", sa.String(36), sa.ForeignKey("py_prescriptions.id"), nullable=False, unique=True),
        sa.Column("minimum_days_between_fills", sa.Integer(), nullable=False),
        sa.Column("updated_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("minimum_days_between_fills BETWEEN 0 AND 365", name="ck_py_rx_date_interval"))
    op.create_index("ix_py_rx_date_policies_site_id", "py_rx_date_policies", ["site_id"])
    op.create_table("py_fill_sale_timestamps",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False, unique=True),
        sa.Column("sold_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("sold_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_py_fill_sale_timestamps_site_id", "py_fill_sale_timestamps", ["site_id"])

def downgrade():
    raise RuntimeError("Historical sale times and clinical restrictions require reviewed recovery; destructive downgrade blocked")
