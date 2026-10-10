"""Offline PostgreSQL custom archive safety tests. No real PostgreSQL server required.

The production pg_dump command itself requires an isolated PostgreSQL test.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import types
from uuid import uuid4

import pytest
from pharmacy1os.backup import BackupError
from pharmacy1os import postgres_backup as pg

SECRET = b"P" * 48
FLAG = "SYNTHETIC_OFFLINE_NO_WRITERS"
URL = "postgresql+psycopg://synthetic:secrets@127.0.0.1:5432/pharmacy1os_py_migration"


@pytest.fixture
def pg_world(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    vault, backups = tmp_path / "vault", tmp_path / "backups"
    vault.mkdir()
    uid, site = str(uuid4()), str(uuid4())
    payload = b"Synthetic dummy document"
    rel = f"originals/{site}/{uid}.p1doc"
    path = vault / rel
    path.parent.mkdir(parents=True)
    path.write_bytes(payload)
    row = dict(id=uid, site_id=site, storage_key=rel,
               logical_sha256=hashlib.sha256(payload).hexdigest(),
               logical_bytes=len(payload), encrypted=False)

    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *_): return False
        def execute(self, text): self.text = text
        def fetchone(self): return ("00000003-00000025-1",)
    class Connection:
        def __enter__(self): return self
        def __exit__(self, *_): return False
        def cursor(self): return Cursor()
    monkeypatch.setitem(sys.modules, "psycopg", types.SimpleNamespace(connect=lambda **kw: Connection()))
    monkeypatch.setattr(pg, "_read_pg_metadata", lambda conn: ("test-revision", [row]))
    def fake_dump(settings, dest, snapshot, pg_dump_bin="pg_dump"):
        assert snapshot == "00000003-00000025-1"
        assert settings["dbname"] == "pharmacy1os_py_migration"
        dest.write_bytes(b"PGDMP synthetic offline data")
    monkeypatch.setattr(pg, "_dump_archive", fake_dump)
    monkeypatch.setattr(pg, "_archive_catalog", lambda *a, **kw: None)
    return vault, backups, path, row


def create(world):
    return pg.create_postgres_backup(URL, world[0], world[1], signing_key=SECRET, confirm=FLAG)


def test_signed_pg_archive_preserves_stored_document_and_revision(pg_world):
    result=create(pg_world)
    assert result["status"] == "VERIFIED" and result["revision"] == "test-revision"
    folder=Path(result["path"])
    assert (folder / "documents" / pg_world[3]["storage_key"]).read_bytes() == pg_world[2].read_bytes()
    assert pg.verify_postgres_backup(folder, signing_key=SECRET)["status"] == "PASS"
    assert json.loads((folder / "manifest.json").read_text())["database"]["kind"] == "postgresql-custom"


def test_pg_tampering_database_hash_and_manifest_signature(pg_world):
    folder=Path(create(pg_world)["path"])
    (folder / "database.dump").write_bytes(b"modified")
    with pytest.raises(BackupError, match="dump hash"):
        pg.verify_postgres_backup(folder, signing_key=SECRET)
    (folder / "manifest.json").write_bytes(b"tampered")
    with pytest.raises(BackupError, match="signature"):
        pg.verify_postgres_backup(folder, signing_key=SECRET)


def test_pg_refuses_orphans_missing_docs_and_paths(pg_world):
    vault, backups, path, _ = pg_world
    (vault / "orphan.txt").write_text("orphan")
    with pytest.raises(BackupError, match="unindexed"):
        create(pg_world)
    assert not list(backups.glob("backup-*"))
    (vault / "orphan.txt").unlink()
    path.unlink()
    with pytest.raises(BackupError):
        create(pg_world)
    assert not list(backups.glob(".incomplete-*"))


def test_pg_rejects_unsafe_urls_and_unauthorized_mode(pg_world, monkeypatch):
    for url in ("postgresql://u:p@localhost/db", "postgresql+psycopg://u:p@remote.example/db",
                "postgresql+psycopg://u:p@127.0.0.1/db?sslmode=disable", "sqlite:///tmp/x"):
        with pytest.raises(BackupError):
            pg.create_postgres_backup(url, pg_world[0], pg_world[1], signing_key=SECRET, confirm=FLAG)
    monkeypatch.delenv("PHARMACY1OS_SYNTHETIC_DEMO")
    with pytest.raises(BackupError, match="synthetic"):
        create(pg_world)
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    with pytest.raises(BackupError, match="Stop every writer"):
        pg.create_postgres_backup(URL, pg_world[0], pg_world[1], signing_key=SECRET)


def test_pg_dump_credentials_are_environment_only(tmp_path, monkeypatch):
    captured=[]
    def command(args, **kw):
        captured.append((args,kw))
        (tmp_path / "data.dump").write_bytes(b"PGDMP synthetic")
        return subprocess.CompletedProcess(args,0,stdout=b"",stderr=b"")
    monkeypatch.setattr(pg.subprocess,"run",command)
    opts, public=pg._connection_settings(URL)
    pg._dump_archive({**public,"password":opts["password"]}, tmp_path/"data.dump", "00000003-00000025-1")
    argv,kwargs=captured[0]
    assert all("secrets" not in part for part in argv)
    assert kwargs["env"]["PGPASSWORD"]=="secrets"
    assert "--snapshot=00000003-00000025-1" in argv
    assert not any(x.startswith("--dbname") for x in argv)


def test_pg_rejects_bad_snapshot_without_running(tmp_path,monkeypatch):
    with pytest.raises(BackupError,match="snapshot"):
        pg._dump_archive({"host":"localhost","port":"5432","user":"x","dbname":"y","password":"z"},
                         tmp_path/"file", "something-evil;echo")
    assert not (tmp_path / "file").exists()
