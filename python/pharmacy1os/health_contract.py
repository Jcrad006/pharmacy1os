"""Synthetic API health contract aligned with the original Fastify /health.

It does not certify clinical readiness, remote deployment or live operations.
A health response is degraded on DB query failure or an unresolved local
document-vault / offline-restore recovery marker. Never clear markers here.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import os
import stat

from sqlalchemy import text


def _marker_present_or_unsafe(marker: Path) -> bool:
    try:
        metadata = marker.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    # Any present marker, including a link or unreadable marker, blocks health.
    return True


def document_recovery_required(vault_root: Path, database_url) -> bool:
    """Fail closed on original vault restore marker and Python offline journals.

    The original TS restore marker is supported as a migration compatibility
    check. Python's own restore rehearsal journal must also block readiness.
    This is a detector; it cannot replace full coordination/lease semantics.
    """
    vault = Path(vault_root)
    coordination = vault / ".coordination"
    try:
        if coordination.is_symlink():
            return True
        if coordination.exists() and not coordination.is_dir():
            return True
        if _marker_present_or_unsafe(
                coordination / "restore-recovery-required.json"):
            return True
        db_path = getattr(database_url, "database", None)
        backend = getattr(database_url, "get_backend_name", lambda: "")()
        if backend == "sqlite" and db_path and db_path != ":memory:":
            folder = Path(db_path).resolve().parent
            # Recovery rehearsal stores durable .pharmacy1os-recovery-*.json
            # next to the chosen DB destination. Never remove these journals.
            with os.scandir(folder) as entries:
                for entry in entries:
                    if (entry.name.startswith(".pharmacy1os-recovery-")
                            and entry.name.endswith(".json")):
                        return True
    except (OSError, ValueError, TypeError):
        # Path cannot be checked reliably: never publish healthy.
        return True
    return False


def api_health(service, vault_root: Path, *, synthetic_enabled: bool) -> tuple[int, dict]:
    database_ok = False
    try:
        with service.engine.connect() as connection:
            connection.execute(text("SELECT 1")).scalar_one()
        database_ok = True
    except Exception:
        database_ok = False
    vault_recovery = document_recovery_required(vault_root, service.engine.url)
    healthy = database_ok and not vault_recovery
    body = {
        "status": "ok" if healthy else "degraded",
        "service": "pharmacy1os-api",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "checks": {
            "database": database_ok,
            "documentVaultRecoveryRequired": vault_recovery,
        },
        # Preserve Python migration-specific metadata for existing clients.
        "synthetic_only": True,
        "enabled": bool(synthetic_enabled),
    }
    return (200 if healthy else 503), body
