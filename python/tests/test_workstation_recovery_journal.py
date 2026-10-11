"""Local synthetic workstation journal: crash, encryption, denial and isolation.

All test records are invented UUIDs, not real prescription or staff data.
POSIX file locking is required; these tests are supported on Linux/macOS.
"""
from __future__ import annotations

import json
import os
import stat
from uuid import uuid4

import pytest

from pharmacy1os.workstation_recovery_journal import (
    JournalSafetyError, WorkstationRecoveryJournal, MAX_ENTRIES,
)


def ids():
    return dict(request_id=str(uuid4()), prescription_id=str(uuid4()),
                site_id=str(uuid4()), staff_id=str(uuid4()),
                base_url="http://127.0.0.1:8008")


@pytest.fixture
def folder(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    return tmp_path / "recovery-preview"


def test_restart_restores_only_encrypted_request_metadata(folder):
    record = ids()
    with WorkstationRecoveryJournal(folder) as first:
        entry = first.register(**record)
        assert entry["state"] == "PENDING"
        assert first.entries_for(**{k: record[k] for k in ("site_id", "staff_id", "base_url")}) == [entry]
    ciphertext = (folder / "journal.enc").read_bytes()
    assert ciphertext != json.dumps(entry).encode()
    assert record["request_id"].encode() not in ciphertext
    assert record["prescription_id"].encode() not in ciphertext
    assert record["staff_id"].encode() not in ciphertext
    assert stat.S_IMODE((folder / "journal.enc").stat().st_mode) == 0o600
    assert stat.S_IMODE((folder / "journal.key").stat().st_mode) == 0o600
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700
    with WorkstationRecoveryJournal(folder) as restored:
        outstanding = restored.entries_for(site_id=record["site_id"],
            staff_id=record["staff_id"], base_url=record["base_url"], state="PENDING")
        assert outstanding == [entry]
        restored.mark_recorded(
            site_id=record["site_id"], staff_id=record["staff_id"],
            request_id=record["request_id"])
    with WorkstationRecoveryJournal(folder) as third:
        assert third.entries_for(site_id=record["site_id"],
            staff_id=record["staff_id"], base_url=record["base_url"], state="PENDING") == []
        assert len(third.entries_for(site_id=record["site_id"],
            staff_id=record["staff_id"], base_url=record["base_url"], state="RECORDED")) == 1
        third.acknowledge_recorded(
            site_id=record["site_id"], staff_id=record["staff_id"],
            request_id=record["request_id"])
        assert third.entries_for(site_id=record["site_id"],
            staff_id=record["staff_id"], base_url=record["base_url"]) == []


def test_pending_cannot_be_acknowledged_or_cross_account_changed(folder):
    a = ids()
    b = ids()
    with WorkstationRecoveryJournal(folder) as journal:
        journal.register(**a)
        journal.register(**b)
        with pytest.raises(JournalSafetyError, match="Only the original account"):
            journal.acknowledge_recorded(
                site_id=a["site_id"], staff_id=a["staff_id"],
                request_id=a["request_id"])
        with pytest.raises(JournalSafetyError, match="another account"):
            journal.mark_recorded(
                site_id=b["site_id"], staff_id=b["staff_id"],
                request_id=a["request_id"])
        assert journal.entries_for(site_id=a["site_id"], staff_id=b["staff_id"],
                                   base_url=a["base_url"]) == []
        assert len(journal.entries_for(site_id=a["site_id"], staff_id=a["staff_id"],
                                       base_url=a["base_url"])) == 1


def test_exclusive_lock_denies_second_desktop_and_recovers_after_close(folder):
    first = WorkstationRecoveryJournal(folder)
    try:
        with pytest.raises(JournalSafetyError, match="Another desktop"):
            WorkstationRecoveryJournal(folder)
    finally:
        first.close()
    with WorkstationRecoveryJournal(folder) as second:
        assert second.entries_for(**{k: ids()[k] for k in ("site_id", "staff_id", "base_url")}) == []


def test_corrupt_ciphertext_and_key_fail_closed_without_auto_reset(folder):
    a = ids()
    with WorkstationRecoveryJournal(folder) as journal:
        journal.register(**a)
    original = (folder / "journal.enc").read_bytes()
    (folder / "journal.enc").write_bytes(original[:-4] + b"!!!!")
    with pytest.raises(JournalSafetyError, match="decryption"):
        WorkstationRecoveryJournal(folder)
    assert (folder / "journal.enc").read_bytes() != original
    (folder / "journal.enc").write_bytes(original)
    (folder / "journal.key").unlink()
    with pytest.raises(JournalSafetyError, match="without its key"):
        WorkstationRecoveryJournal(folder)


def test_symlinks_and_world_readable_metadata_fail_closed(folder, tmp_path):
    with WorkstationRecoveryJournal(folder):
        pass
    os.chmod(folder / "journal.key", 0o644)
    with pytest.raises(JournalSafetyError, match="permissions"):
        WorkstationRecoveryJournal(folder)
    os.chmod(folder / "journal.key", 0o600)
    original = folder / "journal.key"
    target = tmp_path / "replacement.key"
    original.rename(target)
    original.symlink_to(target)
    with pytest.raises(JournalSafetyError, match="symlink"):
        WorkstationRecoveryJournal(folder)


def test_bounded_journal_refuses_65th_request_without_discarding_first(folder):
    identity = ids()
    with WorkstationRecoveryJournal(folder) as journal:
        for index in range(MAX_ENTRIES):
            journal.register(**{**identity, "request_id": str(uuid4())})
        with pytest.raises(JournalSafetyError, match="full"):
            journal.register(**{**identity, "request_id": str(uuid4())})
        result = journal.entries_for(site_id=identity["site_id"],
            staff_id=identity["staff_id"], base_url=identity["base_url"])
        assert len(result) == MAX_ENTRIES


def test_local_journal_refuses_nonloopback_origins_and_duplicate_keys(folder):
    a = ids()
    with WorkstationRecoveryJournal(folder) as journal:
        journal.register(**a)
        with pytest.raises(JournalSafetyError, match="already"):
            journal.register(**a)
        with pytest.raises(JournalSafetyError, match="localhost"):
            journal.register(**{**a, "request_id": str(uuid4()),
                                "base_url": "http://192.168.1.10:8008"})
        assert len(journal.entries_for(site_id=a["site_id"],
            staff_id=a["staff_id"], base_url=a["base_url"])) == 1


def test_opt_in_is_required(tmp_path, monkeypatch):
    monkeypatch.delenv("PHARMACY1OS_SYNTHETIC_DEMO", raising=False)
    with pytest.raises(JournalSafetyError, match="synthetic"):
        WorkstationRecoveryJournal(tmp_path / "denied")
    assert not (tmp_path / "denied").exists()
