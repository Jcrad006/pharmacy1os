"""Snapshot the NTI flag when a physical synthetic fill starts.

Revision ID: b6d7198c42e0
Revises: a3c6287e90b1
"""
from alembic import op
import sqlalchemy as sa

revision = "b6d7198c42e0"
down_revision = "a3c6287e90b1"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("py_fills") as batch:
        batch.add_column(sa.Column("nti_at_start", sa.Boolean(),
            nullable=False, server_default=sa.false()))


def downgrade():
    raise RuntimeError("Removing a classification snapshot weakens NTI safety gating")
