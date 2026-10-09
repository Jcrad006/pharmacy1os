"""Signed, verified, OFFLINE-only PostgreSQL synthetic archive and document vault.

Uses a PostgreSQL exported REPEATABLE READ snapshot for pg_dump, preventing the
metadata read from differing from the database dump. It does NOT coordinate the
filesystem vault's writers: the operator MUST stop all application processes.
No restore, network backup, schedule or live PHI capability is implemented.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from uuid import uuid4

from sqlalchemy.engine import make_url

from .backup import (BackupError, MAX_DOCUMENT, MAX_MANIFEST, _canonical,
                     _check_document, _document_path, _hash, _key, _regular_file,
                     _require_demo_offline, _tree_files)

FORMAT = "PHARMACY1OS_PYTHON_PG_SYNTHETIC_OFFLINE_BACKUP"
MAX_PG_DUMP = 128 * 1024 * 1024  # safety cap: synthetic datasets only


def _connection_settings(url: str) -> tuple[dict, dict]:
    if not isinstance(url, str) or not url:
        raise BackupError("Explicit PostgreSQL database URL required")
    try:
        parsed = make_url(url)
    except (ValueError, TypeError) as exc:
        raise BackupError("Malformed PostgreSQL database URL") from exc
    if parsed.drivername != "postgresql+psycopg":
        raise BackupError("Only postgresql+psycopg synthetic database URL supported")
    host = parsed.host or "localhost"
    if host not in {"localhost", "127.0.0.1", "::1"}:
        raise BackupError("PostgreSQL backup is limited to localhost synthetic databases")
    if not parsed.database or not parsed.username or parsed.query:
        raise BackupError("PostgreSQL URL requires database, user and no additional query options")
    port = parsed.port or 5432
    options = {"host": host, "port": port, "user": parsed.username,
               "dbname": parsed.database, "password": parsed.password or ""}
    public = {"host": host, "port": str(port), "user": parsed.username, "dbname": parsed.database}
    return options, public


def _read_pg_metadata(conn) -> tuple[str, list[dict]]:
    """Read everything from one exported snapshot and refuse non-Python schemas."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT schemaname, tablename FROM pg_catalog.pg_tables "
                       "WHERE schemaname NOT IN ('pg_catalog','information_schema')")
        tables = cursor.fetchall()
        if not tables or any(schema != "public" or (name != "alembic_version" and not name.startswith("py_"))
                             for schema, name in tables):
            raise BackupError("Refusing PostgreSQL database with non-Python application tables")
        if ("public", "alembic_version") not in tables or ("public", "py_documents") not in tables:
            raise BackupError("Synthetic schema metadata tables missing")
        cursor.execute("SELECT version_num FROM public.alembic_version")
        versions = cursor.fetchall()
        if len(versions) != 1 or not versions[0][0]:
            raise BackupError("PostgreSQL database lacks one migration revision")
        cursor.execute("SELECT id, site_id, storage_key, sha256, byte_size, encrypted "
                       "FROM public.py_documents ORDER BY id")
        keys = ("id", "site_id", "storage_key", "logical_sha256", "logical_bytes", "encrypted")
        docs = [dict(zip(keys, map(lambda x: str(x) if not isinstance(x, (int, bool)) else x, row)))
                for row in cursor.fetchall()]
    return versions[0][0], docs


def _subprocess_env(settings: dict) -> dict:
    env = os.environ.copy()
    # Do not place a password or complete connection URI in argv or log output.
    for name in ("PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSERVICE", "PGSERVICEFILE"):
        env.pop(name, None)
    env.update({"PGHOST": settings["host"], "PGPORT": settings["port"],
                "PGDATABASE": settings["dbname"], "PGUSER": settings["user"],
                "PGPASSWORD": settings["password"], "PGCONNECT_TIMEOUT": "5"})
    return env


