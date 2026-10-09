"""Migration commands for the isolated Python-native schema (synthetic use only).

These commands intentionally do NOT migrate or touch the legacy Prisma tables.
For a previously bootstrapped local SQLite demo, `stamp-demo` requires strict
schema and SQLite integrity checks before registering the baseline migration.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.schema import ForeignKeyConstraint

from .models import Base
from . import provider_directory, scheduling_models, billing_models, willcall, pos_models, date_rules, communications, structured_changes, auth, inventory_planning, fill_completion, emergency_supply, prescription_transfer, label_printing, prescription_edit, insurance_models, claim_transactions_models  # noqa: F401 -- register all mapped extensions


class MigrationSafetyError(RuntimeError):
    pass


def migration_config() -> Config:
    path = Path(__file__).resolve().parent.parent / "alembic.ini"
    return Config(str(path))


def database_url() -> str:
    if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise MigrationSafetyError("Set PHARMACY1OS_SYNTHETIC_DEMO=1; only synthetic migration is implemented")
    url = os.getenv("PHARMACY1OS_DATABASE_URL", "").strip()
    if not url.startswith(("sqlite+pysqlite:///", "postgresql+psycopg://")):
        raise MigrationSafetyError("Explicit PHARMACY1OS_DATABASE_URL using SQLite or psycopg is required")
    return url


def verify_mapped_schema(engine: Engine) -> list[str]:
    """Check all py_* tables, mapped columns and foreign keys, without altering data."""
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    expected_tables = set(Base.metadata.tables)
    problems = [f"Missing table {name}" for name in sorted(expected_tables - existing_tables)]
    for name in sorted(expected_tables & existing_tables):
        actual = {c["name"] for c in inspector.get_columns(name)}
        mapped = set(Base.metadata.tables[name].columns.keys())
        for missing in sorted(mapped - actual):
            problems.append(f"Missing column {name}.{missing}")
        for extra in sorted(actual - mapped):
            problems.append(f"Unexpected column {name}.{extra}")
        actual_fks = {
            (tuple(fk["constrained_columns"]), fk["referred_table"], tuple(fk["referred_columns"]))
            for fk in inspector.get_foreign_keys(name)
        }
        mapped_fks = {
            (tuple(c.name for c in fk.columns),
             next(iter(fk.elements)).column.table.name,
             tuple(el.column.name for el in fk.elements))
            for fk in Base.metadata.tables[name].constraints
            if isinstance(fk, ForeignKeyConstraint)
        }
        for missing_fk in sorted(mapped_fks - actual_fks):
            problems.append(f"Missing FK in {name}: {missing_fk}")
    if engine.dialect.name == "sqlite":
        with engine.connect() as connection:
            result = connection.exec_driver_sql("PRAGMA integrity_check").scalars().all()
            if result != ["ok"]:
                problems.append(f"SQLite integrity_check failed: {result[:2]}")
            broken = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchmany(3)
            if broken:
                problems.append(f"SQLite foreign_key_check failed: {broken}")
    return problems


def revision_at_head(engine: Engine) -> bool:
    with engine.connect() as connection:
        current = MigrationContext.configure(connection).get_current_revision()
    return current == ScriptDirectory.from_config(migration_config()).get_current_head()


def stamp_existing_synthetic_sqlite(url: str, confirmation: str) -> None:
    """Register the initial migration only on an existing structurally equivalent demo DB."""
    if confirmation != "I_UNDERSTAND_SYNTHETIC_ONLY":
        raise MigrationSafetyError("stamp-demo requires --confirm I_UNDERSTAND_SYNTHETIC_ONLY")
    if not url.startswith("sqlite+pysqlite:////") or url.endswith(":memory:"):
        raise MigrationSafetyError("stamp-demo only supports an existing absolute-path SQLite file")
    from sqlalchemy.engine import make_url
    db_path = Path(make_url(url).database or "")
    if not db_path.is_file():
        raise MigrationSafetyError("Existing synthetic SQLite file not found; use upgrade for a new DB")
    engine = create_engine(url)
    try:
        tables = set(inspect(engine).get_table_names())
        unrelated = tables - set(Base.metadata.tables) - {"alembic_version", "sqlite_sequence"}
        if unrelated:
            raise MigrationSafetyError(f"Refusing to stamp database containing other tables: {sorted(unrelated)}")
        if "alembic_version" in tables:
            raise MigrationSafetyError("Alembic version table already exists; stamp is not appropriate")
        problems = verify_mapped_schema(engine)
        if problems:
            raise MigrationSafetyError("Synthetic schema mismatch: " + "; ".join(problems[:10]))
    finally:
        engine.dispose()
    command.stamp(migration_config(), "head")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Python-native synthetic database migration management")
    parser.add_argument("action", choices=["status", "upgrade", "verify", "stamp-demo"])
    parser.add_argument("--confirm", default="", help="Required confirmation for stamp-demo")
    args = parser.parse_args(argv)
    try:
        url = database_url()
        cfg = migration_config()
        if args.action == "upgrade":
            command.upgrade(cfg, "head")
        elif args.action == "stamp-demo":
            stamp_existing_synthetic_sqlite(url, args.confirm)
        else:
            engine = create_engine(url)
            try:
                current = None
                with engine.connect() as connection:
                    current = MigrationContext.configure(connection).get_current_revision()
                expected = ScriptDirectory.from_config(cfg).get_current_head()
                if args.action == "status":
                    print(f"Python migration revision: {current or '<none>'}; expected: {expected}")
                else:
                    problems = verify_mapped_schema(engine)
                    if current != expected:
                        problems.append("Database does not have current Alembic revision")
                    if problems:
                        raise MigrationSafetyError("; ".join(problems[:20]))
                    print(f"Python schema verified at {expected}")
            finally:
                engine.dispose()
        return 0
    except (MigrationSafetyError, RuntimeError) as exc:
        print(f"Migration blocked: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
