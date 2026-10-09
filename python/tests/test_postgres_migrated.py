"""Real PostgreSQL smoke/invariant tests; executed in GitHub Actions service container."""
from __future__ import annotations

import os

import pytest
from sqlalchemy import select

from pharmacy1os.db_cli import migration_config, revision_at_head, verify_mapped_schema
from pharmacy1os.models import Audit, InventoryMovement, Stock
from pharmacy1os.provider_directory import ProviderDirectory
from pharmacy1os.service import PharmacyService


@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"), reason="requires isolated PostgreSQL CI service")
def test_python_migrated_postgres_persists_inventory_with_audit():
    url = os.environ["PHARMACY1OS_PG_CI_URL"]
    if not url.startswith("postgresql+psycopg://"):
        pytest.fail("CI PostgreSQL URL must use the psycopg dialect")
    pharmacy = PharmacyService(url)
    try:
        assert revision_at_head(pharmacy.engine), "Run Alembic migration, not SQLAlchemy create_all"
        assert not verify_mapped_schema(pharmacy.engine)
        demo = pharmacy.bootstrap_demo()
        pharmacist = demo["actors"]["PHARMACIST"]
        technician = demo["actors"]["TECHNICIAN"]
        drug = pharmacy.add_drug(pharmacist, "TEST-ONLY-DRUG", "1 mg", "tablet")
        product = pharmacy.add_product(pharmacist, drug, "00000-1111-22", "Demo Manufacturer", "synthetic tablets")
        pharmacy.register_barcode(pharmacist, product, "00000111122")
        stock_id = pharmacy.receive(technician, "00000111122", "LOT001", "2030-09-30", "120")
        prescriber = pharmacy.add_prescriber(technician, "Synthetic", "Provider", "MD")
        directory = ProviderDirectory(pharmacy)
        directory.add_identifier(pharmacist, prescriber, "NPI", "1234567893", is_primary=True)
        directory.add_contact(technician, prescriber, "FAX", "919-555-0101", is_primary=True)
        assert directory.search(technician, "5550101")[0]["id"] == prescriber
        with pharmacy.sessions() as session:
            stock = session.get(Stock, stock_id)
            assert stock is not None and stock.on_hand == 120
            assert session.scalar(select(InventoryMovement).where(InventoryMovement.stock_id == stock_id)) is not None
            assert session.scalar(select(Audit).where(Audit.site_id == pharmacist.site_id)) is not None
    finally:
        pharmacy.engine.dispose()