def _dump_archive(settings: dict, destination: Path, snapshot: str,
                  pg_dump_bin: str = "pg_dump") -> None:
    if not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+", snapshot):
        raise BackupError("Invalid exported PostgreSQL snapshot identifier")
    argv = [pg_dump_bin, "--format=custom", "--no-owner", "--no-acl",
            "--schema=public", "--snapshot=" + snapshot, "--file=" + str(destination)]
    try:
        completed = subprocess.run(argv, env=_subprocess_env(settings), check=False,
                                   capture_output=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackupError("pg_dump is unavailable or timed out") from exc
    if completed.returncode != 0:
        raise BackupError("pg_dump failed: verify local PostgreSQL client/server compatibility")
    _regular_file(destination, max_bytes=MAX_PG_DUMP)


def _archive_catalog(path: Path, pg_restore_bin: str = "pg_restore") -> None:
    try:
        result = subprocess.run([pg_restore_bin, "--list", str(path)], check=False,
                                capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackupError("pg_restore is unavailable or timed out") from exc
    if result.returncode != 0 or b"py_documents" not in result.stdout or b"alembic_version" not in result.stdout:
        raise BackupError("PostgreSQL archive catalog failed verification")


def _vault_safe(vault: Path, backup_root: Path) -> None:
    if not vault.is_dir() or vault.is_symlink() or backup_root.is_symlink():
        raise BackupError("Vault or backup root is missing or linked")
    v, b = vault.resolve(), backup_root.resolve()
    if b == v or b.is_relative_to(v) or v.is_relative_to(b):
        raise BackupError("Vault and backup archive directories must be distinct")
    _tree_files(vault)


def create_postgres_backup(database_url: str, vault: Path, backup_root: Path, *,
                           signing_key: bytes, encryption_key: bytes | None = None,
                           confirm: str = "", pg_dump_bin: str = "pg_dump",
                           pg_restore_bin: str = "pg_restore") -> dict:
    _require_demo_offline(confirm)
    signing_key = _key(signing_key)
    opts, settings = _connection_settings(database_url)
    vault, backup_root = Path(vault), Path(backup_root)
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    _vault_safe(vault, backup_root)
    try:
        import psycopg
    except ImportError as exc:
        raise BackupError("Install pharmacy1os[postgres] for PostgreSQL backup") from exc
    ident = "backup-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex
    stage = backup_root / (".incomplete-" + ident)
    final = backup_root / ident
    stage.mkdir(mode=0o700)
    try:
        # A separate pg_dump connection imports this precise metadata snapshot.
        with psycopg.connect(**opts, autocommit=True) as conn:
            with conn.cursor() as cursor:
                cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            revision, docs = _read_pg_metadata(conn)
            with conn.cursor() as cursor:
                cursor.execute("SELECT pg_export_snapshot()")
                snapshot = cursor.fetchone()[0]
            _dump_archive({**settings, "password": opts["password"]},
                          stage / "database.dump", snapshot, pg_dump_bin)
        _archive_catalog(stage / "database.dump", pg_restore_bin)
        entries = []
        required = set()
        for doc in docs:
            relative = _document_path(doc)
            required.add(relative)
            original = _regular_file(vault / relative, max_bytes=MAX_DOCUMENT)
            _check_document(doc, original, encryption_key)
            dest = stage / "documents" / relative
            dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            dest.write_bytes(original)
            entries.append({**doc, "path": "documents/" + relative,
                            "payload_sha256": _hash(original), "payload_bytes": len(original)})
        if _tree_files(vault) != required:
            raise BackupError("Vault contains unindexed, missing or linked documents")
        pg_bytes = _regular_file(stage / "database.dump", max_bytes=MAX_PG_DUMP)
        manifest = {"format": FORMAT, "version": 1, "backup_id": ident,
                    "created_utc": datetime.now(timezone.utc).isoformat(),
                    "database": {"kind": "postgresql-custom", "path": "database.dump",
                                 "sha256": _hash(pg_bytes), "bytes": len(pg_bytes), "revision": revision},
                    "document_key_sha256": _hash(encryption_key) if encryption_key else None,
                    "documents": entries}
        body = _canonical(manifest)
        if len(body) > MAX_MANIFEST:
            raise BackupError("PostgreSQL manifest exceeds safety cap")
        (stage / "manifest.json").write_bytes(body)
        (stage / "manifest.hmac").write_text(hmac.new(signing_key, body, hashlib.sha256).hexdigest()+"\n")
        verify_postgres_backup(stage, signing_key=signing_key, encryption_key=encryption_key,
                               expected_backup_id=ident, pg_restore_bin=pg_restore_bin)
        os.rename(stage, final)
        return {"backup_id": ident, "status": "VERIFIED", "documents": len(entries),
                "revision": revision, "path": str(final)}
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def verify_postgres_backup(folder: Path, *, signing_key: bytes,
                           encryption_key: bytes | None = None,
                           expected_backup_id: str | None = None,
                           pg_restore_bin: str = "pg_restore") -> dict:
    signing_key = _key(signing_key)
    folder = Path(folder)
    if not folder.is_dir() or folder.is_symlink():
        raise BackupError("Archive directory must be ordinary directory")
    raw = _regular_file(folder / "manifest.json", max_bytes=MAX_MANIFEST)
    signature = _regular_file(folder / "manifest.hmac", max_bytes=200).decode("ascii").strip()
    if not hmac.compare_digest(hmac.new(signing_key, raw, hashlib.sha256).hexdigest(), signature):
        raise BackupError("PostgreSQL manifest signature mismatch")
    try:
        m = json.loads(raw)
        if m["format"] != FORMAT or m["version"] != 1 or not isinstance(m["documents"], list):
            raise BackupError("Unknown PostgreSQL backup format")
        ident = m["backup_id"]
        if not re.fullmatch(r"backup-[A-Za-z0-9._-]+", ident):
            raise BackupError("Invalid backup identifier")
        if expected_backup_id and ident != expected_backup_id:
            raise BackupError("Archive identity mismatch")
        if folder.name.startswith("backup-") and folder.name != ident:
            raise BackupError("Selected archive directory and manifest disagree")
        if m.get("document_key_sha256") != (_hash(encryption_key) if encryption_key else None):
            raise BackupError("Wrong document decryption key")
        db = m["database"]
        if db["kind"] != "postgresql-custom" or db["path"] != "database.dump":
            raise BackupError("Unsafe PostgreSQL dump path")
        wanted = {"manifest.json", "manifest.hmac", "database.dump"}
        for d in m["documents"]:
            rel = "documents/" + _document_path(d)
            if d["path"] != rel or rel in wanted:
                raise BackupError("Duplicate or unsafe PostgreSQL archive document path")
            wanted.add(rel)
        if _tree_files(folder) != wanted:
            raise BackupError("Archive has missing, symlinked or unexpected files")
        payload = _regular_file(folder / "database.dump", max_bytes=MAX_PG_DUMP)
        if _hash(payload) != db["sha256"] or len(payload) != db["bytes"]:
            raise BackupError("PostgreSQL dump hash/length mismatch")
        _archive_catalog(folder / "database.dump", pg_restore_bin)
        for d in m["documents"]:
            encoded = _regular_file(folder / d["path"], max_bytes=MAX_DOCUMENT)
            if _hash(encoded) != d["payload_sha256"] or len(encoded) != d["payload_bytes"]:
                raise BackupError("Stored PostgreSQL backup document mismatch")
            _check_document(d, encoded, encryption_key)
        return {"backup_id": ident, "status": "PASS", "documents": len(m["documents"]),
                "revision": db["revision"]}
    except (OSError, ValueError, KeyError, TypeError, UnicodeError) as exc:
        raise BackupError("Invalid PostgreSQL backup manifest") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OFFLINE synthetic PostgreSQL backup (NO RESTORE)")
    parser.add_argument("action", choices=["create", "verify"])
    parser.add_argument("--vault", type=Path)
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument("--backup-id")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args(argv)
    try:
        _require_demo_offline(args.confirm)
        key = _key(os.getenv("PHARMACY1OS_BACKUP_SIGNING_KEY", "").encode())
        encrypt = bytes.fromhex(os.environ["DOCUMENT_ENCRYPTION_KEY"]) if os.getenv("DOCUMENT_ENCRYPTION_KEY") else None
        if args.action == "create":
            if args.vault is None:
                raise BackupError("Create requires --vault")
            result = create_postgres_backup(os.getenv("PHARMACY1OS_DATABASE_URL", ""), args.vault,
                        args.backup_root, signing_key=key, encryption_key=encrypt, confirm=args.confirm)
        else:
            if not args.backup_id or not re.fullmatch(r"backup-[A-Za-z0-9._-]+", args.backup_id):
                raise BackupError("Specify a safe --backup-id")
            result = verify_postgres_backup(args.backup_root / args.backup_id, signing_key=key,
                        encryption_key=encrypt, expected_backup_id=args.backup_id)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (BackupError, ValueError) as exc:
        print("PostgreSQL backup blocked: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
