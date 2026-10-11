"""Immutable versioned synthetic COB payer-attempt lineage with historical backfill.

Revision ID: a8c9f01d724b
Revises: b1e7c92d401a
"""
from __future__ import annotations

import hashlib
import json
from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision = "a8c9f01d724b"
down_revision = "b1e7c92d401a"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "py_synthetic_cob_attempts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("fill_id", sa.String(36), sa.ForeignKey("py_fills.id"), nullable=False),
        sa.Column("claim_id", sa.String(36), sa.ForeignKey("py_claims.id"), nullable=False),
        sa.Column("coverage_position", sa.Integer(), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("paid_transaction_id", sa.String(36),
                  sa.ForeignKey("py_sandbox_claim_transactions.id"),
                  nullable=False, unique=True),
        sa.Column("request_sha256", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("claim_id", "attempt_number", name="uq_py_cob_claim_attempt"),
        sa.CheckConstraint("coverage_position BETWEEN 1 AND 4",
                           name="ck_py_cob_attempt_position"),
        sa.CheckConstraint("attempt_number >= 1", name="ck_py_cob_attempt_positive"),
    )
    op.create_index("ix_py_synthetic_cob_attempts_site_id",
                    "py_synthetic_cob_attempts", ["site_id"])
    op.create_index("ix_py_synthetic_cob_attempts_fill_id",
                    "py_synthetic_cob_attempts", ["fill_id"])
    op.create_index("ix_py_synthetic_cob_attempts_claim_id",
                    "py_synthetic_cob_attempts", ["claim_id"])
    op.create_index("ix_py_cob_attempt_site_fill_position",
                    "py_synthetic_cob_attempts",
                    ["site_id", "fill_id", "coverage_position"])
    op.create_table(
        "py_synthetic_cob_attempt_reversals",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("site_id", sa.String(36), sa.ForeignKey("py_sites.id"), nullable=False),
        sa.Column("attempt_id", sa.String(36),
                  sa.ForeignKey("py_synthetic_cob_attempts.id"),
                  nullable=False, unique=True),
        sa.Column("reversal_transaction_id", sa.String(36),
                  sa.ForeignKey("py_sandbox_claim_transactions.id"),
                  nullable=False, unique=True),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("py_staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_py_synthetic_cob_attempt_reversals_site_id",
                    "py_synthetic_cob_attempt_reversals", ["site_id"])

    # No fabrication of prior payer data: backfill only *actual* immutable local
    # BILL/REVERSE events, preserving actor, timestamp, claim, and hash.
    db = op.get_bind()
    bills = db.execute(sa.text("""
        SELECT tx.id, tx.site_id, tx.fill_id, tx.claim_id, tx.operation,
               tx.outcome, tx.actor_id, tx.request_json, tx.request_sha256,
               tx.recorded_at, c.sequence, c.fill_id AS parent_fill_id
        FROM py_sandbox_claim_transactions tx
        JOIN py_claims c ON c.id = tx.claim_id
        WHERE tx.operation = 'BILL'
        ORDER BY tx.recorded_at, tx.id
    """)).mappings().all()
    attempt_ids = {}
    for bill in bills:
        request = json.loads(bill["request_json"])
        expected_hash = hashlib.sha256(json.dumps(
            request, sort_keys=True, separators=(",", ":"),
            ensure_ascii=True).encode("utf-8")).hexdigest()
        if (bill["outcome"] != "PAID_SYNTHETIC"
                or not bill["claim_id"] or bill["fill_id"] != bill["parent_fill_id"]
                or not 1 <= bill["sequence"] <= 4
                or request.get("coverage_position") != bill["sequence"]
                or request.get("fill_id") != bill["fill_id"]
                or bill["request_sha256"] != expected_hash
                or bill["claim_id"] in attempt_ids):
            raise RuntimeError("Historic synthetic paid claim cannot be backfilled safely")
        attempt = str(uuid4())
        attempt_ids[bill["claim_id"]] = (attempt, bill["id"])
        db.execute(sa.text("""
            INSERT INTO py_synthetic_cob_attempts
                (id, site_id, fill_id, claim_id, coverage_position,
                 attempt_number, paid_transaction_id, request_sha256,
                 actor_id, created_at)
            VALUES (:id, :site_id, :fill_id, :claim_id, :coverage_position,
                    1, :paid_transaction_id, :request_sha256, :actor_id,
                    :created_at)
        """), dict(id=attempt, site_id=bill["site_id"], fill_id=bill["fill_id"],
                   claim_id=bill["claim_id"], coverage_position=bill["sequence"],
                   paid_transaction_id=bill["id"],
                   request_sha256=bill["request_sha256"],
                   actor_id=bill["actor_id"], created_at=bill["recorded_at"]))
    # A prior reversal with missing corresponding paid transaction is an
    # unresolved legacy anomaly, never an invented successful reversal.
    reversals = db.execute(sa.text("""
        SELECT id, site_id, claim_id, original_transaction_id,
               operation, outcome, actor_id, recorded_at
        FROM py_sandbox_claim_transactions WHERE operation = 'REVERSE'
        ORDER BY recorded_at, id
    """)).mappings().all()
    reversed_claims = set()
    for reversal in reversals:
        info = attempt_ids.get(reversal["claim_id"])
        if (info is None or reversal["claim_id"] in reversed_claims
                or reversal["original_transaction_id"] != info[1]
                or reversal["outcome"] != "REVERSED_SYNTHETIC"):
            raise RuntimeError("Orphan or duplicated historical reversal requires manual reconciliation")
        reversed_claims.add(reversal["claim_id"])
        db.execute(sa.text("""
            INSERT INTO py_synthetic_cob_attempt_reversals
                (id, site_id, attempt_id, reversal_transaction_id,
                 actor_id, created_at)
            VALUES (:id, :site_id, :attempt_id, :reversal_transaction_id,
                    :actor_id, :created_at)
        """), dict(id=str(uuid4()), site_id=reversal["site_id"],
                   attempt_id=info[0],
                   reversal_transaction_id=reversal["id"],
                   actor_id=reversal["actor_id"],
                   created_at=reversal["recorded_at"]))


def downgrade():
    raise RuntimeError("Never erase versioned synthetic claim/reversal provenance")
