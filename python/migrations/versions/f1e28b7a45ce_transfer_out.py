"""Add synthetic pharmacist-attested prescription transfer-out requests.

Revision ID: f1e28b7a45ce
Revises: c4e6bdf912a0
Only isolated py_* tables; never touches Prisma.
"""
from alembic import op
import sqlalchemy as sa

revision = "f1e28b7a45ce"
down_revision = "c4e6bdf912a0"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "py_prescription_transfers_out",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("prescription_id", sa.String(36), sa.ForeignKey("py_prescriptions.id"),
                  nullable=False, unique=True),
        sa.Column("request_key", sa.String(120), nullable=False),
        sa.Column("destination_name", sa.String(180), nullable=False),
        sa.Column("destination_phone", sa.String(60), nullable=False),
        sa.Column("request_reason", sa.Text(), nullable=False),
        sa.Column("requested_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attested_by_id", sa.String(36), sa.ForeignKey("py_staff.id")),
        sa.Column("attested_at", sa.DateTime(timezone=True)),
        sa.Column("receiving_pharmacist", sa.String(150)),
        sa.Column("handoff_reference", sa.String(150)),
        sa.Column("attestation_note", sa.Text()),
        sa.Column("withdrawn_by_id", sa.String(36), sa.ForeignKey("py_staff.id")),
        sa.Column("withdrawn_at", sa.DateTime(timezone=True)),
        sa.Column("withdrawal_reason", sa.Text()),
        sa.UniqueConstraint("site_id", "request_key", name="uq_py_transfer_out_request_key"),
        sa.CheckConstraint("status IN ('REQUESTED', 'ATTESTED_OUT', 'WITHDRAWN')",
                           name="ck_py_transfer_out_status"),
    )
    op.create_index("ix_py_prescription_transfers_out_site_id",
                    "py_prescription_transfers_out", ["site_id"])


def downgrade():
    raise RuntimeError("Destructive transfer provenance rollback is not supported")
