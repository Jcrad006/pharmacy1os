"""Original-inspired DUR issue titles, author, resolution and timestamps.

Revision ID: f2a19480c63e
Revises: dfa7206c53e1
Old clinical issues preserve their original code and resolved flag. Unknown
historical author/time/description information remains NULL.
"""
from alembic import op
import sqlalchemy as sa

revision = "f2a19480c63e"
down_revision = "dfa7206c53e1"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("py_dur_issues") as batch:
        batch.add_column(sa.Column("title", sa.String(160)))
        batch.add_column(sa.Column("description", sa.Text()))
        batch.add_column(sa.Column("source", sa.String(40)))
        batch.add_column(sa.Column("created_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("resolved_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("resolved_by_id", sa.String(36),
            sa.ForeignKey("py_staff.id", name="fk_py_dur_resolved_by")))
        batch.add_column(sa.Column("resolved_automatically", sa.Boolean(),
            nullable=False, server_default=sa.false()))


def downgrade():
    raise RuntimeError("DUR clinical provenance cannot be dropped automatically")
