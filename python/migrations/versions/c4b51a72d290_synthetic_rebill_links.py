"""Link retired synthetic claim attempts to new rescan/rebill attempts.

Revision ID: c4b51a72d290
Revises: 89d723ba4201
"""
from alembic import op
import sqlalchemy as sa

revision = "c4b51a72d290"
down_revision = "89d723ba4201"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "py_synthetic_rebill_links",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("original_fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False),
        sa.Column("replacement_fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False),
        sa.Column("reversed_claim_ids_json", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("original_fill_id", name="uq_py_rebill_original_fill"),
        sa.UniqueConstraint("replacement_fill_id", name="uq_py_rebill_replacement_fill"),
    )
    op.create_index("ix_py_synthetic_rebill_links_site_id",
                    "py_synthetic_rebill_links", ["site_id"])


def downgrade():
    raise RuntimeError("Do not erase immutable synthetic rebill lineage")
