"""Add Python-only synthetic multi-fill POS financial provenance.

Revision ID: 56b4b973cdea
Revises: 7c91d1e71f32

NOT a migration of legacy Prisma/production POS tables. No live payment use.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "56b4b973cdea"
down_revision: Union[str, Sequence[str], None] = "7c91d1e71f32"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table("py_pos_transactions",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("site_id", sa.String(36), nullable=False),
        sa.Column("patient_id", sa.String(36), nullable=False),
        sa.Column("actor_id", sa.String(36), nullable=False),
        sa.Column("idempotency_key", sa.String(120), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("mode", sa.String(20), nullable=False),
        sa.Column("recipient_name", sa.String(150), nullable=False),
        sa.Column("relationship", sa.String(80), nullable=False),
        sa.Column("identity_method", sa.String(30), nullable=False),
        sa.Column("signature_method", sa.String(30), nullable=False),
        sa.Column("signature_attested", sa.Boolean(), nullable=False),
        sa.Column("subtotal", sa.Numeric(12, 2), nullable=False),
        sa.Column("status", sa.String(25), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["site_id"], ["py_sites.id"]),
        sa.ForeignKeyConstraint(["patient_id"], ["py_patients.id"]),
        sa.ForeignKeyConstraint(["actor_id"], ["py_staff.id"]),
        sa.UniqueConstraint("site_id", "idempotency_key", name="uq_py_pos_idempotency"),
        sa.CheckConstraint("subtotal >= 0", name="ck_py_pos_nonnegative"),
        sa.CheckConstraint("mode IN ('WILL_CALL','IMMEDIATE')", name="ck_py_pos_mode"),
        sa.CheckConstraint("status IN ('POSTED','PARTIAL_REFUND','REFUNDED','VOIDED')", name="ck_py_pos_status"),
    )
    op.create_index("ix_py_pos_transactions_site_id", "py_pos_transactions", ["site_id"])
    op.create_table("py_pos_lines",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("transaction_id", sa.String(36), nullable=False),
        sa.Column("fill_id", sa.String(36), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("scanned_bag", sa.String(100), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["transaction_id"], ["py_pos_transactions.id"]),
        sa.ForeignKeyConstraint(["fill_id"], ["py_fills.id"]),
        sa.UniqueConstraint("fill_id"),
        sa.CheckConstraint("amount >= 0", name="ck_py_pos_line_nonnegative"),
    )
    op.create_index("ix_py_pos_lines_transaction_id", "py_pos_lines", ["transaction_id"])
    op.create_table("py_pos_tenders",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("transaction_id", sa.String(36), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("method", sa.String(15), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("reference", sa.String(120), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["transaction_id"], ["py_pos_transactions.id"]),
        sa.UniqueConstraint("transaction_id", "sequence", name="uq_py_pos_tender_sequence"),
        sa.CheckConstraint("amount > 0", name="ck_py_pos_tender_positive"),
        sa.CheckConstraint("method IN ('CASH','CARD','CHECK','OTHER')", name="ck_py_pos_tender_method"),
    )
    op.create_index("ix_py_pos_tenders_transaction_id", "py_pos_tenders", ["transaction_id"])
    op.create_table("py_pos_financial_events",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("site_id", sa.String(36), nullable=False),
        sa.Column("transaction_id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("method", sa.String(15), nullable=False),
        sa.Column("request_key", sa.String(120), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.String(36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["site_id"], ["py_sites.id"]),
        sa.ForeignKeyConstraint(["transaction_id"], ["py_pos_transactions.id"]),
        sa.ForeignKeyConstraint(["actor_id"], ["py_staff.id"]),
        sa.UniqueConstraint("site_id", "request_key", name="uq_py_pos_financial_event_idempotency"),
        sa.CheckConstraint("amount >= 0", name="ck_py_pos_event_nonnegative"),
        sa.CheckConstraint("kind IN ('CAPTURE_SIMULATED','REFUND_SIMULATED','VOID_SIMULATED')", name="ck_py_pos_event_kind"),
    )
    op.create_index("ix_py_pos_financial_events_site_id", "py_pos_financial_events", ["site_id"])
    op.create_index("ix_py_pos_financial_events_transaction_id", "py_pos_financial_events", ["transaction_id"])
    op.create_index("ix_py_pos_events_tx_kind", "py_pos_financial_events", ["transaction_id", "kind"])


def downgrade() -> None:
    raise RuntimeError("POS financial provenance cannot be destroyed by automatic downgrade")
