"""Explicit loopback-only session API for Python-native workstation migration.

This launcher refuses demo staff impersonation and refuses any unmigrated
database. It can share *synthetic* SQLite or locally bound PostgreSQL between
multiple processes, but DOES NOT support remote pharmacy workstations.
"""
from __future__ import annotations

import os

from sqlalchemy import select
from sqlalchemy.engine import make_url

from .api import create_app
from .auth import StaffCredential
from .db_cli import database_url, revision_at_head, verify_mapped_schema
from .service import PharmacyService


def validate_loopback_configuration(url: str) -> None:
    if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise RuntimeError("Explicit PHARMACY1OS_SYNTHETIC_DEMO=1 required")
    if os.getenv("PHARMACY1OS_LOCAL_SESSION_API") != "1":
        raise RuntimeError("Explicit PHARMACY1OS_LOCAL_SESSION_API=1 required")
    if url.startswith("sqlite+pysqlite:////"):
        if ":memory:" in url or "?" in url:
            raise RuntimeError("Use one isolated absolute-path synthetic SQLite file")
        return
    if url.startswith("postgresql+psycopg://"):
        parsed = make_url(url)
        if parsed.host not in ("localhost", "127.0.0.1", "::1"):
            raise RuntimeError("Only loopback PostgreSQL is supported in this preview")
        if not parsed.database or parsed.query:
            raise RuntimeError("Explicit local PostgreSQL database and no URL options required")
        return
    raise RuntimeError("Only absolute-path synthetic SQLite or loopback PostgreSQL is supported")


def validate_server_database(svc: PharmacyService) -> None:
    if not revision_at_head(svc.engine):
        raise RuntimeError("Synthetic database must be at latest Alembic revision")
    problems = verify_mapped_schema(svc.engine)
    if problems:
        raise RuntimeError("Synthetic database schema does not match migration: " + problems[0])
    with svc.sessions() as s:
        if s.scalar(select(StaffCredential.staff_id).limit(1)) is None:
            raise RuntimeError("Enroll a synthetic administrator OFFLINE before enabling session server")


def main() -> None:
    import uvicorn
    try:
        url = database_url()
        validate_loopback_configuration(url)
    except (RuntimeError, ValueError) as exc:
        raise SystemExit("Loopback workstation server refused: " + str(exc)) from None
    svc = PharmacyService(url)
    try:
        try:
            validate_server_database(svc)
        except Exception as exc:
            raise SystemExit("Loopback workstation database refused: " + str(exc)) from None
        app = create_app(svc, synthetic_enabled=True, auth_mode="session")
        # No proxy, public listener, dev impersonation, CORS, browser or live data.
        uvicorn.run(app, host="127.0.0.1", port=8008, access_log=False)
    finally:
        svc.engine.dispose()


if __name__ == "__main__":
    main()
