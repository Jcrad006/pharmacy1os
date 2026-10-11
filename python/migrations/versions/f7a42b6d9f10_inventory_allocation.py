"""Add fill-scoped physical allocations and append-only status audit.

Revision ID: f7a42b6d9f10
Revises: f29a4d5c38a1

No existing sources get fabricated allocations. Only later location-confirmed
source scans create allocations; historical fills remain legacy/unlinked.
"""
from alembic import op
import sqlalchemy as sa

revision = "f7a42b6d9f10"
down_revision = "f29a4d5c38a1"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_inventory_allocations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False),
        sa.Column("stock_id", sa.String(36), sa.ForeignKey("py_stock.id"), nullable=False),
        sa.Column("fill_source_id", sa.String(36),
                  sa.ForeignKey("py_fill_sources.id", ondelete="SET NULL"), nullable=True),
        sa.Column("position_id", sa.String(36),
                  sa.ForeignKey("py_inventory_stock_positions.id"), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="ACTIVE"),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.Column("resolution_reason", sa.Text()),
        sa.UniqueConstraint("fill_source_id", name="uq_py_allocation_fill_source"),
        sa.CheckConstraint("quantity > 0", name="ck_py_allocation_positive"),
        sa.CheckConstraint("status IN ('ACTIVE','CONSUMED','RELEASED')",
                           name="ck_py_allocation_status"))
    for key in ("site_id", "fill_id", "stock_id", "fill_source_id", "position_id"):
        op.create_index(f"ix_py_inventory_allocations_{key}",
                        "py_inventory_allocations", [key])

    op.create_table("py_inventory_allocation_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("allocation_id", sa.String(36),
                  sa.ForeignKey("py_inventory_allocations.id"), nullable=False),
        sa.Column("from_status", sa.String(20)),
        sa.Column("to_status", sa.String(20), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("to_status IN ('ACTIVE','CONSUMED','RELEASED')",
                           name="ck_py_allocation_event_status"))
    for key in ("site_id", "allocation_id"):
        op.create_index(f"ix_py_inventory_allocation_events_{key}",
                        "py_inventory_allocation_events", [key])


def downgrade():
    raise RuntimeError("Physical allocation and dispensing history may not be deleted")
