"""Backfill and require synthetic claim-response integrity checksums.

Revision ID: d52f1ab36c90
Revises: a8c9f01d724b

The source events are *synthetic only*. Canonical request hashes and recorded
response outcomes must agree before any missing response digests are backfilled.
A mismatch aborts rather than laundering edited claims into 'valid' history.
"""
from __future__ import annotations

import hashlib
import json

from alembic import op
import sqlalchemy as sa

revision = "d52f1ab36c90"
down_revision = "a8c9f01d724b"
branch_labels = None
depends_on = None


def _canonical(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def upgrade():
    op.add_column("py_sandbox_claim_transactions",
                  sa.Column("response_sha256", sa.String(length=64), nullable=True))
    conn = op.get_bind()
    # The prior version checked requests, not synthetic responses. Verify the
    # original event before computing any new digest. This detects mismatched
    # response outcomes, malformed JSON and changed request provenance.
    events = conn.execute(sa.text("""
        SELECT id, request_json, request_sha256, response_json, outcome
        FROM py_sandbox_claim_transactions
    """)).mappings()
    for event in events:
        try:
            request = json.loads(event["request_json"])
            response = json.loads(event["response_json"])
            if not isinstance(request, dict) or not isinstance(response, dict):
                raise ValueError("Transaction evidence must be JSON objects")
            if (hashlib.sha256(_canonical(request).encode("utf-8")).hexdigest()
                    != event["request_sha256"]):
                raise ValueError("Existing request checksum does not match")
            if response.get("outcome") != event["outcome"]:
                raise ValueError("Existing response outcome differs from ledger status")
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                f"Cannot safely backfill synthetic response checksum for transaction {event['id']}"
            ) from exc
        digest = hashlib.sha256(_canonical(response).encode("utf-8")).hexdigest()
        conn.execute(sa.text("""
            UPDATE py_sandbox_claim_transactions
            SET response_sha256 = :digest WHERE id = :id
        """), {"digest": digest, "id": event["id"]})
    # SQLite uses batch recreation; PostgreSQL alters the existing column.
    with op.batch_alter_table("py_sandbox_claim_transactions") as batch:
        batch.alter_column("response_sha256", existing_type=sa.String(length=64),
                           nullable=False)


def downgrade():
    raise RuntimeError("Never discard immutable synthetic claim response integrity evidence")
