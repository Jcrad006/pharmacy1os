"""Encrypted, bounded synthetic-only local metadata journal for uncertain Rx edits.

No PHI, Rx content, clinical note, JWT/token or reviewed field values are stored.
This is not production secure storage or a trusted system audit record.
Single-process POSIX lock required: multiple desktops must use separate journals.
"""
from __future__ import annotations

import fcntl
import json
import os
import stat
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken

MAX_ENTRIES = 64
MAX_CIPHERTEXT_BYTES = 64 * 1024
SCHEMA_VERSION = 1
ALLOWED_STATES = {"PENDING", "RECORDED"}
ENTRY_FIELDS = {"request_id", "prescription_id", "site_id", "staff_id", "base_url",
                "state", "created_at"}


class JournalSafetyError(RuntimeError):
    """Recovery state cannot be trusted: block subsequent Rx submissions."""


def _uuid(value: str) -> str:
    try:
        parsed = UUID(value)
    except (ValueError, TypeError, AttributeError) as exc:
        raise JournalSafetyError("Invalid synthetic request/account identifier") from exc
    if not isinstance(value, str) or str(parsed) != value or parsed.version != 4:
        raise JournalSafetyError("Only canonical UUIDv4 identifiers are accepted")
    return value


def _private_path(path: Path, *, directory: bool) -> None:
    if path.is_symlink():
        raise JournalSafetyError("Refusing symlink in local recovery journal")
    if not path.exists():
        raise JournalSafetyError("Recovery journal path is missing")
    st = path.stat()
    if directory and not stat.S_ISDIR(st.st_mode):
        raise JournalSafetyError("Recovery journal directory is not a directory")
    if not directory and not stat.S_ISREG(st.st_mode):
        raise JournalSafetyError("Recovery journal file is not regular")
    if st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise JournalSafetyError("Recovery journal permissions/ownership are unsafe")


