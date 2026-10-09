"""Versioned synthetic prescription edit ledger.

Revision ID: 60a79f2cc141
Revises: c6d923e46a10
"""
from alembic import op
import sqlalchemy as sa

revision = "60a79f2cc141"
down_revision = "c6d923e46a10"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_prescription_edits",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("prescription_id", sa.String(36),
                  sa.ForeignKey("py_prescriptions.id"), nullable=False),
        sa.Column("version_before", sa.Integer(), nullable=False),
        sa.Column("version_after", sa.Integer(), nullable=False),
        sa.Column("prior_status", sa.String(30), nullable=False),
        sa.Column("resulting_status", sa.String(30), nullable=False),
        sa.Column("changes_json", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("attestation_note", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("prescription_id", "version_after", name="uq_py_rx_edit_version"),
        sa.CheckConstraint("version_after = version_before + 1",
                           name="ck_py_rx_edit_increment"),
    )
    op.create_index("ix_py_prescription_edits_site_id",
                    "py_prescription_edits", ["site_id"])
    op.create_index("ix_py_prescription_edits_prescription_id",
                    "py_prescription_edits", ["prescription_id"])


def downgrade():
    raise RuntimeError("Loss of immutable prescription edit history is prohibited")
