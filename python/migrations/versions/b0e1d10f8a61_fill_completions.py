"""Link synthetic physical partial and completion fills without extra claims.

Revision ID: b0e1d10f8a61
Revises: e2a9401f67c3
Do not access or modify Prisma data.
"""
from alembic import op
import sqlalchemy as sa

revision = "b0e1d10f8a61"
down_revision = "e2a9401f67c3"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "py_fill_obligations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("prescription_id", sa.String(36), sa.ForeignKey("py_prescriptions.id"), nullable=False),
        sa.Column("anchor_fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False, unique=True),
        sa.Column("intended", sa.Numeric(12, 3), nullable=False),
        sa.Column("dispensed", sa.Numeric(12, 3), nullable=False),
        sa.Column("remaining", sa.Numeric(12, 3), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.CheckConstraint("intended > 0 AND dispensed >= 0 AND remaining >= 0 AND dispensed + remaining = intended",
                           name="ck_py_fill_obligation_balance"),
        sa.CheckConstraint("status IN ('OPEN', 'FULFILLED', 'VOID_UNSOLD')",
                           name="ck_py_fill_obligation_status"),
    )
    op.create_index("ix_py_fill_obligations_site_id", "py_fill_obligations", ["site_id"])
    op.create_index("ix_py_fill_obligations_prescription_id", "py_fill_obligations", ["prescription_id"])
    op.create_table(
        "py_fill_completions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("obligation_id", sa.String(36), sa.ForeignKey("py_fill_obligations.id"), nullable=False),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False, unique=True),
        sa.Column("part_number", sa.Integer(), nullable=False),
        sa.UniqueConstraint("obligation_id", "part_number", name="uq_py_completion_part_number"),
        sa.CheckConstraint("part_number >= 2", name="ck_py_completion_part_number"),
    )
    op.create_index("ix_py_fill_completions_site_id", "py_fill_completions", ["site_id"])
    op.create_index("ix_py_fill_completions_obligation_id", "py_fill_completions", ["obligation_id"])


def downgrade():
    raise RuntimeError("Partial-fill custody lineage may not be destructively downgraded")
