"""Synthetic backup restore rehearsal cannot overwrite data or run online."""
import hashlib
import os
import sqlite3
from pathlib import Path
from uuid import uuid4

import pytest
from pharmacy1os.backup import create_backup, BackupError
from pharmacy1os.recovery import rehearse_sqlite_restore

SECRET = b"S" * 48
FLAG = "SYNTHETIC_OFFLINE_NO_WRITERS"


@pytest.fixture
def archive(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    db, vault, root = (tmp_path / "synthetic.sqlite3", tmp_path / "vault", tmp_path / "backups")
    vault.mkdir()
    with sqlite3.connect(db) as s:
        s.execute("CREATE TABLE alembic_version(version_num TEXT PRIMARY KEY)")
        s.execute("INSERT INTO alembic_version VALUES ('synthetic-revision')")
        s.execute("CREATE TABLE py_documents (id TEXT, site_id TEXT, storage_key TEXT, sha256 TEXT, byte_size INTEGER, encrypted BOOLEAN)")
        site, uid = str(uuid4()), str(uuid4())
        payload = b"synthetic source document only"
        rel = f"originals/{site}/{uid}.p1doc"
        p = vault / rel
        p.parent.mkdir(parents=True)
        p.write_bytes(payload)
        s.execute("INSERT INTO py_documents VALUES (?, ?, ?, ?, ?, ?)",
                  (uid, site, rel, hashlib.sha256(payload).hexdigest(), len(payload), 0))
    result = create_backup(db, vault, root, signing_key=SECRET, confirm=FLAG)
    return Path(result["path"]), tmp_path, payload


def call(archive, root, **overrides):
    args = dict(signing_key=SECRET, confirm=FLAG, confirm_target="EMPTY_DESTINATIONS_ONLY")
    args.update(overrides)
    return rehearse_sqlite_restore(archive, root / "new.sqlite3", root / "new-vault", **args)


def test_restore_rehearsal_creates_new_recoverable_database_and_vault(archive):
    folder, parent, original = archive
    result = call(folder, parent)
    assert result["status"] == "RESTORED_TO_NEW_SYNTHETIC_PATHS"
    with sqlite3.connect(parent / "new.sqlite3") as s:
        assert s.execute("SELECT version_num FROM alembic_version").fetchone() == ("synthetic-revision",)
        path = s.execute("SELECT storage_key FROM py_documents").fetchone()[0]
    assert (parent / "new-vault" / path).read_bytes() == original
    assert "COMPLETE" in Path(result["journal"]).read_text()


def test_cannot_overwrite_preexisting_database_or_vault(archive):
    folder, parent, _ = archive
    target = parent / "new.sqlite3"
    target.write_text("protected")
    with pytest.raises(BackupError, match="must not already exist"):
        call(folder, parent)
    assert target.read_text() == "protected"
    target.unlink()
    (parent / "new-vault").mkdir()
    with pytest.raises(BackupError, match="must not already exist"):
        call(folder, parent)


def test_requires_offline_and_separate_explicit_target_confirmations(archive):
    folder, parent, _ = archive
    with pytest.raises(BackupError):
        call(folder, parent, confirm="")
    with pytest.raises(BackupError):
        call(folder, parent, confirm_target="")
    assert not (parent / "new.sqlite3").exists()


def test_bad_archive_does_not_publish_destinations(archive):
    folder, parent, _ = archive
    (folder / "manifest.hmac").write_text("INVALID")
    with pytest.raises(BackupError):
        call(folder, parent)
    assert not (parent / "new.sqlite3").exists()
    assert not (parent / "new-vault").exists()


def test_symlink_parent_refused(archive):
    folder, parent, _ = archive
    (parent / "link").symlink_to(parent, target_is_directory=True)
    with pytest.raises(BackupError, match="symbolic-link"):
        rehearse_sqlite_restore(folder, parent / "link" / "new.sqlite3", parent / "new-vault",
                               signing_key=SECRET, confirm=FLAG, confirm_target="EMPTY_DESTINATIONS_ONLY")


def test_unresolved_recovery_journal_refused(archive):
    folder, parent, _ = archive
    (parent / ".pharmacy1os-recovery-prior.json").write_text('{"status":"IN_PROGRESS"}')
    with pytest.raises(BackupError, match="Unresolved recovery journal"):
        call(folder, parent)
    assert not (parent / "new.sqlite3").exists()


def test_race_does_not_replace_file_when_destination_appears(archive, monkeypatch):
    folder, parent, _ = archive
    import pharmacy1os.recovery as recovery
    original_link = recovery.os.link
    def race_link(source, destination):
        Path(destination).write_text("other application's new file")
        return original_link(source, destination)  # raises FileExistsError, never replaces
    monkeypatch.setattr(recovery.os, "link", race_link)
    with pytest.raises(FileExistsError):
        call(folder, parent)
    assert (parent / "new.sqlite3").read_text() == "other application's new file"
    assert not (parent / "new-vault").exists()


def test_cli_rehearsal_and_refuse_second_restore(archive, monkeypatch, capsys):
    from pharmacy1os.recovery import main
    folder, parent, _ = archive
    monkeypatch.setenv("PHARMACY1OS_BACKUP_SIGNING_KEY", SECRET.decode())
    argv=["rehearse", "--backup-root", str(folder.parent), "--backup-id", folder.name,
          "--target-database", str(parent / "new.sqlite3"),
          "--target-vault", str(parent / "new-vault"),
          "--confirm", FLAG, "--confirm-target", "EMPTY_DESTINATIONS_ONLY"]
    assert main(argv) == 0
    assert "RESTORED_TO_NEW_SYNTHETIC_PATHS" in capsys.readouterr().out
    assert main(argv) == 2
    assert "must not already exist" in capsys.readouterr().err
