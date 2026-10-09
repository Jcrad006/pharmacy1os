"""Offline *non-destructive* recovery rehearsal to two never-used synthetic paths.

This deliberately cannot restore into an existing database/vault, and does not
support PostgreSQL or live pharmacy recovery. Only approved offline test data.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from uuid import uuid4

from .backup import BackupError, _database_documents, _document_path, _require_demo_offline, _tree_files, verify_backup


def _check_parents(destination: Path, source: Path) -> None:
    # Refuse path links even in parent components (avoid using a symlinked recovery destination).
    absolute = destination.absolute()
    for parent in [absolute, *absolute.parents]:
        if parent.is_symlink():
            raise BackupError("Recovery target cannot use a symbolic-link component")
    if absolute.exists() or absolute.is_symlink():
        raise BackupError("Recovery target must not already exist")
    if absolute == source or absolute.is_relative_to(source) or source.is_relative_to(absolute):
        raise BackupError("Recovery destination must be separated from source archive")
    if not absolute.parent.is_dir():
        raise BackupError("Recovery target parent directory must already exist")


def rehearse_sqlite_restore(archive: Path, target_database: Path, target_vault: Path, *,
                            signing_key: bytes, encryption_key: bytes | None = None,
                            confirm: str = "", confirm_target: str = "") -> dict:
    """Copy a verified archive to NEW empty paths, never modify active data.

    Mark recovery journal before any target is published; a crash requires
    operator investigation, rather than deleting evidence or auto-retrying.
    """
    _require_demo_offline(confirm)
    if confirm_target != "EMPTY_DESTINATIONS_ONLY":
        raise BackupError("Recovery rehearsal requires --confirm-target EMPTY_DESTINATIONS_ONLY")
    raw_archive = Path(archive)
    if raw_archive.is_symlink():
        raise BackupError("Archive cannot be a symbolic link")
    archive, destdb, destvault = raw_archive.resolve(), Path(target_database), Path(target_vault)
    if not archive.is_dir():
        raise BackupError("Archive must be a real directory")
    _check_parents(destdb, archive)
    _check_parents(destvault, archive)
    a, b = destdb.absolute(), destvault.absolute()
    if a == b or a.is_relative_to(b) or b.is_relative_to(a):
        raise BackupError("Recovery database and vault destinations must be separate")
    checked = verify_backup(archive, signing_key=signing_key, encryption_key=encryption_key,
                            expected_backup_id=archive.name)
    if checked["status"] != "PASS":
        raise BackupError("Archive verification failed")
    with (archive / "manifest.json").open("r", encoding="utf-8") as fp:
        manifest = json.load(fp)
    journal = a.parent / (".pharmacy1os-recovery-" + uuid4().hex + ".json")
    stagedb = a.parent / (".pharmacy1os-stage-" + uuid4().hex + ".sqlite3")
    stagevault = b.parent / (".pharmacy1os-stage-" + uuid4().hex)
    published_db = published_vault = False
    try:
        # Refuse to continue after any interrupted or unreadable recovery journal.
        for previous in a.parent.glob(".pharmacy1os-recovery-*.json"):
            try:
                if previous.is_symlink() or json.loads(previous.read_text()).get("status") != "COMPLETE":
                    raise BackupError("Unresolved recovery journal present; investigate manually")
            except (OSError, ValueError, TypeError) as exc:
                raise BackupError("Unresolved recovery journal present; investigate manually") from exc
        journal.write_text(json.dumps({"status": "IN_PROGRESS", "archive": archive.name,
                                       "database": str(a), "vault": str(b)}) + "\n")
        os.chmod(journal, 0o600)
        shutil.copyfile(archive / "database.sqlite3", stagedb)
        from .backup import _hash, _regular_file
        if _hash(_regular_file(stagedb)) != manifest["database"]["sha256"]:
            raise BackupError("Recovery-stage database changed after archive verification")
        stagevault.mkdir(mode=0o700)
        for d in manifest["documents"]:
            relative = _document_path(d)
            payload = archive / "documents" / relative
            target = stagevault / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(payload, target)
            if _hash(_regular_file(target)) != d["payload_sha256"]:
                raise BackupError("Recovery-stage document changed after archive verification")
        if _tree_files(stagevault) != { _document_path(d) for d in manifest["documents"] }:
            raise BackupError("Recovery stage document set mismatch")
        revision, restored_docs = _database_documents(stagedb)
        if revision != checked["revision"] or len(restored_docs) != checked["documents"]:
            raise BackupError("Recovery stage database does not match verified backup")
        _check_parents(destdb, archive)
        _check_parents(destvault, archive)
        # os.replace/rename could overwrite a target introduced since validation.
        # Hard-link creation instead fails atomically when destination file exists.
        os.link(stagedb, a); published_db = True
        b.mkdir(mode=0o700, exist_ok=False); published_vault = True
        for item in _tree_files(stagevault):
            source = stagevault / item
            target = b / item
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as stream:
                stream.write(_regular_file(source))
        if _tree_files(b) != { _document_path(d) for d in manifest["documents"] }:
            raise BackupError("Published recovery vault document set mismatch")
        journal.write_text(json.dumps({"status": "COMPLETE", "archive": archive.name,
                                       "database": str(a), "vault": str(b)}) + "\n")
        return {"status": "RESTORED_TO_NEW_SYNTHETIC_PATHS", "revision": revision,
                "documents": len(restored_docs), "journal": str(journal)}
    except BaseException:
        # Leave a journal on failure after either target has become visible.
        # Never delete a published database or vault automatically.
        if not (published_db or published_vault):
            journal.unlink(missing_ok=True)
        raise
    finally:
        stagedb.unlink(missing_ok=True)
        if stagevault.exists():
            shutil.rmtree(stagevault)


def main(argv: list[str] | None = None) -> int:
    import argparse
    import sys
    parser = argparse.ArgumentParser(description="Non-destructive synthetic SQLite recovery rehearsal")
    parser.add_argument("action", choices=["rehearse"])
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument("--backup-id", required=True)
    parser.add_argument("--target-database", type=Path, required=True)
    parser.add_argument("--target-vault", type=Path, required=True)
    parser.add_argument("--confirm", default="")
    parser.add_argument("--confirm-target", default="")
    args = parser.parse_args(argv)
    try:
        import re
        if not re.fullmatch(r"backup-[A-Za-z0-9._-]+", args.backup_id):
            raise BackupError("Invalid backup ID")
        signing = os.environ.get("PHARMACY1OS_BACKUP_SIGNING_KEY", "").encode()
        document_hex = os.environ.get("DOCUMENT_ENCRYPTION_KEY", "")
        encryption = bytes.fromhex(document_hex) if document_hex else None
        result = rehearse_sqlite_restore(args.backup_root / args.backup_id,
            args.target_database, args.target_vault, signing_key=signing,
            encryption_key=encryption, confirm=args.confirm,
            confirm_target=args.confirm_target)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (BackupError, ValueError, OSError) as exc:
        print("Recovery rehearsal blocked: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
