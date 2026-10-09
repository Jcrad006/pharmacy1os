"""Alembic migrations for the isolated Python-native py_* schema.

No code in this file reads or modifies legacy Prisma tables. Never run on a live
pharmacy database. This is a synthetic migration track under development.
"""
from __future__ import annotations

import os

from alembic import context
from sqlalchemy import create_engine, pool

from pharmacy1os.models import Base
from pharmacy1os import provider_directory  # noqa: F401 -- register extension tables
from pharmacy1os import scheduling_models, billing_models, willcall, pos_models, date_rules, communications, structured_changes, auth, inventory_planning  # noqa: F401 -- register Python extension tables

config = context.config
target_metadata = Base.metadata


def database_url() -> str:
    if os.environ.get("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise RuntimeError("Python schema migration is currently allowed for synthetic test databases only")
    url = os.environ.get("PHARMACY1OS_DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("PHARMACY1OS_DATABASE_URL is required for migration commands")
    if not url.startswith(("sqlite+pysqlite:///", "postgresql+psycopg://")):
        raise RuntimeError("Only explicit sqlite+pysqlite or postgresql+psycopg URLs are supported")
    return url


def include_object(object, name, type_, reflected, compare_to):
    """Never autogenerate operations against Prisma or other non-py_ tables."""
    if type_ == "table":
        return name.startswith("py_")
    if type_ in {"index", "unique_constraint", "foreign_key_constraint", "check_constraint"}:
        table = getattr(object, "table", None)
        if table is not None and not table.name.startswith("py_"):
            return False
    return True


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        include_object=include_object,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(database_url(), poolclass=pool.NullPool, future=True)
    try:
        with engine.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                compare_type=True,
                include_object=include_object,
            )
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
