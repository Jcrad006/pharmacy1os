"""Opt-in physical inventory locations and reconciled stock positions.

Revision ID: f29a4d5c38a1
Revises: e48f2d6a47cb
"""
from alembic import op
import sqlalchemy as sa

revision = "f29a4d5c38a1"
down_revision = "e48f2d6a47cb"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("py_stock", sa.Column("location_tracking_enabled", sa.Boolean(),
                  nullable=False, server_default=sa.text("false")))
    op.create_table("py_inventory_locations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("code", sa.String(48), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("type", sa.String(30), nullable=False),
        sa.Column("barcode", sa.String(100)),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_default_receiving", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_default_dispensing", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_quarantine", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("temperature_min_c", sa.Numeric(6, 2)),
        sa.Column("temperature_max_c", sa.Numeric(6, 2)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("site_id", "code", name="uq_py_location_site_code"),
        sa.UniqueConstraint("site_id", "barcode", name="uq_py_location_site_barcode"),
        sa.CheckConstraint("type IN ('SHELF','BIN','REFRIGERATOR','FREEZER','SAFE','RECEIVING',"
                           "'QUARANTINE','RETURN_TO_VENDOR','WILL_CALL','OTHER')",
                           name="ck_py_location_type"),
        sa.CheckConstraint("temperature_min_c IS NULL OR temperature_max_c IS NULL "
                           "OR temperature_min_c <= temperature_max_c",
                           name="ck_py_location_temp_range"))
    op.create_index("ix_py_inventory_locations_site_id", "py_inventory_locations", ["site_id"])
    op.create_table("py_inventory_stock_positions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("stock_id", sa.String(36), sa.ForeignKey("py_stock.id"), nullable=False),
        sa.Column("location_id", sa.String(36), sa.ForeignKey("py_inventory_locations.id"), nullable=False),
        sa.Column("available", sa.Numeric(12, 3), nullable=False, server_default="0"),
        sa.Column("reserved", sa.Numeric(12, 3), nullable=False, server_default="0"),
        sa.Column("quarantined", sa.Numeric(12, 3), nullable=False, server_default="0"),
        sa.UniqueConstraint("stock_id", "location_id", name="uq_py_position_stock_location"),
        sa.CheckConstraint("available >= 0 AND reserved >= 0 AND quarantined >= 0",
                           name="ck_py_position_nonnegative"))
    op.create_index("ix_py_inventory_stock_positions_stock_id", "py_inventory_stock_positions", ["stock_id"])
    op.create_index("ix_py_inventory_stock_positions_location_id", "py_inventory_stock_positions", ["location_id"])
    op.create_table("py_inventory_position_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("stock_id", sa.String(36), sa.ForeignKey("py_stock.id"), nullable=False),
        sa.Column("from_location_id", sa.String(36),
                  sa.ForeignKey("py_inventory_locations.id")),
        sa.Column("to_location_id", sa.String(36),
                  sa.ForeignKey("py_inventory_locations.id")),
        sa.Column("event_type", sa.String(35), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("state", sa.String(25), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_py_pos_event_positive"),
        sa.CheckConstraint("state IN ('AVAILABLE','RESERVED','QUARANTINED')",
                           name="ck_py_pos_event_state"))
    op.create_index("ix_py_inventory_position_events_site_id", "py_inventory_position_events", ["site_id"])
    op.create_index("ix_py_inventory_position_events_stock_id", "py_inventory_position_events", ["stock_id"])


def downgrade():
    raise RuntimeError("Physical location custody history must not be discarded")
