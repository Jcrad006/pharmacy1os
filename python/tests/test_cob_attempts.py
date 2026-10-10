"""Versioned synthetic COB attempt lineage: original payments and reversals."""
from datetime import date, timedelta
from hashlib import sha256
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from pharmacy1os.api import create_app
from pharmacy1os.claim_rebilling import ClaimRebillService
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.claim_transactions_models import SandboxClaimTransaction
from pharmacy1os.cob_attempts import (
    CobAttemptRegistry, SyntheticCobAttempt, SyntheticCobAttemptReversal,
)
from pharmacy1os.models import Claim, Fill, Prescription, Stock
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def demo():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    outsiders = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    drug = svc.add_drug(pharm, "Versioned COB demo", "10mg", "tablet")
    prod = svc.add_product(pharm, drug, "90021-1000-77", "Synthetic", "Demo tablets")
    svc.register_barcode(tech, prod, "VERSIONED-COB-SCAN")
    expiry = (date.today() + timedelta(days=190)).isoformat()
    stock_id = svc.receive(tech, "VERSIONED-COB-SCAN", "VERSIONED-LOT", expiry, "90")
    patient = svc.add_patient(tech, "Attempt", "Ledger")
    provider = svc.add_prescriber(tech, "Attempt", "Doctor", "MD")
    rx = svc.add_prescription(tech, patient, provider, drug,
        "VERSIONED-COB-RX", "one per day", "60")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, days_supply=60)
    svc.scan_source(tech, fill, "VERSIONED-COB-SCAN", "VERSIONED-LOT", expiry, "60")
    return svc, actors, outsiders, rx, fill, stock_id


def test_prepared_three_payer_claims_create_matching_version_one_attempts(demo):
    svc, a, outside, rx, fill, stock = demo
    svc.prepare_for_review(a["TECHNICIAN"], fill,
        ["Primary Test", "Secondary Test", "Tertiary Test"])
    history = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    assert history["total_attempts"] == 3
    assert history["active_local_paid_positions"] == 3
    assert history["selective_reprocessing_enabled"] is True
    assert [p["coverage_position"] for p in history["claim_positions"]] == [1, 2, 3]
    original_events = [x for x in SandboxClaimService(svc).list_for_fill(
        a["AUDITOR"], fill) if x["operation"] == "BILL"]
    assert [p["attempts"][0]["paid_transaction_id"] for p in
            history["claim_positions"]] == [x["id"] for x in original_events]
    assert all(p["attempts"][0]["attempt_number"] == 1 for p in history["claim_positions"])
    assert all(p["attempts"][0]["reversal_transaction_id"] is None
               for p in history["claim_positions"])
    assert "TRANSACTION" not in history["warning"]


def test_multi_payer_reversal_appends_exact_one_reversal_link_per_attempt(demo):
    svc, a, outside, rx, fill, stock = demo
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Primary", "Secondary"])
    bills = [t for t in SandboxClaimService(svc).list_for_fill(a["AUDITOR"], fill)
             if t["operation"] == "BILL"]
    ids = [b["id"] for b in reversed(bills)]
    result = ClaimRebillService(svc).reverse_cob_transactions(
        a["PHARMACIST"], fill,
        "Reversed local mock claims to inspect versioned historical linkage",
        expected_paid_transaction_ids=ids)
    registry = CobAttemptRegistry(svc)
    summary = registry.history(a["AUDITOR"], fill)
    assert summary["total_attempts"] == 2
    assert summary["active_local_paid_positions"] == 0
    assert [p["attempts"][0]["state"] for p in summary["claim_positions"]] == [
        "REVERSED_SYNTHETIC", "REVERSED_SYNTHETIC"]
    assert {p["attempts"][0]["reversal_transaction_id"] for p
            in summary["claim_positions"]} == set(result["reversal_transaction_ids"])
    with svc.sessions() as s:
        assert len(s.scalars(select(SyntheticCobAttemptReversal)).all()) == 2
        assert s.get(Stock, stock).reserved == 0
        assert s.get(Fill, result["replacement_fill_id"]).status == "PRODUCT_FILL"
    replay = ClaimRebillService(svc).reverse_cob_transactions(
        a["PHARMACIST"], fill, "Same synthetic reversal requested a second time",
        expected_paid_transaction_ids=ids)
    assert replay["replayed"] is True
    assert registry.history(a["AUDITOR"], fill) == summary


def test_site_scope_and_api_synthetic_gating(demo):
    svc, a, outside, rx, fill, stock = demo
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["One Test Payer"])
    api = TestClient(create_app(svc, synthetic_enabled=True))
    off = TestClient(create_app(svc, synthetic_enabled=False))
    endpoint = f"/api/third-party/fills/{fill}/cob-attempts"
    header = {"x-demo-staff-id": a["AUDITOR"].id}
    assert off.get(endpoint, headers=header).status_code == 503
    assert api.get(endpoint).status_code == 403
    assert api.get(endpoint, headers=header).status_code == 200
    assert api.get(endpoint, headers=header).json()["total_attempts"] == 1
    assert api.get(endpoint, headers={"x-demo-staff-id": outside["AUDITOR"].id}).status_code == 409
    with pytest.raises(WorkflowError, match="pharmacy site"):
        CobAttemptRegistry(svc).history(outside["AUDITOR"], fill)


