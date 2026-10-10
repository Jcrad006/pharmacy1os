"""Add provider DOB to the isolated Python directory.

Revision ID: d7f2e57b8c94
Revises: b6d7198c42e0

Previously recorded prescriber DOB is unknown, and remains NULL.
Legacy Prisma tables and real patient data are not touched.
"""
from alembic import op
import sqlalchemy as sa

revision = "d7f2e57b8c94"
down_revision = "b6d7198c42e0"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("py_prescribers", sa.Column(
        "date_of_birth", sa.String(length=10), nullable=True))


def downgrade():
    raise RuntimeError("Removing prescriber demographic provenance is prohibited")
