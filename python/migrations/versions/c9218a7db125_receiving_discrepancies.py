"""Synthetic receiving discrepancy register and append-only investigation history.

Revision ID: c9218a7db125
Revises: a5e618d4b92f

No original Prisma data modified, no inferred historical discrepancy cases.
"""
from alembic import op
import sqlalchemy as sa

revision = "c9218a7db125"
down_revision = "a5e618d4b92f"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_receiving_discrepancies",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="OPEN"),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("py_purchase_orders.id")),
        sa.Column("purchase_order_line_id", sa.String(36), sa.ForeignKey("py_purchase_order_lines.id")),
        sa.Column("receipt_id", sa.String(36), sa.ForeignKey("py_purchase_order_receipts.id")),
        sa.Column("expected_product_id", sa.String(36), sa.ForeignKey("py_products.id")),
        sa.Column("observed_product_id", sa.String(36), sa.ForeignKey("py_products.id")),
        sa.Column("expected_quantity", sa.Numeric(12, 3)),
        sa.Column("observed_quantity", sa.Numeric(12, 3)),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("evidence_reference", sa.String(250)),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_by_id", sa.String(36), sa.ForeignKey("py_staff.id")),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.Column("resolution_note", sa.Text()),
        sa.Column("adjustment_movement_id", sa.String(36),
                  sa.ForeignKey("py_inventory_movements.id"), unique=True),
        sa.CheckConstraint("status IN ('OPEN','RESOLVED')",
                           name="ck_py_receiving_discrepancy_status"),
        sa.CheckConstraint("type IN ('SHORT_SHIPMENT','OVERAGE','WRONG_PRODUCT','DAMAGED_PRODUCT',"
                           "'LOT_EXPIRATION_MISMATCH','INVOICE_MISMATCH','DUPLICATE_SHIPMENT',"
                           "'UNEXPECTED_PRODUCT','OTHER')", name="ck_py_receiving_discrepancy_type"),
        sa.CheckConstraint("expected_quantity IS NULL OR expected_quantity >= 0",
                           name="ck_py_receiving_expected_nonnegative"),
        sa.CheckConstraint("observed_quantity IS NULL OR observed_quantity >= 0",
                           name="ck_py_receiving_observed_nonnegative"),
    )
    for name in ("site_id", "receipt_id"):
        op.create_index(f"ix_py_receiving_discrepancies_{name}",
                        "py_receiving_discrepancies", [name])
    op.create_table("py_receiving_discrepancy_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("discrepancy_id", sa.String(36),
                  sa.ForeignKey("py_receiving_discrepancies.id"), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("prior_status", sa.String(12)),
        sa.Column("next_status", sa.String(12), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("adjustment_movement_id", sa.String(36),
                  sa.ForeignKey("py_inventory_movements.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("next_status IN ('OPEN','RESOLVED')",
                           name="ck_py_receiving_event_status"),
    )
    for name in ("site_id", "discrepancy_id"):
        op.create_index(f"ix_py_receiving_discrepancy_events_{name}",
                        "py_receiving_discrepancy_events", [name])


def downgrade():
    raise RuntimeError("Receiving discrepancy investigation and resolution history must not be discarded")