def test_mirror_hash_change_or_missing_row_fails_closed(demo):
    svc, a, outside, rx, fill, stock = demo
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Local Test Payer"])
    with svc.sessions.begin() as s:
        paid = s.scalar(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.fill_id == fill,
            SandboxClaimTransaction.operation == "BILL"))
        original = paid.request_json
        paid.request_json = '{"tampered":"yes"}'
    with pytest.raises(WorkflowError, match="integrity"):
        CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    with svc.sessions.begin() as s:
        paid = s.scalar(select(SandboxClaimTransaction).where(
            SandboxClaimTransaction.fill_id == fill,
            SandboxClaimTransaction.operation == "BILL"))
        paid.request_json = original
    with svc.sessions.begin() as s:
        attempt = s.scalar(select(SyntheticCobAttempt).where(
            SyntheticCobAttempt.fill_id == fill))
        s.delete(attempt)
    with pytest.raises(WorkflowError, match="incomplete"):
        CobAttemptRegistry(svc).history(a["AUDITOR"], fill)


def test_unique_claim_attempt_and_single_reversal_constraints(demo):
    svc, a, outside, rx, fill, stock = demo
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Test Payer"])
    with svc.sessions.begin() as s:
        existing = s.scalar(select(SyntheticCobAttempt))
        replica = SyntheticCobAttempt(
            site_id=existing.site_id, fill_id=existing.fill_id,
            claim_id=existing.claim_id, coverage_position=1,
            attempt_number=1, paid_transaction_id=existing.paid_transaction_id,
            request_sha256=existing.request_sha256, actor_id=existing.actor_id)
        s.add(replica)
        with pytest.raises(IntegrityError):
            s.flush()
        s.rollback()
    assert CobAttemptRegistry(svc).history(a["AUDITOR"], fill)["total_attempts"] == 1


def test_cash_only_fill_has_no_payer_attempts(demo):
    svc, a, outside, rx, fill, stock = demo
    svc.prepare_for_review(a["TECHNICIAN"], fill, [])
    history = CobAttemptRegistry(svc).history(a["AUDITOR"], fill)
    assert history["claim_positions"] == []
    assert history["total_attempts"] == 0


def test_migration_backfills_earlier_local_bill_and_reversal(tmp_path, monkeypatch):
    """Upgrade old migrated SQLite demo with historical real local-test events."""
    from alembic import command
    from pharmacy1os.db_cli import migration_config, revision_at_head
    from pharmacy1os.models import Claim
    from pharmacy1os.claim_transactions_models import SandboxClaimTransaction

    url = "sqlite+pysqlite:///" + str(tmp_path / "prior-synthetic.sqlite3")
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    monkeypatch.setenv("PHARMACY1OS_DATABASE_URL", url)
    command.upgrade(migration_config(), "b1e7c92d401a")
    service = PharmacyService(url)
    try:
        actors = service.bootstrap_demo()["actors"]
        tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
        drug = service.add_drug(pharm, "Old migrated test medication", "2mg", "tablet")
        prod = service.add_product(pharm, drug, "50050-6666-02", "Demo", "Test tablet")
        service.register_barcode(tech, prod, "HISTORIC-COB-BC")
        exp = (date.today() + timedelta(days=180)).isoformat()
        service.receive(tech, "HISTORIC-COB-BC", "HISTORIC-LOT", exp, "40")
        p = service.add_patient(tech, "Historical", "Mock")
        dr = service.add_prescriber(tech, "Historical", "Doctor", "MD")
        rx = service.add_prescription(tech, p, dr, drug,
            "HISTORIC-COB-RX", "once daily", "20")
        service.advance_to_dur(tech, rx)
        fill = service.start_fill(tech, rx)
        service.scan_source(tech, fill, "HISTORIC-COB-BC",
                            "HISTORIC-LOT", exp, "20")
        with service.sessions.begin() as s:
            claim = Claim(fill_id=fill, payer="Original Mock",
                sequence=1, status="REVERSED_SYNTHETIC", billed_quantity=20)
            s.add(claim)
            s.flush()
            paid_json = json.dumps({
                "fill_id": fill, "coverage_position": 1,
                "payer_name": claim.payer,
                "payer_intended_quantity": "20.000",
                "physical_part_quantity": "20.000"}, sort_keys=True, separators=(",", ":"))
            from pharmacy1os.models import uuid
            bill_id = uuid()
            s.add(SandboxClaimTransaction(
                id=bill_id, site_id=pharm.site_id, fill_id=fill,
                claim_id=claim.id, operation="BILL", outcome="PAID_SYNTHETIC",
                idempotency_key="test-prior-bill:" + claim.id,
                request_json=paid_json, response_json='{"outcome":"PAID_SYNTHETIC"}',
                request_sha256=sha256(paid_json.encode()).hexdigest(),
                actor_id=tech.id))
            s.flush()
            reversal_json = json.dumps({"claim_id": claim.id, "original_transaction_id": bill_id},
                sort_keys=True, separators=(",", ":"))
            s.add(SandboxClaimTransaction(
                id=uuid(), site_id=pharm.site_id, fill_id=fill,
                claim_id=claim.id, original_transaction_id=bill_id,
                operation="REVERSE", outcome="REVERSED_SYNTHETIC",
                idempotency_key="test-prior-reversal:" + claim.id,
                request_json=reversal_json,
                response_json='{"outcome":"REVERSED_SYNTHETIC"}',
                request_sha256=sha256(reversal_json.encode()).hexdigest(),
                actor_id=pharm.id))
        command.upgrade(migration_config(), "head")
        assert revision_at_head(service.engine)
        history = CobAttemptRegistry(service).history(actors["AUDITOR"], fill)
        assert history["total_attempts"] == 1
        assert history["active_local_paid_positions"] == 0
        assert history["claim_positions"][0]["attempts"][0]["state"] == "REVERSED_SYNTHETIC"
    finally:
        service.engine.dispose()
