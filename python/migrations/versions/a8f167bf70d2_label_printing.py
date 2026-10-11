"""Add immutable synthetic per-bottle printing snapshots and spool attempt ledger.

Revision ID: a8f167bf70d2
Revises: f1e28b7a45ce
"""
from alembic import op
import sqlalchemy as sa

revision = "a8f167bf70d2"
down_revision = "f1e28b7a45ce"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("py_label_print_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False),
        sa.Column("label_id", sa.String(36), sa.ForeignKey("py_labels.id"), nullable=False, unique=True),
        sa.Column("bottle_number", sa.Integer(), nullable=False),
        sa.Column("snapshot_json", sa.Text(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("void_reason", sa.Text()),
        sa.UniqueConstraint("fill_id", "bottle_number", name="uq_py_label_print_bottle"),
        sa.CheckConstraint("status IN ('QUEUED', 'VOIDED')", name="ck_py_print_job_status"),
        sa.CheckConstraint("bottle_number > 0", name="ck_py_print_job_bottle"))
    op.create_index("ix_py_label_print_jobs_site_id", "py_label_print_jobs", ["site_id"])
    op.create_index("ix_py_label_print_jobs_fill_id", "py_label_print_jobs", ["fill_id"])
    op.create_table("py_label_print_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("print_job_id", sa.String(36), sa.ForeignKey("py_label_print_jobs.id"),
                  nullable=False),
        sa.Column("request_key", sa.String(120), nullable=False),
        sa.Column("event_kind", sa.String(35), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("site_id", "request_key", name="uq_py_print_event_request_key"),
        sa.CheckConstraint("event_kind IN ('NATIVE_DIALOG_ACCEPTED', 'TEST_REPRINT_REQUESTED')",
                           name="ck_py_print_event_kind"))
    op.create_index("ix_py_label_print_events_site_id", "py_label_print_events", ["site_id"])
    op.create_index("ix_py_label_print_events_print_job_id", "py_label_print_events", ["print_job_id"])


def downgrade():
    raise RuntimeError("Immutable print history cannot be destructively downgraded")
