"""Add synthetic Will Call barcode custody and history.

Revision ID: 7c91d1e71f32
Revises: fe722c185f29
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "7c91d1e71f32"
down_revision: Union[str, Sequence[str], None] = "fe722c185f29"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    op.create_table(
        "py_will_call_barcode_records",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("site_id", sa.String(36), nullable=False),
        sa.Column("fill_id", sa.String(36), nullable=False),
        sa.Column("barcode", sa.String(100), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("assigned_by_id", sa.String(36), nullable=False),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("retired_by_id", sa.String(36), nullable=True),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('ACTIVE', 'RETIRED', 'CLOSED')", name="ck_py_wcb_state"),
        sa.ForeignKeyConstraint(["site_id"], ["py_sites.id"]),
        sa.ForeignKeyConstraint(["fill_id"], ["py_fills.id"]),
        sa.ForeignKeyConstraint(["assigned_by_id"], ["py_staff.id"]),
        sa.ForeignKeyConstraint(["retired_by_id"], ["py_staff.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("barcode"),
    )
    op.create_index("ix_py_will_call_barcode_records_site_id", "py_will_call_barcode_records", ["site_id"])
    op.create_index("ix_py_will_call_barcode_records_fill_id", "py_will_call_barcode_records", ["fill_id"])
    op.create_index("ix_py_wcb_site_fill", "py_will_call_barcode_records", ["site_id", "fill_id"])
    op.create_table(
        "py_will_call_custody_events",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("site_id", sa.String(36), nullable=False),
        sa.Column("fill_id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("old_barcode", sa.String(100), nullable=True),
        sa.Column("new_barcode", sa.String(100), nullable=True),
        sa.Column("old_bin", sa.String(60), nullable=True),
        sa.Column("new_bin", sa.String(60), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.String(36), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('STAGED','REBAGGED','RELOCATED','SOLD','RETURNED')", name="ck_py_wc_event_kind"),
        sa.ForeignKeyConstraint(["site_id"], ["py_sites.id"]),
        sa.ForeignKeyConstraint(["fill_id"], ["py_fills.id"]),
        sa.ForeignKeyConstraint(["actor_id"], ["py_staff.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_py_will_call_custody_events_site_id", "py_will_call_custody_events", ["site_id"])
    op.create_index("ix_py_will_call_custody_events_fill_id", "py_will_call_custody_events", ["fill_id"])
    op.create_index("ix_py_wc_event_site_fill", "py_will_call_custody_events", ["site_id", "fill_id"])

def downgrade() -> None:
    raise RuntimeError("Will Call custody records cannot be automatically discarded")
