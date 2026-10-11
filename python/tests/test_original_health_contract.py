"""Behavior-level /health parity with the original TypeScript Fastify route.

Fictional developer database and vault only. This health check is not an
authorization or pharmacy production-readiness endorsement.
"""
from datetime import datetime
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from pharmacy1os.api import create_app
from pharmacy1os.service import PharmacyService


@pytest.fixture
def health_env(tmp_path, monkeypatch):
    root = tmp_path / "synthetic-vault"
    root.mkdir()
    monkeypatch.setenv("DOCUMENT_STORAGE_ROOT", str(root))
    db = tmp_path / "fake-health.sqlite3"
    service = PharmacyService(f"sqlite+pysqlite:///{db}")
    service.create_schema()
    yield service, root, tmp_path
    service.engine.dispose()


def test_healthy_contract_includes_original_status_service_timestamp_and_checks(health_env):
    svc, root, _tmp = health_env
    api = TestClient(create_app(svc, synthetic_enabled=True))
    response = api.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok" and body["service"] == "pharmacy1os-api"
    assert body["checks"] == {
        "database": True, "documentVaultRecoveryRequired": False,
    }
    assert datetime.fromisoformat(body["timestamp"].replace("Z", "+00:00")).tzinfo is not None
    assert body["synthetic_only"] is True and body["enabled"] is True
    assert response.headers["Cache-Control"] == "no-store"


def test_health_degrades_on_database_connection_failure(health_env, monkeypatch):
    svc, root, _tmp = health_env
    def unreachable():
        raise OSError("synthetic database is unavailable")
    monkeypatch.setattr(svc.engine, "connect", unreachable)
    resp = TestClient(create_app(svc, synthetic_enabled=True)).get("/health")
    assert resp.status_code == 503
    assert resp.json()["status"] == "degraded"
    assert resp.json()["checks"] == {
        "database": False, "documentVaultRecoveryRequired": False,
    }
    assert "synthetic database is unavailable" not in resp.text


def test_original_document_restore_marker_blocks_python_readiness(health_env):
    svc, root, _tmp = health_env
    coordination = root / ".coordination"
    coordination.mkdir()
    marker = coordination / "restore-recovery-required.json"
    marker.write_text("not even valid JSON", encoding="utf-8")
    client = TestClient(create_app(svc, synthetic_enabled=True))
    denied = client.get("/health")
    assert denied.status_code == 503
    assert denied.json()["checks"] == {
        "database": True, "documentVaultRecoveryRequired": True,
    }
    assert "not even valid JSON" not in denied.text
    marker.unlink()
    assert client.get("/health").status_code == 200


def test_python_interrupted_restore_journal_blocks_readiness(health_env):
    svc, root, workspace = health_env
    journal = workspace / ".pharmacy1os-recovery-abcdef123456.json"
    journal.write_text('{"state":"UNRESOLVED"}', encoding="utf-8")
    client = TestClient(create_app(svc, synthetic_enabled=True))
    blocked = client.get("/health")
    assert blocked.status_code == 503
    assert blocked.json()["checks"]["documentVaultRecoveryRequired"] is True
    assert journal.exists(), "Health must never erase a recovery marker"
    journal.unlink()
    assert client.get("/health").json()["status"] == "ok"


def test_vault_symlink_coordination_blocks_health(health_env, tmp_path):
    svc, root, _ = health_env
    target = tmp_path / "other-synthetic"
    target.mkdir()
    (root / ".coordination").symlink_to(target, target_is_directory=True)
    resp = TestClient(create_app(svc, synthetic_enabled=True)).get("/health")
    assert resp.status_code == 503
    assert resp.json()["checks"]["documentVaultRecoveryRequired"] is True


def test_disabled_synthetic_api_still_returns_truthful_health(health_env):
    svc, root, _ = health_env
    app = create_app(svc, synthetic_enabled=False)
    ok = TestClient(app).get("/health")
    assert ok.status_code == 200
    assert ok.json()["enabled"] is False
    assert ok.json()["checks"]["database"] is True
    assert TestClient(app).get("/api/queue").status_code == 503


def test_original_health_source_contract_remains_reference():
    source = (Path(__file__).resolve().parents[2] /
              "apps" / "api" / "src" / "routes" / "health.ts")
    assert source.is_file(), "Original Fastify health route is needed for parity"
    text = source.read_text(encoding="utf-8")
    for required in ('app.get("/health"', "documentVaultRecoveryRequired",
                     'status: healthy ? "ok" : "degraded"', "503"):
        assert required in text
