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


@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"), reason="requires isolated PostgreSQL CI service")
def test_postgres_concurrent_scans_do_not_over_reserve_one_lot():
    """Competing workstations may not reserve 160 synthetic units from 100."""
    from concurrent.futures import ThreadPoolExecutor
    from datetime import date, timedelta
    from threading import Barrier

    from pharmacy1os.models import FillSource
    from pharmacy1os.service import WorkflowError

    svc = PharmacyService(os.environ["PHARMACY1OS_PG_CI_URL"])
    try:
        assert revision_at_head(svc.engine)
        a = svc.bootstrap_demo()["actors"]
        tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
        patient = svc.add_patient(tech, "Concurrency", "Test")
        provider = svc.add_prescriber(tech, "Concurrency", "Doctor", "MD")
        drug = svc.add_drug(pharmacist, "CONC-SYNTHETIC-DRUG", "5mg", "tablet")
        product = svc.add_product(pharmacist, drug, "88888-0000-01", "Synthetic", "Demo capsules")
        svc.register_barcode(tech, product, "CONC-PG-BAR")
        exp = (date.today() + timedelta(days=180)).isoformat()
        stock_id = svc.receive(tech, "CONC-PG-BAR", "CONC-LOT", exp, "100")
        fills = []
        for n in (1, 2):
            rx = svc.add_prescription(tech, patient, provider, drug,
                f"CONC-PG-RX-{n}", "daily", "80")
            svc.advance_to_dur(tech, rx)
            fills.append(svc.start_fill(tech, rx))
        together = Barrier(2)

        def compete(fid):
            together.wait(timeout=10)
            try:
                svc.scan_source(tech, fid, "CONC-PG-BAR", "CONC-LOT", exp, "80")
                return "RESERVED"
            except WorkflowError:
                return "INSUFFICIENT"

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(compete, fills))
        assert sorted(results) == ["INSUFFICIENT", "RESERVED"]
        with svc.sessions() as s:
            stock = s.get(Stock, stock_id)
            assert stock.on_hand == 100
            assert stock.reserved == 80
            sources = s.scalars(select(FillSource).where(FillSource.fill_id.in_(fills))).all()
            assert len(sources) == 1 and sources[0].quantity == 80
    finally:
        svc.engine.dispose()


@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"), reason="requires isolated PostgreSQL CI service")
def test_postgres_same_fill_double_scan_serializes_on_fill_row():
    """Two operators racing the same barcode must not create two source lines."""
    from concurrent.futures import ThreadPoolExecutor
    from datetime import date, timedelta
    from threading import Barrier

    from pharmacy1os.models import FillSource
    from pharmacy1os.service import WorkflowError

    svc = PharmacyService(os.environ["PHARMACY1OS_PG_CI_URL"])
    try:
        assert revision_at_head(svc.engine)
        a = svc.bootstrap_demo()["actors"]
        tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
        patient = svc.add_patient(tech, "Concurrency", "DoubleScan")
        provider = svc.add_prescriber(tech, "Concurrency", "Doctor", "MD")
        drug = svc.add_drug(pharmacist, "CONC-SYNTHETIC-DRUG-2", "5mg", "tablet")
        product = svc.add_product(pharmacist, drug, "88888-0000-02", "Synthetic", "Demo capsules")
        svc.register_barcode(tech, product, "CONC-PG-BAR-2")
        exp = (date.today() + timedelta(days=180)).isoformat()
        stock_id = svc.receive(tech, "CONC-PG-BAR-2", "CONC-LOT-2", exp, "100")
        rx = svc.add_prescription(tech, patient, provider, drug,
            "CONC-PG-RX-SAME", "daily", "80")
        svc.advance_to_dur(tech, rx)
        fill = svc.start_fill(tech, rx)
        together = Barrier(2)

        def compete(_):
            together.wait(timeout=10)
            try:
                svc.scan_source(tech, fill, "CONC-PG-BAR-2", "CONC-LOT-2", exp, "80")
                return "RESERVED"
            except WorkflowError:
                return "DUPLICATE"

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(compete, [0, 1]))
        assert sorted(results) == ["DUPLICATE", "RESERVED"]
        with svc.sessions() as s:
            assert s.get(Stock, stock_id).reserved == 80
            assert len(s.scalars(select(FillSource).where(FillSource.fill_id == fill)).all()) == 1
    finally:
        svc.engine.dispose()



@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"),
                    reason="requires isolated PostgreSQL CI service")
