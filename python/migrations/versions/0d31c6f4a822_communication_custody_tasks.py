"""Add synthetic immutable-source communication worklist and audit events.

Revision ID: 0d31c6f4a822
Revises: 84a672dc47f0
No connection with actual eRx/fax transport or Prisma legacy tables.
"""
from alembic import op
import sqlalchemy as sa

revision = "0d31c6f4a822"
down_revision = "84a672dc47f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("py_communication_tasks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("prescription_id", sa.String(36), sa.ForeignKey("py_prescriptions.id"), nullable=False),
        sa.Column("document_id", sa.String(36), sa.ForeignKey("py_documents.id"), nullable=False),
        sa.Column("document_sha256", sa.String(64), nullable=False),
        sa.Column("direction", sa.String(10), nullable=False),
        sa.Column("channel", sa.String(12), nullable=False),
        sa.Column("destination", sa.String(180), nullable=False),
        sa.Column("summary", sa.String(500), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("request_key", sa.String(100), nullable=False),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("approved_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("direction IN ('INBOUND','OUTBOUND')", name="ck_py_communication_direction"),
        sa.CheckConstraint("channel IN ('FAX','ERX','PHONE')", name="ck_py_communication_channel"),
        sa.CheckConstraint("status IN ('QUARANTINED','REVIEWED','DRAFT','APPROVED','ACTIVITY_RECORDED','CANCELLED')",
                           name="ck_py_communication_status"),
        sa.UniqueConstraint("site_id", "request_key", name="uq_py_communication_request"),
    )
    op.create_index("ix_py_communication_tasks_site_id", "py_communication_tasks", ["site_id"])
    op.create_index("ix_py_communication_tasks_prescription_id", "py_communication_tasks", ["prescription_id"])
    op.create_index("ix_py_communication_site_status", "py_communication_tasks", ["site_id", "status"])
    op.create_table("py_communication_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("py_communication_tasks.id"), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(30), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("request_key", sa.String(100), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("sequence >= 1", name="ck_py_communication_sequence"),
        sa.CheckConstraint("action IN ('CREATED','APPROVED','REVIEWED','ATTEMPT_RECORDED','CANCELLED')",
                           name="ck_py_communication_action"),
        sa.UniqueConstraint("task_id", "sequence", name="uq_py_communication_event_sequence"),
        sa.UniqueConstraint("task_id", "request_key", name="uq_py_communication_event_request"),
    )
    op.create_index("ix_py_communication_events_site_id", "py_communication_events", ["site_id"])
    op.create_index("ix_py_communication_events_task_id", "py_communication_events", ["task_id"])


def downgrade() -> None:
    raise RuntimeError("Never destroy prescription communications provenance with an automatic downgrade")