@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"), reason="requires isolated PostgreSQL CI service")
def test_postgres_synthetic_pos_checkout_and_refund():
    """Prove migrated POS tables and multi-table transaction persistence on PG17."""
    from datetime import date, timedelta
    from pharmacy1os.pos import PosService
    from pharmacy1os.pos_models import PosTransaction, PosLine, PosFinancialEvent
    from pharmacy1os.date_rules import DateRulesService, FillSaleTimestamp

    url = os.environ["PHARMACY1OS_PG_CI_URL"]
    if not url.startswith("postgresql+psycopg://"):
        pytest.fail("POS integration test requires PostgreSQL with psycopg")
    service = PharmacyService(url)
    try:
        assert revision_at_head(service.engine), "Run Alembic migrations before PostgreSQL smoke tests"
        actors = service.bootstrap_demo()["actors"]
        pharmacist, tech, cashier = actors["PHARMACIST"], actors["TECHNICIAN"], actors["CASHIER"]
        patient = service.add_patient(tech, "POS", "SyntheticTest")
        prescriber = service.add_prescriber(tech, "POS", "DemoProvider", "MD")
        drug = service.add_drug(pharmacist, "POS-SYNTHETIC-DRUG", "1 mg", "tablet")
        product = service.add_product(pharmacist, drug, "91000-0000-01", "POS Demo", "Fictitious tablets")
        service.register_barcode(tech, product, "POS-PG-CI-BARCODE")
        expires = (date.today() + timedelta(days=180)).isoformat()
        service.receive(tech, "POS-PG-CI-BARCODE", "POS-LOT", expires, "80")
        rx = service.add_prescription(tech, patient, prescriber, drug, "POS-PG-RX", "One daily", "30")
        service.advance_to_dur(tech, rx)
        fill = service.start_fill(tech, rx)
        service.scan_source(tech, fill, "POS-PG-CI-BARCODE", "POS-LOT", expires, "30")
        service.prepare_for_review(tech, fill, [])
        service.verify(pharmacist, fill)
        service.stage_will_call(tech, fill, "BIN-PG", "BAG-PG-01")
        pos = PosService(service)
        sale = pos.checkout(cashier, lines=[{"fill_id": fill, "amount": "2.75"}],
                            tenders=[{"method": "CASH", "amount": "2.75"}],
                            scanned_bags={fill: "BAG-PG-01"},
                            recipient_name="Synthetic Recipient",
                            identity_method="DATE_OF_BIRTH", signature_method="PAPER",
                            signature_attested=True, idempotency_key="POS-PG-CI-IDEMPOTENCY")
        with service.sessions() as session:
            tx = session.get(PosTransaction, sale["id"])
            assert tx is not None and str(tx.subtotal) == "2.75"
            assert session.scalar(select(PosLine).where(PosLine.transaction_id == tx.id)) is not None
            assert session.scalar(select(FillSaleTimestamp).where(
                FillSaleTimestamp.fill_id == fill)) is not None
        DateRulesService(service).set_minimum_days(
            pharmacist, rx, 14, "PostgreSQL synthetic refill interval verification")
        assert any(block["code"] == "REFILL_TOO_SOON" for block in
                   DateRulesService(service).preview(tech, rx)["blocks"])
        refund = pos.refund(pharmacist, sale["id"], "1.25", "CASH",
                            "Postgres synthetic adjustment", "POS-PG-CI-REFUND")
        assert refund["status"] == "PARTIAL_REFUND"
        with service.sessions() as session:
            events = session.scalars(select(PosFinancialEvent).where(
                PosFinancialEvent.transaction_id == sale["id"])).all()
            assert len(events) == 2
            assert {x.kind for x in events} == {"CAPTURE_SIMULATED", "REFUND_SIMULATED"}
    finally:
        service.engine.dispose()


@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"), reason="requires isolated PostgreSQL CI service")
def test_postgres_communication_task_integrity_and_events(tmp_path):
    """Exercise communication custody on the migrated PostgreSQL schema."""
    from pharmacy1os.communications import CommunicationService, CommunicationTask, CommunicationEvent
    from pharmacy1os.documents import DocumentService

    url = os.environ["PHARMACY1OS_PG_CI_URL"]
    if not url.startswith("postgresql+psycopg://"):
        pytest.fail("Requires isolated PostgreSQL test database")
    pharmacy = PharmacyService(url)
    try:
        assert revision_at_head(pharmacy.engine)
        actors = pharmacy.bootstrap_demo()["actors"]
        tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
        patient = pharmacy.add_patient(tech, "Communication", "Synthetic")
        doctor = pharmacy.add_prescriber(tech, "Communication", "Fictional", "MD")
        drug = pharmacy.add_drug(pharmacist, "COMM-FICTIONAL-DRUG", "1 mg", "tablet")
        rx = pharmacy.add_prescription(tech, patient, doctor, drug, "COMM-PG-001", "Synthetic", "30")
        vault = DocumentService(pharmacy, tmp_path / "comm-vault")
        doc = vault.create_source(tech, rx, b"%PDF synthetic record", "application/pdf")
        communications = CommunicationService(pharmacy, vault)
        task_id = communications.create(tech, rx, doc["id"], "OUTBOUND", "FAX",
                                        "Demo office", "Clarification requested", "COMM-PG-CREATE")
        communications.change(pharmacist, task_id, "APPROVED",
                              "Source checked against immutable original", "COMM-PG-APPROVE")
        event_id = communications.change(tech, task_id, "ATTEMPT_RECORDED",
                                          "Manual attempt; delivery not verified", "COMM-PG-ATTEMPT")
        assert communications.change(tech, task_id, "ATTEMPT_RECORDED",
                                     "Manual attempt; delivery not verified", "COMM-PG-ATTEMPT") == event_id
        with pharmacy.sessions() as session:
            task = session.get(CommunicationTask, task_id)
            assert task.status == "ACTIVITY_RECORDED"
            assert task.document_sha256 == doc["sha256"]
            events = session.scalars(select(CommunicationEvent).where(
                CommunicationEvent.task_id == task_id).order_by(CommunicationEvent.sequence)).all()
            assert [e.action for e in events] == ["CREATED", "APPROVED", "ATTEMPT_RECORDED"]
            assert [e.sequence for e in events] == [1, 2, 3]
    finally:
        pharmacy.engine.dispose()


