"""Offline SQLite + immutable vault backup; synthetic examples only."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
from pathlib import Path
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pharmacy1os.backup import BackupError, create_backup, verify_backup, main, _canonical

SECRET = b"sandbox backup only -- no PHI " + b"Z" * 19
OFFLINE = "SYNTHETIC_OFFLINE_NO_WRITERS"


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    db, vault, root = tmp_path / "active.sqlite3", tmp_path / "vault", tmp_path / "backups"
    vault.mkdir()
    with sqlite3.connect(db) as s:
        s.execute("CREATE TABLE alembic_version (version_num TEXT PRIMARY KEY)")
        s.execute("INSERT INTO alembic_version VALUES ('demo-head')")
        s.execute("CREATE TABLE py_documents (id TEXT PRIMARY KEY, site_id TEXT, storage_key TEXT, sha256 TEXT, byte_size INTEGER, encrypted BOOLEAN)")
        s.execute("CREATE TABLE py_patient_synthetic (id TEXT PRIMARY KEY)")
        s.execute("INSERT INTO py_patient_synthetic VALUES ('synthetic')")
    return db, vault, root


def add_doc(world, *, encrypted=False, key=None):
    db,vault,_=world
    site,ident=str(uuid4()),str(uuid4())
    data=b"a fictional, non-PHI prescription scan"
    body=data
    if encrypted:
        assert key is not None
        nonce=os.urandom(12)
        raw=AESGCM(key).encrypt(nonce,data,None)
        body=b"P1DV1"+nonce+raw[-16:]+raw[:-16]
    rel=f"originals/{site}/{ident}.p1doc"
    target=vault/rel
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(body)
    with sqlite3.connect(db) as s:
        s.execute("INSERT INTO py_documents VALUES (?,?,?,?,?,?)",
                  (ident,site,rel,hashlib.sha256(data).hexdigest(),len(data),encrypted))
    return target, data


def backup(world, *, key=None):
    return create_backup(*world,signing_key=SECRET,encryption_key=key,confirm=OFFLINE)


def test_backup_verified_database_and_exact_original(world):
    target,plain=add_doc(world)
    result=backup(world)
    assert result["status"]=="VERIFIED"
    archive=Path(result["path"])
    assert (archive / "documents" / target.relative_to(world[1])).read_bytes()==plain
    assert verify_backup(archive,signing_key=SECRET)["documents"]==1
    with sqlite3.connect(archive/"database.sqlite3") as s:
        assert s.execute("SELECT id FROM py_patient_synthetic").fetchone()[0]=="synthetic"
    assert not any(x.name.startswith(".incomplete") for x in world[2].iterdir())


def test_encrypted_vault_payload_not_decrypted_in_backup(world):
    key=b"K"*32
    target,original=add_doc(world,encrypted=True,key=key)
    result=backup(world,key=key)
    archived=Path(result["path"])/"documents"/target.relative_to(world[1])
    assert archived.read_bytes()==target.read_bytes()
    assert original not in archived.read_bytes()
    assert verify_backup(archived.parents[3],signing_key=SECRET,encryption_key=key)["status"]=="PASS"
    with pytest.raises(BackupError):
        verify_backup(Path(result["path"]),signing_key=SECRET)
    with pytest.raises(BackupError):
        verify_backup(Path(result["path"]),signing_key=SECRET,encryption_key=b"J"*32)


def test_detect_payload_tampering_missing_and_unlisted(world):
    file,_=add_doc(world)
    result=backup(world)
    archive=Path(result["path"])
    payload=archive/"documents"/file.relative_to(world[1])
    payload.write_bytes(b"X"+payload.read_bytes())
    with pytest.raises(BackupError):
        verify_backup(archive,signing_key=SECRET)
    payload.unlink()
    with pytest.raises(BackupError):
        verify_backup(archive,signing_key=SECRET)
    (archive/"extra.txt").write_text("unexpected")
    with pytest.raises(BackupError):
        verify_backup(archive,signing_key=SECRET)


def test_signature_and_database_tampering(world):
    add_doc(world)
    result=backup(world)
    archive=Path(result["path"])
    with pytest.raises(BackupError):
        verify_backup(archive,signing_key=b"P"*32)
    manifest=archive/"manifest.json"
    doc=json.loads(manifest.read_text())
    doc["revision"]="tampered"
    manifest.write_bytes(_canonical(doc))
    with pytest.raises(BackupError):
        verify_backup(archive,signing_key=SECRET)
    (archive/"manifest.hmac").write_text(hmac.new(SECRET,_canonical(doc),hashlib.sha256).hexdigest())
    with pytest.raises(BackupError):
        verify_backup(archive,signing_key=SECRET)


def test_fail_closed_when_vault_invalid_or_has_orphan(world):
    add_doc(world)
    (world[1]/"orphan.bin").write_bytes(b"unindexed")
    with pytest.raises(BackupError,match="Orphan"):
        backup(world)
    assert list(world[2].glob("backup-*"))==[]
    assert list(world[2].glob(".incomplete-*"))==[]


def test_reject_symlinks_in_backup_and_vault(world):
    file,_=add_doc(world)
    file.unlink()
    file.symlink_to(world[0])
    with pytest.raises(BackupError):
        backup(world)
    file.unlink()
    file.write_bytes(b"raw")
    with pytest.raises(BackupError):
        backup(world)


def test_explicit_offline_flag_demo_and_strong_secret(world, monkeypatch):
    add_doc(world)
    with pytest.raises(BackupError,match="Stop every writer"):
        create_backup(*world, signing_key=SECRET)
    monkeypatch.delenv("PHARMACY1OS_SYNTHETIC_DEMO")
    with pytest.raises(BackupError,match="synthetic"):
        backup(world)
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO","1")
    with pytest.raises(BackupError,match="32 bytes"):
        create_backup(*world, signing_key=b"short",confirm=OFFLINE)


def test_database_fails_closed_without_migration_or_doc_table(world):
    with sqlite3.connect(world[0]) as s:
        s.execute("DROP TABLE alembic_version")
    with pytest.raises(BackupError):
        backup(world)
    assert not list(world[2].glob("backup-*"))


def test_reject_path_traversal_and_unlisted_files(world):
    add_doc(world)
    output=backup(world)
    folder=Path(output["path"])
    manifest=json.loads((folder/"manifest.json").read_text())
    manifest["documents"][0]["path"]="documents/../../escape"
    content=_canonical(manifest)
    (folder/"manifest.json").write_bytes(content)
    (folder/"manifest.hmac").write_text(hmac.new(SECRET,content,hashlib.sha256).hexdigest())
    with pytest.raises(BackupError,match="Unsafe document path"):
        verify_backup(folder,signing_key=SECRET)


def test_cli_does_not_expose_restore(world,monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO","1")
    with pytest.raises(SystemExit):
        main(["restore"])


def test_integration_with_pharmacy_service_and_immutable_documents(tmp_path, monkeypatch):
    """Exercise the actual native Python document model and AES-GCM format."""
    from pharmacy1os.service import PharmacyService
    from pharmacy1os.documents import DocumentService

    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    path = tmp_path / "integrated.sqlite3"
    svc = PharmacyService("sqlite+pysqlite:///" + str(path))
    svc.create_schema()
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE alembic_version (version_num TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO alembic_version VALUES ('synthetic-verified-version')")
    actors = svc.bootstrap_demo()["actors"]
    tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = svc.add_patient(tech, "Fictional", "Backup")
    doctor = svc.add_prescriber(tech, "Fictional", "Prescriber", "MD")
    drug = svc.add_drug(pharmacist, "Fictional Drug", "1 mg", "tablet")
    rx = svc.add_prescription(tech, patient, doctor, drug, "BACKUP-TEST-001", "once daily", "30")
    key = b"B" * 32
    docs = DocumentService(svc, tmp_path / "vault", encryption_key=key)
    payload = b"Synthetic only; no patient information"
    doc = docs.create_source(tech, rx, payload, "application/pdf")
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM py_documents").fetchone()[0] == 1
    svc.engine.dispose()
    result = create_backup(path, docs.root, tmp_path / "archive", signing_key=SECRET,
                           encryption_key=key, confirm=OFFLINE)
    assert result["documents"] == 1
    assert verify_backup(Path(result["path"]), signing_key=SECRET,
                         encryption_key=key)["status"] == "PASS"
    assert docs.read_source(tech, doc["id"])[0] == payload
