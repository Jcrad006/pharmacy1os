"""Offline, signed SQLite + immutable-document-vault backups for SYNTHETIC demos.

Deliberately no restore method or HTTP interface. This does not implement PostgreSQL
backup or online write coordination. Call only when all application writers are off.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import shutil
import sqlite3
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

FORMAT = "PHARMACY1OS_PYTHON_SYNTHETIC_OFFLINE_BACKUP"
MAX_MANIFEST = 4 * 1024 * 1024
MAX_DOCUMENT = 25 * 1024 * 1024 + 128
MAGIC = b"P1DV1"


class BackupError(RuntimeError):
    pass


def _require_demo_offline(confirmation: str) -> None:
    if os.environ.get("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise BackupError("Backup disabled outside explicit synthetic development mode")
    if confirmation != "SYNTHETIC_OFFLINE_NO_WRITERS":
        raise BackupError("Stop every writer and pass --confirm SYNTHETIC_OFFLINE_NO_WRITERS")


def _key(key: bytes) -> bytes:
    if not isinstance(key, bytes) or len(key) < 32:
        raise BackupError("A secret signing key of at least 32 bytes is required")
    return key


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(obj: dict) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _plain(payload: bytes, encrypted: bool, encryption_key: bytes | None) -> bytes:
    if not encrypted:
        return payload
    if encryption_key is None or len(encryption_key) != 32:
        raise BackupError("An AES-256 document key is required to verify encrypted document bytes")
    if not payload.startswith(MAGIC) or len(payload) < 34:
        raise BackupError("Invalid encrypted document header")
    try:
        return AESGCM(encryption_key).decrypt(payload[5:17], payload[33:] + payload[17:33], None)
    except Exception as exc:
        raise BackupError("Document decrypt/authentication failed") from exc


def _regular_file(path: Path, *, max_bytes: int | None = None) -> bytes:
    try:
        mode = path.lstat().st_mode
        if not stat.S_ISREG(mode):
            raise BackupError("Expected an ordinary file, not a link or special file")
        if max_bytes is not None and path.stat().st_size > max_bytes:
            raise BackupError("File exceeds configured size limit")
        return path.read_bytes()
    except (OSError, ValueError) as exc:
        raise BackupError("Missing or unreadable backup file") from exc


def _document_path(document: dict) -> str:
    try:
        site, ident = str(UUID(document["site_id"])), str(UUID(document["id"]))
    except (ValueError, KeyError, TypeError) as exc:
        raise BackupError("Unsafe document or site identifier") from exc
    relative = f"originals/{site}/{ident}.p1doc"
    if document.get("storage_key") != relative:
        raise BackupError("Document storage key is inconsistent with immutable vault path")
    return relative


def _snapshot(db_path: Path, destination: Path) -> None:
    _regular_file(db_path)
    source = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
    try:
        with sqlite3.connect(destination) as target:
            source.backup(target)
    finally:
        source.close()


def _database_documents(database: Path) -> tuple[str, list[dict]]:
    conn = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    try:
        if conn.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise BackupError("SQLite integrity check failed")
        if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise BackupError("SQLite foreign-key check failed")
        revisions = conn.execute("SELECT version_num FROM alembic_version").fetchall()
        if len(revisions) != 1 or not isinstance(revisions[0][0], str):
            raise BackupError("Expected exactly one Alembic migration revision")
        rows = conn.execute("SELECT id, site_id, storage_key, sha256, byte_size, encrypted "
                            "FROM py_documents ORDER BY id").fetchall()
        docs = [dict(zip(("id", "site_id", "storage_key", "logical_sha256", "logical_bytes", "encrypted"), row))
                for row in rows]
        return revisions[0][0], docs
    except sqlite3.DatabaseError as exc:
        raise BackupError("Required synthetic database metadata is missing or damaged") from exc
    finally:
        conn.close()


def _tree_files(root: Path) -> set[str]:
    if not root.is_dir() or root.is_symlink():
        raise BackupError("Expected an ordinary directory")
    result = set()
    for base, directories, files in os.walk(root, followlinks=False):
        for item in directories:
            directory = Path(base) / item
            if not stat.S_ISDIR(directory.lstat().st_mode):
                raise BackupError("Vault/backup contains a linked or special directory")
        for item in files:
            file = Path(base) / item
            if not stat.S_ISREG(file.lstat().st_mode):
                raise BackupError("Vault/backup contains a linked or special file")
            result.add(file.relative_to(root).as_posix())
    return result


def _check_document(document: dict, payload: bytes, key: bytes | None) -> None:
    if len(payload) > MAX_DOCUMENT or not payload:
        raise BackupError("Document payload has invalid length")
    plain = _plain(payload, bool(document["encrypted"]), key)
    if _hash(plain) != document["logical_sha256"] or len(plain) != document["logical_bytes"]:
        raise BackupError("Source document differs from immutable database metadata")


def _strict_path_isolation(database: Path, vault: Path, backups: Path) -> None:
    paths = (database.resolve(), vault.resolve(), backups.resolve())
    db, vr, br = paths
    if not db.is_file() or not vr.is_dir():
        raise BackupError("SQLite database and vault directory must already exist")
    if (br == vr or br.is_relative_to(vr) or vr.is_relative_to(br)
            or db.is_relative_to(br) or db.is_relative_to(vr)):
        raise BackupError("Database, vault and backup paths must be isolated")
    if database.is_symlink() or vault.is_symlink() or backups.is_symlink():
        raise BackupError("Symbolic links are not supported for backup roots")


def create_backup(database: Path, vault: Path, backup_root: Path, *,
                  signing_key: bytes, encryption_key: bytes | None = None,
                  confirm: str = "") -> dict:
    """Publish only a fully verified backup; caller must stop all writers."""
    _require_demo_offline(confirm)
    key = _key(signing_key)
    database, vault, backup_root = Path(database), Path(vault), Path(backup_root)
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    _strict_path_isolation(database, vault, backup_root)
    _tree_files(vault)  # Detect unexpected links before beginning.
    name = "backup-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex
    staging = backup_root / (".incomplete-" + name)
    final = backup_root / name
    staging.mkdir(mode=0o700)
    try:
        dbcopy = staging / "database.sqlite3"
        _snapshot(database, dbcopy)
        revision, documents = _database_documents(dbcopy)
        if len(documents) != len({d["id"] for d in documents}):
            raise BackupError("Duplicate document identifiers")
        expected = set()
        entries = []
        for d in documents:
            rel = _document_path(d)
            expected.add(rel)
            original = vault / rel
            payload = _regular_file(original, max_bytes=MAX_DOCUMENT)
            _check_document(d, payload, encryption_key)
            target = staging / "documents" / rel
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            entries.append({**d, "path": "documents/" + rel,
                            "payload_sha256": _hash(payload), "payload_bytes": len(payload)})
        actual = _tree_files(vault)
        if actual != expected:
            raise BackupError("Orphan or missing documents in vault; investigate before backup")
        dbbytes = _regular_file(dbcopy)
        manifest = {"format": FORMAT, "version": 1, "backup_id": name,
                    "created_utc": datetime.now(timezone.utc).isoformat(),
                    "revision": revision,
                    "database": {"path": "database.sqlite3", "sha256": _hash(dbbytes),
                                 "bytes": len(dbbytes)},
                    "document_key_sha256": _hash(encryption_key) if encryption_key else None,
                    "documents": entries}
        body = _canonical(manifest)
        if len(body) > MAX_MANIFEST:
            raise BackupError("Backup manifest exceeds safety cap")
        (staging / "manifest.json").write_bytes(body)
        (staging / "manifest.hmac").write_text(hmac.new(key, body, hashlib.sha256).hexdigest() + "\n")
        verify_backup(staging, signing_key=key, encryption_key=encryption_key,
                      expected_backup_id=name)
        os.rename(staging, final)
        return {"backup_id": name, "documents": len(entries), "revision": revision,
                "status": "VERIFIED", "path": str(final)}
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def verify_backup(folder: Path, *, signing_key: bytes,
                  encryption_key: bytes | None = None,
                  expected_backup_id: str | None = None) -> dict:
    """Always fail closed; no restore and no filesystem writes."""
    key = _key(signing_key)
    folder = Path(folder)
    manifest_bytes = _regular_file(folder / "manifest.json", max_bytes=MAX_MANIFEST)
    signature = _regular_file(folder / "manifest.hmac", max_bytes=200).decode("ascii").strip()
    if not hmac.compare_digest(hmac.new(key, manifest_bytes, hashlib.sha256).hexdigest(), signature):
        raise BackupError("Backup manifest signature verification failed")
    try:
        m = json.loads(manifest_bytes)
        if not isinstance(m, dict) or m["format"] != FORMAT or m["version"] != 1:
            raise BackupError("Unsupported backup manifest")
        if not isinstance(m["backup_id"], str) or not m["backup_id"].startswith("backup-"):
            raise BackupError("Invalid backup identifier")
        if expected_backup_id and m["backup_id"] != expected_backup_id:
            raise BackupError("Unexpected backup identifier")
        if folder.name.startswith("backup-") and m["backup_id"] != folder.name:
            raise BackupError("Manifest does not match selected backup directory")
        if m.get("document_key_sha256") != (_hash(encryption_key) if encryption_key else None):
            raise BackupError("Incorrect or missing document encryption key")
        documents = m["documents"]
        if not isinstance(documents, list):
            raise BackupError("Malformed document manifest")
        wanted = {"manifest.json", "manifest.hmac", "database.sqlite3"}
        for d in documents:
            rel = "documents/" + _document_path(d)
            if d["path"] != rel or rel in wanted:
                raise BackupError("Unsafe document path or duplicate")
            wanted.add(rel)
        if _tree_files(folder) != wanted:
            raise BackupError("Backup has missing or unlisted files")
        dbspec = m["database"]
        if dbspec["path"] != "database.sqlite3":
            raise BackupError("Unsafe database file path")
        dbbytes = _regular_file(folder / "database.sqlite3")
        if _hash(dbbytes) != dbspec["sha256"] or len(dbbytes) != dbspec["bytes"]:
            raise BackupError("Database payload integrity mismatch")
        revision, rows = _database_documents(folder / "database.sqlite3")
        if revision != m["revision"] or len(rows) != len(documents):
            raise BackupError("Database/document manifest inconsistent")
        indexed = {d["id"]: d for d in rows}
        if set(indexed) != {d["id"] for d in documents}:
            raise BackupError("Database document identities differ from manifest")
        for d in documents:
            row = indexed[d["id"]]
            if any(d[k] != row[k] for k in ("site_id", "storage_key", "logical_sha256",
                                            "logical_bytes", "encrypted")):
                raise BackupError("Document metadata differs from database")
            payload = _regular_file(folder / d["path"], max_bytes=MAX_DOCUMENT)
            if _hash(payload) != d["payload_sha256"] or len(payload) != d["payload_bytes"]:
                raise BackupError("Document payload integrity mismatch")
            _check_document(d, payload, encryption_key)
        return {"backup_id": m["backup_id"], "status": "PASS", "documents": len(documents),
                "revision": revision}
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, UnicodeError) as exc:
        raise BackupError("Invalid or unsafe backup manifest or files") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pharmacy1OS OFFLINE SYNTHETIC SQLite backup (no restore)")
    parser.add_argument("action", choices=("create", "verify"))
    parser.add_argument("--database", type=Path)
    parser.add_argument("--vault", type=Path)
    parser.add_argument("--backup-root", type=Path)
    parser.add_argument("--backup-id")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args(argv)
    try:
        _require_demo_offline(args.confirm)
        signing = os.environ.get("PHARMACY1OS_BACKUP_SIGNING_KEY", "").encode()
        raw = os.environ.get("DOCUMENT_ENCRYPTION_KEY", "")
        encrypt = bytes.fromhex(raw) if raw else None
        if args.action == "create":
            if not all((args.database, args.vault, args.backup_root)):
                raise BackupError("create requires database, vault and backup-root")
            result = create_backup(args.database, args.vault, args.backup_root,
                signing_key=signing, encryption_key=encrypt, confirm=args.confirm)
        else:
            if not args.backup_root or not args.backup_id or not args.backup_id.startswith("backup-") or "/" in args.backup_id or ".." in args.backup_id:
                raise BackupError("verify requires a safe backup-id and backup-root")
            result = verify_backup(args.backup_root / args.backup_id,
                signing_key=signing, encryption_key=encrypt,
                expected_backup_id=args.backup_id)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (BackupError, ValueError) as exc:
        print(f"Backup blocked: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
