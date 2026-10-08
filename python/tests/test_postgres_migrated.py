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
