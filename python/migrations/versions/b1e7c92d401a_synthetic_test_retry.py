"""Allow append-only pharmacist synthetic test retry provenance.

Revision ID: b1e7c92d401a
Revises: c4b51a72d290
"""
from alembic import op

revision = "b1e7c92d401a"
down_revision = "c4b51a72d290"
branch_labels = None
depends_on = None


def upgrade():
    # CHECK constraints change together; Alembic batch mode recreates the
    # SQLite table instead of dropping safety checks in place.
    with op.batch_alter_table("py_sandbox_claim_transactions") as batch:
        batch.drop_constraint("ck_py_sandbox_claim_operation", type_="check")
        batch.drop_constraint("ck_py_sandbox_claim_outcome", type_="check")
        batch.create_check_constraint("ck_py_sandbox_claim_operation",
            "operation IN ('BILL','REVERSE','TEST_REJECT','TEST_RESOLVE','TEST_RETRY')")
        batch.create_check_constraint("ck_py_sandbox_claim_outcome",
            "outcome IN ('PAID_SYNTHETIC','REVERSED_SYNTHETIC','REJECTED_SYNTHETIC',"
            "'CLEARED_TEST_HOLD','RETRIED_SYNTHETIC')")


def downgrade():
    raise RuntimeError("Do not discard historical synthetic retry events")
