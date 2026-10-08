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
    pharmacy = PharmacyService(url)
    demo = pharmacy.bootstrap_demo()
    patient_id = pharmacy.add_patient(demo["actors"]["TECHNICIAN"], "Synthetic", "Preserved")
    pharmacy.engine.dispose()
    command.upgrade(migration_config(), "head")
    engine = create_engine(url)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT last_name FROM py_patients WHERE id=:id"),
                                  {"id": patient_id}).scalar_one() == "Preserved"
    assert revision_at_head(engine)
    assert not verify_mapped_schema(engine)
    engine.dispose()
