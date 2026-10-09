"""Safety and preservation tests for versioned synthetic Python DB migrations."""
from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text

from pharmacy1os.db_cli import (
    MigrationSafetyError, database_url, main, migration_config,
    revision_at_head, stamp_existing_synthetic_sqlite, verify_mapped_schema,
)
from pharmacy1os.models import Base
from pharmacy1os.service import PharmacyService


def url_for(path: Path) -> str:
    return f"sqlite+pysqlite:///{path}"


def setup_env(monkeypatch, path: Path) -> str:
    url = url_for(path)
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    monkeypatch.setenv("PHARMACY1OS_DATABASE_URL", url)
    return url


def test_empty_database_requires_explicit_synthetic_flag(monkeypatch, tmp_path):
    monkeypatch.delenv("PHARMACY1OS_SYNTHETIC_DEMO", raising=False)
    monkeypatch.setenv("PHARMACY1OS_DATABASE_URL", url_for(tmp_path / "blocked.db"))
    with pytest.raises(MigrationSafetyError):
        database_url()
    with pytest.raises(RuntimeError, match="synthetic"):
        command.upgrade(migration_config(), "head")
    assert not (tmp_path / "blocked.db").exists()


def test_fresh_migration_create_and_verify(monkeypatch, tmp_path):
    url = setup_env(monkeypatch, tmp_path / "migrated.db")
    assert main(["upgrade"]) == 0
    engine = create_engine(url)
    try:
        assert revision_at_head(engine)
        assert not verify_mapped_schema(engine)
        assert set(Base.metadata.tables) <= set(inspect(engine).get_table_names())
    finally:
        engine.dispose()
    assert main(["verify"]) == 0


def test_new_database_does_not_drop_unrelated_tables(monkeypatch, tmp_path):
    url = setup_env(monkeypatch, tmp_path / "multi.db")
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE legacy_prescriptions (id INTEGER PRIMARY KEY, note TEXT)"))
        connection.execute(text("INSERT INTO legacy_prescriptions(note) VALUES ('preserved')"))
    engine.dispose()
    command.upgrade(migration_config(), "head")
    engine = create_engine(url)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT note FROM legacy_prescriptions")).scalar_one() == "preserved"
    assert not verify_mapped_schema(engine)
    engine.dispose()


def test_existing_demo_stamp_preserves_records(monkeypatch, tmp_path):
    url = setup_env(monkeypatch, tmp_path / "existing-demo.db")
    service = PharmacyService(url)
    service.create_schema()
    ids = service.bootstrap_demo()
    actor = ids["actors"]["PHARMACIST"]
    patient_id = service.add_patient(actor, "Synthetic", "Example")
    service.engine.dispose()
    stamp_existing_synthetic_sqlite(url, "I_UNDERSTAND_SYNTHETIC_ONLY")
    new_engine = create_engine(url)
    assert revision_at_head(new_engine)
    with new_engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM py_patients WHERE id=:id"), {"id":patient_id}).scalar_one() == 1
    new_engine.dispose()


def test_stamp_refuses_unrelated_tables(monkeypatch, tmp_path):
    url = setup_env(monkeypatch, tmp_path / "unsafe.db")
    service = PharmacyService(url)
    service.create_schema()
    with service.engine.begin() as connection:
        connection.execute(text("CREATE TABLE legacy_prescription (id INTEGER PRIMARY KEY)"))
    service.engine.dispose()
    with pytest.raises(MigrationSafetyError, match="other tables"):
        stamp_existing_synthetic_sqlite(url, "I_UNDERSTAND_SYNTHETIC_ONLY")


def test_stamp_refuses_schema_drift(monkeypatch, tmp_path):
    url = setup_env(monkeypatch, tmp_path / "drift.db")
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE py_sites (id VARCHAR(36) PRIMARY KEY)"))
    engine.dispose()
    with pytest.raises(MigrationSafetyError, match="mismatch"):
        stamp_existing_synthetic_sqlite(url, "I_UNDERSTAND_SYNTHETIC_ONLY")


def test_stamp_requires_human_confirmation(monkeypatch, tmp_path):
    url = setup_env(monkeypatch, tmp_path / "demo.db")
    service = PharmacyService(url)
    service.create_schema()
    service.engine.dispose()
    with pytest.raises(MigrationSafetyError, match="confirm"):
        stamp_existing_synthetic_sqlite(url, "")


def test_invalid_migration_url_refused(monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    monkeypatch.setenv("PHARMACY1OS_DATABASE_URL", "postgresql://example/unsafe")
    with pytest.raises(MigrationSafetyError, match="Explicit"):
        database_url()


def test_incremental_upgrade_preserves_prior_patient_rows(monkeypatch, tmp_path):
    """Version 2 must be additive to a populated version 1 synthetic database."""
    url = setup_env(monkeypatch, tmp_path / "forward.db")
    command.upgrade(migration_config(), "63ff0bb0a4d8")
    # Seed an *old-revision* fixture with old-revision SQL, not the latest ORM,
    # which now references columns that did not yet exist at revision 63ff.
    from uuid import uuid4
    patient_id, site_id = str(uuid4()), str(uuid4())
    old_engine = create_engine(url)
    with old_engine.begin() as connection:
        connection.execute(text("INSERT INTO py_sites (id, name) VALUES (:id, :name)"),
                           {"id": site_id, "name": "Original synthetic site"})
        connection.execute(text("INSERT INTO py_patients "
                                "(id, site_id, first_name, last_name) "
                                "VALUES (:id, :site_id, :first_name, :last_name)"),
                           {"id": patient_id, "site_id": site_id,
                            "first_name": "Synthetic", "last_name": "Preserved"})
    old_engine.dispose()
    command.upgrade(migration_config(), "head")
    engine = create_engine(url)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT last_name FROM py_patients WHERE id=:id"),
                                  {"id": patient_id}).scalar_one() == "Preserved"
    assert revision_at_head(engine)
    assert not verify_mapped_schema(engine)
    engine.dispose()