@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"), reason="requires isolated PostgreSQL CI service")
def test_postgres_structured_prescription_change_persists(tmp_path):
    """Verify real PG 17 constraints, revision, immutable document and audit record."""
    from pharmacy1os.documents import DocumentService
    from pharmacy1os.models import DocumentChange, Prescription
    from pharmacy1os.structured_changes import StructuredChangeService, StructuredChangeApplication

    url = os.environ["PHARMACY1OS_PG_CI_URL"]
    if not url.startswith("postgresql+psycopg://"):
        pytest.fail("PostgreSQL integration requires the psycopg driver")
    svc = PharmacyService(url)
    try:
        assert revision_at_head(svc.engine)
        actors = svc.bootstrap_demo()["actors"]
        tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
        patient = svc.add_patient(tech, "Structured", "DemoPatient")
        doctor = svc.add_prescriber(tech, "Structured", "DemoProvider", "MD")
        drug = svc.add_drug(pharm, "STRUCTURED-TEST-MED", "5 mg", "tablet")
        rx = svc.add_prescription(tech, patient, doctor, drug, "CHANGE-PG-001", "once daily", "30")
        documents = DocumentService(svc, tmp_path / "structured-vault")
        doc = documents.create_source(tech, rx, b"unchanging synthetic PDF", "application/pdf")
        ann = documents.annotate(tech, doc["id"], "Prescriber called", ".1", ".1", ".3", ".2",
            {"change_type": "SIG", "what_changed": "Frequency clarified",
             "reason": "Synthetic prescriber phone clarification", "communication_method": "PHONE",
             "contacted_party": "Prescriber office", "authorizing_prescriber": "Demo Provider"})
        with svc.sessions() as session:
            change_id = session.scalar(select(DocumentChange).where(DocumentChange.annotation_id == ann)).id
        applied = StructuredChangeService(svc, documents).apply(
            pharm, change_id, "twice daily",
            "Verified with fictional prescriber in synthetic test", expected_version=0)
        with svc.sessions() as session:
            prescription = session.get(Prescription, rx)
            assert prescription.sig == "twice daily" and prescription.version == 1
            event = session.scalar(select(StructuredChangeApplication).where(
                StructuredChangeApplication.change_record_id == change_id))
            assert event is not None and event.document_sha256 == doc["sha256"]
            assert event.version_after == 1 and event.version_before == 0
        assert applied["after"] == "twice daily"
        assert documents.read_source(tech, doc["id"])[0] == b"unchanging synthetic PDF"
    finally:
        svc.engine.dispose()


@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"), reason="requires isolated PostgreSQL CI service")
def test_pg_exported_snapshot_matches_python_backup_metadata():
    """Validate real PG17 exported snapshot sharing; pg_dump binary tested separately."""
    import re
    import psycopg
    from psycopg import sql
    from pharmacy1os.postgres_backup import _connection_settings, _read_pg_metadata

    options, _public = _connection_settings(os.environ["PHARMACY1OS_PG_CI_URL"])
    with psycopg.connect(**options, autocommit=True) as primary:
        with primary.cursor() as cursor:
            cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        revision, documents = _read_pg_metadata(primary)
        assert isinstance(revision, str) and revision
        assert isinstance(documents, list)
        with primary.cursor() as cursor:
            cursor.execute("SELECT pg_export_snapshot()")
            snapshot = cursor.fetchone()[0]
        assert re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+", snapshot)

        # Use the exported snapshot on a second PG transaction, just as pg_dump does.
        with psycopg.connect(**options, autocommit=True) as follower:
            with follower.cursor() as cursor:
                cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                cursor.execute(sql.SQL("SET TRANSACTION SNAPSHOT {}").format(sql.Literal(snapshot)))
            observed_revision, observed_documents = _read_pg_metadata(follower)
            assert observed_revision == revision
            assert observed_documents == documents
