"""Persist synthetic reviewed-Rx request receipt and deterministic replay.

Revision ID: 18fb732c02a1
Revises: d52f1ab36c90

No legacy Prisma tables or prescription data are modified.
"""
from alembic import op
import sqlalchemy as sa

revision = "18fb732c02a1"
down_revision = "d52f1ab36c90"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "py_rx_edit_requests",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("request_id", sa.String(36), nullable=False),
        sa.Column("prescription_id", sa.String(36),
                  sa.ForeignKey("py_prescriptions.id"), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("edit_id", sa.String(36),
                  sa.ForeignKey("py_prescription_edits.id"), nullable=False, unique=True),
        sa.Column("request_sha256", sa.String(64), nullable=False),
        sa.Column("response_json", sa.Text(), nullable=False),
        sa.Column("response_sha256", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("site_id", "request_id",
                            name="uq_py_rx_edit_request_site_key"),
    )
    op.create_index("ix_py_rx_edit_requests_site_id",
                    "py_rx_edit_requests", ["site_id"])


def downgrade():
    raise RuntimeError("Do not erase immutable reviewed-Rx idempotency receipts")