def test_rx_metadata_migration_preserves_populated_previous_revision(monkeypatch, tmp_path):
    """Prove upgrade from the prior deployed synthetic schema retains all records."""
    from uuid import uuid4
    from pharmacy1os.models import Drug, Prescription, Product, Patient
    url = setup_env(monkeypatch, tmp_path / "prior-rx-metadata.db")
    command.upgrade(migration_config(), "a8f167bf70d2")
    ids = {name: str(uuid4()) for name in (
        "site", "patient", "prescriber", "drug", "product", "rx")}
    engine = create_engine(url)
    try:
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO py_sites(id, name) VALUES (:id, :name)"),
                {"id": ids["site"], "name": "Original synthetic pharmacy"})
            conn.execute(text("INSERT INTO py_patients(id, site_id, first_name, last_name) "
                              "VALUES (:id, :site, 'Synthetic', 'Preserved')"),
                {"id": ids["patient"], "site": ids["site"]})
            conn.execute(text("INSERT INTO py_prescribers "
                              "(id, site_id, first_name, last_name, practice_level) "
                              "VALUES (:id, :site, 'Synthetic', 'Prescriber', 'MD')"),
                {"id": ids["prescriber"], "site": ids["site"]})
            conn.execute(text("INSERT INTO py_drugs "
                              "(id, name, strength, dosage_form, controlled) "
                              "VALUES (:id, 'OldDrug', '10 mg', 'tablet', 0)"),
                {"id": ids["drug"]})
            conn.execute(text("INSERT INTO py_products "
                              "(id, drug_id, ndc, manufacturer, description, unit, unit_price) "
                              "VALUES (:id, :drug, '88888-8888-01', 'Demo', 'Old product', "
                              "'each', 0)"),
                {"id": ids["product"], "drug": ids["drug"]})
            conn.execute(text("INSERT INTO py_prescriptions "
                              "(id, site_id, patient_id, prescriber_id, drug_id, rx_number, "
                              "sig, quantity, refills_allowed, refills_used, status, version) "
                              "VALUES (:id, :site, :patient, :prescriber, :drug, "
                              "'SYNTH-OLD-RX', 'one daily', 30, 0, 0, 'DATA_ENTRY', 0)"),
                {"id": ids["rx"], "site": ids["site"],
                 "patient": ids["patient"], "prescriber": ids["prescriber"],
                 "drug": ids["drug"]})
    finally:
        engine.dispose()
    command.upgrade(migration_config(), "head")
    svc = PharmacyService(url)
    try:
        with svc.sessions() as s:
            rx = s.get(Prescription, ids["rx"])
            drug = s.get(Drug, ids["drug"])
            product = s.get(Product, ids["product"])
            patient = s.get(Patient, ids["patient"])
            assert rx.source_type == "MANUAL"
            assert rx.product_selection_directive == "UNSPECIFIED"
            assert rx.prescribed_product_id is None
            assert rx.sig == "one daily"
            assert drug.controlled_substance_schedule == "UNCLASSIFIED"
            assert drug.active and product.active and patient.email is None
        assert revision_at_head(svc.engine)
        assert not verify_mapped_schema(svc.engine)
    finally:
        svc.engine.dispose()



def test_location_tracking_upgrade_preserves_old_stock_without_fabricating_shelf(monkeypatch, tmp_path):
    """Older synthetic inventory is not assigned an invented physical shelf on upgrade."""
    from uuid import uuid4
    from pharmacy1os.models import Stock
    from pharmacy1os.inventory_location_models import InventoryStockPosition
    url = setup_env(monkeypatch, tmp_path / "before-location-parity.db")
    command.upgrade(migration_config(), "e48f2d6a47cb")
    ids = {name: str(uuid4()) for name in ("site", "drug", "product", "stock")}
    engine = create_engine(url)
    try:
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO py_sites(id,name) VALUES (:id, 'Older synthetic site')"),
                         {"id": ids["site"]})
            conn.execute(text("INSERT INTO py_drugs(id,name,strength,dosage_form,controlled,"
                              "controlled_substance_schedule) VALUES "
                              "(:id,'TEST-OLD','10 mg','tablet',0,'NONE')"),
                         {"id": ids["drug"]})
            conn.execute(text("INSERT INTO py_products "
                              "(id,drug_id,ndc,manufacturer,description,unit,unit_price) "
                              "VALUES (:id,:drug,'99999-1111-22','Test','Synthetic old units','each',0)"),
                         {"id": ids["product"], "drug": ids["drug"]})
            conn.execute(text("INSERT INTO py_stock "
                              "(id,site_id,product_id,lot,expires,on_hand,reserved,quarantined) "
                              "VALUES (:id,:site,:product,'STOCK-OLD','2099-01-01',100,0,0)"),
                         {"id": ids["stock"], "site": ids["site"],
                          "product": ids["product"]})
    finally:
        engine.dispose()
    command.upgrade(migration_config(), "head")
    svc = PharmacyService(url)
    try:
        with svc.sessions() as session:
            old = session.get(Stock, ids["stock"])
            assert old.on_hand == 100
            assert old.reserved == 0 and old.quarantined == 0
            assert old.location_tracking_enabled is False
            assert session.query(InventoryStockPosition).filter_by(stock_id=old.id).count() == 0
        assert revision_at_head(svc.engine)
        assert not verify_mapped_schema(svc.engine)
    finally:
        svc.engine.dispose()
