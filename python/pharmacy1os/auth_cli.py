"""One-time offline setup for synthetic session mode; secrets never passed as CLI flags."""
from __future__ import annotations

import argparse
from getpass import getpass
import os
from sqlalchemy import inspect

from .auth import AuthService
from .db_cli import database_url, revision_at_head
from .service import PharmacyService


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline synthetic administrator enrollment")
    parser.add_argument("action", choices=["initial-admin"])
    parser.add_argument("--site-id", required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--confirm", required=True, help="Must be SYNTHETIC_OFFLINE_ONLY")
    args = parser.parse_args(argv)
    if args.confirm != "SYNTHETIC_OFFLINE_ONLY" or os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise SystemExit("Synthetic offline opt-in and explicit confirmation are required")
    url = database_url()
    if not url.startswith("sqlite+pysqlite:////"):
        raise SystemExit("Initial administrator CLI currently supports only isolated absolute-path SQLite demo DBs")
    service = PharmacyService(url)
    try:
        if not revision_at_head(service.engine):
            raise SystemExit("Upgrade the synthetic Alembic database before initializing login")
        if "py_auth_credentials" not in inspect(service.engine).get_table_names():
            raise SystemExit("Authentication schema missing")
        secret = getpass("New synthetic administrator password: ")
        if getpass("Confirm password: ") != secret:
            raise SystemExit("Passwords do not match")
        admin_id = AuthService(service).initialize_offline(args.site_id, args.username, secret)
        print(f"Synthetic administrator enrolled: {admin_id}")
        return 0
    finally:
        service.engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