def _new_file(path: Path, payload: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    _private_path(path, directory=False)


def _read_file(path: Path, *, limit: int) -> bytes:
    _private_path(path, directory=False)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise JournalSafetyError("Recovery journal file permissions changed")
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise JournalSafetyError("Recovery journal exceeded bounded storage limit")
    return raw


def _validate_entry(item: dict) -> dict:
    if not isinstance(item, dict) or set(item) != ENTRY_FIELDS:
        raise JournalSafetyError("Unrecognized recovery journal entry schema")
    for field in ("request_id", "prescription_id", "site_id", "staff_id"):
        _uuid(item[field])
    from .remote_preview import LocalSessionWorkstationClient
    # Reuse exact loopback origin validation: never accept network endpoints.
    try:
        client = LocalSessionWorkstationClient(item["base_url"])
    except (TypeError, ValueError) as exc:
        raise JournalSafetyError("Invalid localhost origin in recovery journal") from exc
    if client.base_url != item["base_url"] or item["state"] not in ALLOWED_STATES:
        raise JournalSafetyError("Unexpected origin or state in recovery journal")
    try:
        instant = datetime.fromisoformat(item["created_at"])
    except (TypeError, ValueError) as exc:
        raise JournalSafetyError("Invalid recovery journal timestamp") from exc
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise JournalSafetyError("Recovery journal timestamp must have timezone")
    return dict(item)


class WorkstationRecoveryJournal:
    """Crash-safe encrypted metadata, serialized by a POSIX exclusive lock.

    A journal is locked for the lifetime of this object. A simultaneous second
    process must fail before touching any state, rather than corrupting entries.
    """
    def __init__(self, root: Path | None = None):
        if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
            raise JournalSafetyError("Recovery journal requires explicit synthetic demo mode")
        self.root = Path(root) if root is not None else (
            Path.home() / ".pharmacy1os" / "synthetic" / "workstation-recovery")
        self._lock_fd = None
        self._cipher = None
        self._ensure_private_directory()
        try:
            self._acquire_lock()
            self._initialize_key()
            self._read_entries()
        except BaseException:
            self.close()
            raise

    def _ensure_private_directory(self):
        # For the default root, protect every managed directory, and refuse
        # a preexisting permissive/symlinked parent rather than chmod silently.
        owned = [self.root]
        if self.root.name == "workstation-recovery":
            owned = [self.root.parent.parent, self.root.parent, self.root]
        for item in owned:
            if not item.exists() and not item.is_symlink():
                item.mkdir(mode=0o700)
            _private_path(item, directory=True)

    def _acquire_lock(self):
        path = self.root / "journal.lock"
        if not path.exists() and not path.is_symlink():
            _new_file(path, b"")
        _private_path(path, directory=False)
        fd = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError) as exc:
            os.close(fd)
            raise JournalSafetyError("Another desktop owns this recovery journal") from exc
        self._lock_fd = fd

    def _initialize_key(self):
        key_path = self.root / "journal.key"
        if not key_path.exists() and not key_path.is_symlink():
            # Never silently replace a lost key when encrypted journal exists.
            data_path = self.root / "journal.enc"
            if data_path.exists() or data_path.is_symlink():
                raise JournalSafetyError("Encrypted recovery journal exists without its key")
            _new_file(key_path, Fernet.generate_key())
        key = _read_file(key_path, limit=100)
        try:
            self._cipher = Fernet(key)
        except (ValueError, TypeError) as exc:
            raise JournalSafetyError("Invalid local recovery journal key") from exc

    def _read_entries(self) -> list[dict]:
        path = self.root / "journal.enc"
        if not path.exists() and not path.is_symlink():
            return []
        raw = _read_file(path, limit=MAX_CIPHERTEXT_BYTES)
        try:
            decoded = json.loads(self._cipher.decrypt(raw))
        except (InvalidToken, ValueError, TypeError, UnicodeDecodeError) as exc:
            raise JournalSafetyError("Recovery journal authentication/decryption failed") from exc
        if (not isinstance(decoded, dict) or set(decoded) != {"version", "entries"}
                or type(decoded["version"]) is not int or decoded["version"] != SCHEMA_VERSION
                or not isinstance(decoded["entries"], list)
                or len(decoded["entries"]) > MAX_ENTRIES):
            raise JournalSafetyError("Invalid encrypted recovery journal schema")
        seen = set()
        entries = []
        for original in decoded["entries"]:
            entry = _validate_entry(original)
            if entry["request_id"] in seen:
                raise JournalSafetyError("Duplicate request ID in recovery journal")
            seen.add(entry["request_id"])
            entries.append(entry)
        return entries

    def _save(self, entries: list[dict]) -> None:
        if len(entries) > MAX_ENTRIES:
            raise JournalSafetyError("Recovery journal is full; reconcile or export requests first")
        body = json.dumps({"version": SCHEMA_VERSION, "entries": entries},
                          separators=(",", ":"), sort_keys=True).encode("utf-8")
        encrypted = self._cipher.encrypt(body)
        if len(encrypted) > MAX_CIPHERTEXT_BYTES:
            raise JournalSafetyError("Recovery journal exceeds maximum encrypted size")
        journal = self.root / "journal.enc"
        if journal.exists() or journal.is_symlink():
            _private_path(journal, directory=False)
        temporary = self.root / ("journal." + os.urandom(10).hex() + ".tmp")
        _new_file(temporary, encrypted)
        try:
            os.replace(temporary, journal)
            fd = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            temporary.unlink(missing_ok=True)

    def register(self, *, request_id: str, prescription_id: str,
                 site_id: str, staff_id: str, base_url: str) -> dict:
        entry = _validate_entry({
            "request_id": request_id, "prescription_id": prescription_id,
            "site_id": site_id, "staff_id": staff_id, "base_url": base_url,
            "state": "PENDING", "created_at": datetime.now(timezone.utc).isoformat(),
        })
        entries = self._read_entries()
        if any(r["request_id"] == request_id for r in entries):
            raise JournalSafetyError("This request ID is already in recovery journal")
        # Fsync the pending request BEFORE making any HTTP mutation.
        self._save(entries + [entry])
        return entry

    def entries_for(self, *, site_id: str, staff_id: str, base_url: str,
                    state: str | None = None) -> list[dict]:
        for value in (site_id, staff_id):
            _uuid(value)
        if state not in (None, "PENDING", "RECORDED"):
            raise JournalSafetyError("Invalid recovery entry filter")
        from .remote_preview import LocalSessionWorkstationClient
        validated = LocalSessionWorkstationClient(base_url).base_url
        return [entry for entry in self._read_entries()
                if (entry["site_id"] == site_id and entry["staff_id"] == staff_id
                    and entry["base_url"] == validated
                    and (state is None or entry["state"] == state))]

    def mark_recorded(self, *, site_id: str, staff_id: str, request_id: str) -> None:
        _uuid(site_id)
        _uuid(staff_id)
        _uuid(request_id)
        entries = self._read_entries()
        found = False
        for entry in entries:
            if entry["request_id"] == request_id:
                if entry["site_id"] != site_id or entry["staff_id"] != staff_id:
                    raise JournalSafetyError("Cannot update another account's request receipt")
                entry["state"] = "RECORDED"
                found = True
        if not found:
            raise JournalSafetyError("Recovery request ID is not recorded in local journal")
        self._save(entries)

    def acknowledge_recorded(self, *, site_id: str, staff_id: str,
                             request_id: str) -> None:
        """Only an explicitly acknowledged RECORDED request can be discarded."""
        _uuid(site_id)
        _uuid(staff_id)
        _uuid(request_id)
        entries = self._read_entries()
        target = next((x for x in entries if x["request_id"] == request_id), None)
        if (target is None or target["site_id"] != site_id
                or target["staff_id"] != staff_id or target["state"] != "RECORDED"):
            raise JournalSafetyError("Only the original account may acknowledge a recorded receipt")
        self._save([x for x in entries if x["request_id"] != request_id])

    def close(self):
        if self._lock_fd is not None:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(self._lock_fd)
                self._lock_fd = None

    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _traceback):
        self.close()
