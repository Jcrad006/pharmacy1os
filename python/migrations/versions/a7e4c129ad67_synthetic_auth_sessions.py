"""Add site-scoped synthetic account credentials and revocable bearer sessions.

Revision ID: a7e4c129ad67
Revises: cc8a7d6b3410
Does not touch legacy Prisma records; all sessions are demo-only.
"""
from alembic import op
import sqlalchemy as sa

revision = "a7e4c129ad67"
down_revision = "cc8a7d6b3410"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "py_auth_credentials",
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("py_staff.id"), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("password_salt", sa.String(32), nullable=False),
        sa.Column("password_hash", sa.String(64), nullable=False),
        sa.Column("password_version", sa.Integer(), nullable=False),
        sa.Column("failure_count", sa.Integer(), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("username", name="uq_py_auth_credentials_username"),
    )
    op.create_index("ix_py_auth_credentials_site_id", "py_auth_credentials", ["site_id"])
    op.create_table(
        "py_auth_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("token_digest", sa.String(64), nullable=False),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("role_snapshot", sa.String(30), nullable=False),
        sa.Column("password_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("token_digest", name="uq_py_auth_sessions_token_digest"),
    )
    op.create_index("ix_py_auth_sessions_staff_id", "py_auth_sessions", ["staff_id"])
    op.create_index("ix_py_auth_sessions_site_id", "py_auth_sessions", ["site_id"])


def downgrade() -> None:
    raise RuntimeError("Destructive downgrade of authentication audit/session tables is not supported")
