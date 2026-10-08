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
