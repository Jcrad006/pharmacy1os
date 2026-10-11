"""Persist synthetic inventory exception lifecycle and append-only events.

Revision ID: e41cd17a9203
Revises: c9218a7db125

New py_* tables only; no legacy import and no fabricated old exceptions.
"""
from alembic import op
import sqlalchemy as sa

revision = "e41cd17a9203"
down_revision = "c9218a7db125"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_inventory_exceptions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("fingerprint", sa.String(200), nullable=False),
        sa.Column("type", sa.String(40), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="OPEN"),
        sa.Column("severity", sa.String(10), nullable=False, server_default="WARNING"),
        sa.Column("entity_type", sa.String(40), nullable=False),
        sa.Column("entity_id", sa.String(36)),
        sa.Column("title", sa.String(250), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("first_detected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_detected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("acknowledged_by_id", sa.String(36), sa.ForeignKey("py_staff.id")),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True)),
        sa.Column("resolved_by_id", sa.String(36), sa.ForeignKey("py_staff.id")),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.Column("resolution_note", sa.Text()),
        sa.UniqueConstraint("site_id", "fingerprint", name="uq_py_inventory_exception_fingerprint"),
        sa.CheckConstraint("status IN ('OPEN','ACKNOWLEDGED','RESOLVED')",
                           name="ck_py_exception_status"),
        sa.CheckConstraint("severity IN ('INFO','WARNING','HIGH')",
                           name="ck_py_exception_severity"),
        sa.CheckConstraint("type IN ('BELOW_REORDER_POINT','EXPIRING_SOON','STALE_RESERVATION',"
                           "'TRANSFER_STUCK','PURCHASE_ORDER_OVERDUE','UNALLOCATED_DEMAND',"
                           "'POSITION_IMBALANCE','MISSING_ACQUISITION_COST',"
                           "'PHYSICAL_STOCK_SHORTAGE')", name="ck_py_exception_type"),
    )
    op.create_index("ix_py_inventory_exceptions_site_id",
                    "py_inventory_exceptions", ["site_id"])
    op.create_table("py_inventory_exception_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("exception_id", sa.String(36),
                  sa.ForeignKey("py_inventory_exceptions.id"), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("operation", sa.String(25), nullable=False),
        sa.Column("previous_status", sa.String(16)),
        sa.Column("next_status", sa.String(16), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("next_status IN ('OPEN','ACKNOWLEDGED','RESOLVED')",
                           name="ck_py_exception_event_status"),
    )
    for field in ("site_id", "exception_id"):
        op.create_index(f"ix_py_inventory_exception_events_{field}",
                        "py_inventory_exception_events", [field])


def downgrade():
    raise RuntimeError("Inventory exception investigations and acknowledgement history must not be discarded")
