"""Add synthetic pharmacist-authorized structured prescription change applications.

Revision ID: cc8a7d6b3410
Revises: 0d31c6f4a822

No modifications to historical documents, existing py_prescriptions, or Prisma.
"""
from alembic import op
import sqlalchemy as sa

revision = "cc8a7d6b3410"
down_revision = "0d31c6f4a822"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "py_structured_change_applications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("prescription_id", sa.String(36), sa.ForeignKey("py_prescriptions.id"), nullable=False),
        sa.Column("change_record_id", sa.String(36), sa.ForeignKey("py_document_changes.id"), nullable=False, unique=True),
        sa.Column("document_sha256", sa.String(64), nullable=False),
        sa.Column("applied_field", sa.String(30), nullable=False),
        sa.Column("before_value", sa.Text(), nullable=False),
        sa.Column("after_value", sa.Text(), nullable=False),
        sa.Column("version_before", sa.Integer(), nullable=False),
        sa.Column("version_after", sa.Integer(), nullable=False),
        sa.Column("pharmacist_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("approval_note", sa.Text(), nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("version_after = version_before + 1", name="ck_py_change_version_increment"),
        sa.UniqueConstraint("prescription_id", "version_after", name="uq_py_change_rx_version"),
    )
    op.create_index("ix_py_structured_change_applications_site_id", "py_structured_change_applications", ["site_id"])
    op.create_index("ix_py_structured_change_applications_prescription_id", "py_structured_change_applications", ["prescription_id"])


def downgrade() -> None:
    raise RuntimeError("Destructive downgrade of prescription authorization history is blocked")
