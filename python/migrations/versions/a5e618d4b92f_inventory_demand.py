"""Add opt-in synthetic demand and backorder reconciliation entities.

Revision ID: a5e618d4b92f
Revises: f7a42b6d9f10

Does not modify legacy Prisma data or retroactively invent historical demands.
"""
from alembic import op
import sqlalchemy as sa

revision = "a5e618d4b92f"
down_revision = "f7a42b6d9f10"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_inventory_demands",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("drug_id", sa.String(36), sa.ForeignKey("py_drugs.id"), nullable=False),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("py_products.id")),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), unique=True),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("required_quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("available_quantity", sa.Numeric(12, 3), nullable=False, server_default="0"),
        sa.Column("status", sa.String(15), nullable=False, server_default="OPEN"),
        sa.Column("needed_by", sa.String(10)),
        sa.Column("note", sa.Text()),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("fulfilled_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("source IN ('FILL','COMPLETION','REORDER','MANUAL')",
                           name="ck_py_demand_source"),
        sa.CheckConstraint("status IN ('OPEN','READY','FULFILLED','CANCELLED')",
                           name="ck_py_demand_status"),
        sa.CheckConstraint("required_quantity > 0 AND available_quantity >= 0",
                           name="ck_py_demand_quantities"),
    )
    for field in ("site_id", "drug_id", "product_id"):
        op.create_index(f"ix_py_inventory_demands_{field}", "py_inventory_demands", [field])
    op.create_table("py_inventory_demand_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("demand_id", sa.String(36), sa.ForeignKey("py_inventory_demands.id"), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("operation", sa.String(32), nullable=False),
        sa.Column("previous_status", sa.String(15)),
        sa.Column("next_status", sa.String(15), nullable=False),
        sa.Column("required_quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("available_quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("next_status IN ('OPEN','READY','FULFILLED','CANCELLED')",
                           name="ck_py_demand_event_status"),
    )
    for field in ("site_id", "demand_id"):
        op.create_index(f"ix_py_inventory_demand_events_{field}",
                        "py_inventory_demand_events", [field])


def downgrade():
    raise RuntimeError("Demand and pharmacist stock-availability history must not be discarded")