def test_postgres_simultaneous_physical_bin_pick_never_double_reserves():
    """Two workstation sessions racing for one bin must not reserve past on-hand."""
    from concurrent.futures import ThreadPoolExecutor
    from datetime import date, timedelta
    from threading import Barrier

    from pharmacy1os.inventory_locations import InventoryLocationService
    from pharmacy1os.inventory_allocations import InventoryAllocationService
    from pharmacy1os.service import WorkflowError

    url = os.environ["PHARMACY1OS_PG_CI_URL"]
    if not url.startswith("postgresql+psycopg://"):
        pytest.fail("Real PostgreSQL + psycopg required")
    svc = PharmacyService(url)
    try:
        assert revision_at_head(svc.engine), "Only the freshly migrated synthetic PG schema is valid"
        actors = svc.bootstrap_demo()["actors"]
        tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
        patient = svc.add_patient(tech, "Concurrent", "Synthetic")
        doctor = svc.add_prescriber(tech, "Concurrent", "Synthetic", "MD")
        drug = svc.add_drug(pharm, "CONCURRENT-SYN-DRUG", "10mg", "tablet")
        product = svc.add_product(pharm, drug, "98980-0000-01", "Fake Demo", "Synthetic unit")
        svc.register_barcode(tech, product, "PG-LOCATION-CONCURRENCY")
        expiry = (date.today() + timedelta(days=200)).isoformat()
        stock_id = svc.receive(tech, "PG-LOCATION-CONCURRENCY", "PG-CONCURRENT-LOT",
                               expiry, "40")
        locsvc = InventoryLocationService(svc)
        location_id = locsvc.create(pharm, "CONCURRENT-A", "Synthetic concurrent bin",
                                    "BIN", is_default_receiving=True,
                                    is_default_dispensing=True)
        locsvc.activate_stock(pharm, stock_id, location_id,
            "A pharmacist counted forty demonstration units in this synthetic test bin.")
        fill_ids = []
        for index in (1, 2):
            rx = svc.add_prescription(tech, patient, doctor, drug,
                                     f"PG-LOCATION-CONCURRENT-{index}", "one daily", "30")
            svc.advance_to_dur(tech, rx)
            fill_ids.append(svc.start_fill(tech, rx))
        go = Barrier(2)

        def attempt(fill_id):
            go.wait(timeout=15)
            try:
                svc.scan_source(tech, fill_id, "PG-LOCATION-CONCURRENCY",
                                "PG-CONCURRENT-LOT", expiry, "30",
                                location_id=location_id)
                return "OK"
            except WorkflowError as exc:
                return str(exc)

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(attempt, fill_ids))
        assert outcomes.count("OK") == 1, outcomes
        assert len([o for o in outcomes if "Insufficient available stock" in o]) == 1, outcomes
        with svc.sessions() as s:
            stock = s.get(Stock, stock_id)
            assert stock.on_hand == 40 and stock.reserved == 30
            assert not verify_mapped_schema(svc.engine)
        allocations = [
            InventoryAllocationService(svc).for_fill(pharm, fid) for fid in fill_ids
        ]
        assert sorted(len(rows) for rows in allocations) == [0, 1]
        positions = locsvc.positions(tech, stock_id)
        assert positions[0]["reserved"] == "30.000"
        assert positions[0]["available"] == "10.000"
    finally:
        svc.engine.dispose()


@pytest.mark.skipif(not os.getenv("PHARMACY1OS_PG_CI_URL"),
                    reason="requires isolated PostgreSQL CI service")
def test_postgres_concurrent_reviewed_rx_edits_preserve_one_version():
    """Two native workstations cannot overwrite one another's reviewed edit."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from pharmacy1os.models import Prescription
    from pharmacy1os.prescription_directory import PrescriptionDirectory
    from pharmacy1os.prescription_edit import PrescriptionEditService
    from pharmacy1os.service import WorkflowError

    url = os.environ["PHARMACY1OS_PG_CI_URL"]
    if not url.startswith("postgresql+psycopg://"):
        pytest.fail("Concurrent edit integration requires PostgreSQL with psycopg")
    svc = PharmacyService(url)
    try:
        assert revision_at_head(svc.engine), "Use the migrated PostgreSQL schema"
        actors = svc.bootstrap_demo()["actors"]
        tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
        patient = svc.add_patient(tech, "Concurrent", "RxEditor")
        doctor = svc.add_prescriber(tech, "Synthetic", "RxEditor", "MD")
        drug = svc.add_drug(pharmacist, "Concurrent edit demo", "1 mg", "tablet")
        rx = svc.add_prescription(tech, patient, doctor, drug, "PG-EDIT-RACE", "Original SIG", "30")
        svc.advance_to_dur(tech, rx)
        ready = Barrier(2)
        editor = PrescriptionEditService(svc)

        def edit_from_workstation(index):
            ready.wait(timeout=15)
            try:
                editor.update(pharmacist, rx, {"sig": f"Reviewed SIG {index}"},
                    expected_version=0, attestation_note=f"Synthetic pharmacist review on workstation {index}")
                return "SAVED"
            except WorkflowError as exc:
                return str(exc)

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(edit_from_workstation, (1, 2)))
        assert outcomes.count("SAVED") == 1, outcomes
        assert sum("version changed" in result for result in outcomes) == 1, outcomes
        history = editor.history(pharmacist, rx)
        assert len(history) == 1 and history[0]["version_after"] == 1
        with svc.sessions() as s:
            record = s.get(Prescription, rx)
            assert record.version == 1 and record.status == "DATA_ENTRY"
            assert record.sig == history[0]["changes"]["sig"]["after"]
        directory = PrescriptionDirectory(svc)
        assert directory.audit(pharmacist, rx)["events"][0]["action"] == "RX_EDIT_REVIEWED"
        assert directory.detail(pharmacist, rx)["prescription"]["version"] == 1
        assert editor.context(pharmacist, rx)["editable"] is True
    finally:
        svc.engine.dispose()
