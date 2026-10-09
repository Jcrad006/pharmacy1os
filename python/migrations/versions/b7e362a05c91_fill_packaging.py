"""Persist synthetic fill packaging choice and patient discard metadata.

Revision ID: b7e362a05c91
Revises: e41cd17a9203

Old fills retain original-container false and NULL discard date: no retroactive
manufacturer-expiration calculation is fabricated.
"""
from alembic import op
import sqlalchemy as sa

revision = "b7e362a05c91"
down_revision = "e41cd17a9203"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("py_fills", sa.Column("dispensed_in_original_container",
        sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("py_fills", sa.Column("patient_discard_date", sa.String(10)))
    op.add_column("py_fills", sa.Column("packaging_reviewed_by_id", sa.String(36),
        sa.ForeignKey("py_staff.id")))
    op.add_column("py_fills", sa.Column("packaging_reviewed_at",
        sa.DateTime(timezone=True)))
    op.add_column("py_fills", sa.Column("packaging_note", sa.Text()))


def downgrade():
    raise RuntimeError("Packaging provenance and discard-date evidence cannot be silently destroyed")
