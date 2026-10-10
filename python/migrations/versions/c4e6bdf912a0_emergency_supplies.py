"""Add isolated synthetic emergency supply authorization/follow-up records.

Revision ID: c4e6bdf912a0
Revises: b0e1d10f8a61
No Prisma tables or records may be modified here.
"""
from alembic import op
import sqlalchemy as sa

revision = "c4e6bdf912a0"
down_revision = "b0e1d10f8a61"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("py_emergency_supplies",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("prescription_id", sa.String(36), sa.ForeignKey("py_prescriptions.id"),
                  nullable=False, unique=True),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"),
                  nullable=False, unique=True),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("authorized_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("authorized_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("follow_up_due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("follow_up_by_id", sa.String(36), sa.ForeignKey("py_staff.id")),
        sa.Column("follow_up_completed_at", sa.DateTime(timezone=True)),
        sa.Column("follow_up_note", sa.Text()),
        sa.CheckConstraint("quantity > 0", name="ck_py_emergency_quantity"),
        sa.CheckConstraint("status IN ('OPEN','COMPLETED','VOID_UNSOLD')",
                           name="ck_py_emergency_state"))
    op.create_index("ix_py_emergency_supplies_site_id", "py_emergency_supplies", ["site_id"])


def downgrade() -> None:
    raise RuntimeError("Destructive downgrade of documented emergency dispensing is not supported")
