"""Restore foundational legacy prescription/source and product/catalog fields.

Revision ID: c6d923e46a10
Revises: a8f167bf70d2
Only synthetic py_* tables. No Prisma data is modified.
Existing records receive conservative UNCLASSIFIED control schedule,
MANUAL source and UNSPECIFIED selection values; no legal inference.
"""
from alembic import op
import sqlalchemy as sa

revision = "c6d923e46a10"
down_revision = "a8f167bf70d2"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("py_patients", sa.Column("email", sa.String(254), nullable=True))
    for column in (
        sa.Column("brand_name", sa.String(180)),
        sa.Column("route", sa.String(80)),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("controlled_substance_schedule", sa.String(20), nullable=False,
                  server_default="UNCLASSIFIED"),
        sa.Column("nc_narrow_therapeutic_index", sa.Boolean(), nullable=False,
                  server_default=sa.text("false")),
        sa.Column("is_biological", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("has_fda_interchangeable_biologic_alternative", sa.Boolean(),
                  nullable=False, server_default=sa.text("false")),
        sa.Column("requires_cold_chain", sa.Boolean(), nullable=False,
                  server_default=sa.text("false")),
    ):
        op.add_column("py_drugs", column)
    for column in (
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("package_description", sa.String(240)),
        sa.Column("package_type", sa.String(80)),
        sa.Column("units_per_package", sa.Numeric(12, 3)),
        sa.Column("package_price", sa.Numeric(12, 4)),
        sa.Column("therapeutic_equivalence_code", sa.String(20)),
        sa.Column("is_interchangeable_biological", sa.Boolean(), nullable=False,
                  server_default=sa.text("false")),
    ):
        op.add_column("py_products", column)
    for column in (
        sa.Column("source_type", sa.String(20), nullable=False, server_default="MANUAL"),
        sa.Column("written_date", sa.String(10)),
        sa.Column("electronic_message_id", sa.String(160)),
        sa.Column("electronic_raw_message", sa.Text()),
        sa.Column("product_selection_directive", sa.String(35), nullable=False,
                  server_default="UNSPECIFIED"),
    ):
        op.add_column("py_prescriptions", column)
    if op.get_bind().dialect.name == "sqlite":
        # SQLite allows nullable inline REFERENCES when adding a column, but
        # Alembic's generic add_column splits out the FK as unsupported ALTER.
        op.execute("ALTER TABLE py_prescriptions ADD COLUMN "
                   "prescribed_product_id VARCHAR(36) REFERENCES py_products (id)")
    else:
        op.add_column("py_prescriptions", sa.Column("prescribed_product_id",
                      sa.String(36), sa.ForeignKey("py_products.id"), nullable=True))
    if op.get_bind().dialect.name == "postgresql":
        op.create_check_constraint("ck_py_rx_source_type", "py_prescriptions",
                                   "source_type IN ('MANUAL','PAPER','FAX','ELECTRONIC','VERBAL','TRANSFER')")
        op.create_check_constraint("ck_py_rx_product_selection", "py_prescriptions",
                                   "product_selection_directive IN "
                                   "('UNSPECIFIED','SELECTION_PERMITTED','DISPENSE_AS_WRITTEN')")
        op.create_check_constraint("ck_py_product_package_units_positive", "py_products",
                                   "units_per_package IS NULL OR units_per_package > 0")
        op.create_check_constraint("ck_py_product_package_price_nonnegative", "py_products",
                                   "package_price IS NULL OR package_price >= 0")


def downgrade():
    raise RuntimeError("Destructive removal of prescription provenance is prohibited")
