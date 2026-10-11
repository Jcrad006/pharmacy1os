"""The session-server launcher must refuse unsafe configurations before binding."""
import pytest
from pharmacy1os.session_server import validate_loopback_configuration, validate_server_database
from pharmacy1os.service import PharmacyService


def test_loopback_requires_both_explicit_optins(monkeypatch):
    monkeypatch.delenv("PHARMACY1OS_SYNTHETIC_DEMO", raising=False)
    monkeypatch.delenv("PHARMACY1OS_LOCAL_SESSION_API", raising=False)
    with pytest.raises(RuntimeError, match="SYNTHETIC_DEMO"):
        validate_loopback_configuration("sqlite+pysqlite:////tmp/only-test.db")
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    with pytest.raises(RuntimeError, match="LOCAL_SESSION_API"):
        validate_loopback_configuration("sqlite+pysqlite:////tmp/only-test.db")


@pytest.mark.parametrize("url", [
    "sqlite+pysqlite:///local-relative.db", "sqlite+pysqlite:///:memory:",
    "sqlite+pysqlite:////tmp/demo.db?query=x",
    "postgresql+psycopg://demo:pass@192.168.1.20/demo",
    "postgresql+psycopg://demo:pass@db-host/demo",
    "postgresql+psycopg://demo:pass@127.0.0.1/demo?sslmode=disable",
    "mysql://local/database",
])
def test_loopback_rejects_nonlocal_or_unsafe_database_urls(monkeypatch, url):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    monkeypatch.setenv("PHARMACY1OS_LOCAL_SESSION_API", "1")
    with pytest.raises(RuntimeError):
        validate_loopback_configuration(url)


def test_loopback_rejects_unmigrated_and_unenrolled_synthetic_database(tmp_path):
    service = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'empty.db'}")
    try:
        with pytest.raises(RuntimeError, match="Alembic"):
            validate_server_database(service)
    finally:
        service.engine.dispose()


def test_migrated_local_session_server_requires_offline_enrollment(tmp_path, monkeypatch):
    """A migrated schema may serve local synthetic sessions only after enrollment."""
    from alembic import command
    from pharmacy1os.auth import AuthService
    from pharmacy1os.db_cli import migration_config
    url = f"sqlite+pysqlite:///{tmp_path / 'session-pilot.db'}"
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    monkeypatch.setenv("PHARMACY1OS_LOCAL_SESSION_API", "1")
    monkeypatch.setenv("PHARMACY1OS_DATABASE_URL", url)
    validate_loopback_configuration(url)
    command.upgrade(migration_config(), "head")
    svc = PharmacyService(url)
    try:
        with pytest.raises(RuntimeError, match="Enroll a synthetic administrator"):
            validate_server_database(svc)
        site = svc.bootstrap_demo()["site_id"]
        AuthService(svc).initialize_offline(
            site, "local.admin", "Local Preview Synthetic Password 2026")
        validate_server_database(svc)
    finally:
        svc.engine.dispose()
