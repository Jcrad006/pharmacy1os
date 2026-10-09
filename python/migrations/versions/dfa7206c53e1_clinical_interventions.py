"""Append-only synthetic pharmacist intervention ledger.

Revision ID: dfa7206c53e1
Revises: c8f20b42d531

Never migrates, reads or modifies legacy TypeScript/Prisma tables.
"""
from alembic import op
import sqlalchemy as sa

revision = "dfa7206c53e1"
down_revision = "c8f20b42d531"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_intervention_notes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("prescription_id", sa.String(36), sa.ForeignKey("py_prescriptions.id"),
                  nullable=False),
        sa.Column("author_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("length(trim(note)) BETWEEN 1 AND 4000",
                           name="ck_py_intervention_note_length"))
    op.create_index("ix_py_intervention_notes_site_id", "py_intervention_notes", ["site_id"])
    op.create_index("ix_py_intervention_notes_prescription_id", "py_intervention_notes", ["prescription_id"])
    op.create_index("ix_py_intervention_rx_time", "py_intervention_notes",
                    ["prescription_id", "created_at"])


def downgrade():
    raise RuntimeError("Clinical intervention history may not be destroyed by an unattended downgrade")
