"""Synthetic identity security boundary tests; no actual patient information."""
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.auth import AuthenticationFailed, AuthService, StaffCredential, StaffSession
from pharmacy1os.models import Base, Staff, utcnow
from pharmacy1os.service import AccessDenied, Actor, PharmacyService, WorkflowError


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    db = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'auth.db'}")
    # The test module must run with existing mappings registered for the current branch.
    from pharmacy1os import auth as _auth  # noqa: F401
    Base.metadata.create_all(db.engine)
    bootstrap = db.bootstrap_demo()
    auth = AuthService(db)
    admin_id = auth.initialize_offline(bootstrap["site_id"], "first.admin", "Correct Horse Battery Stable!42")
    admin = Actor(admin_id, bootstrap["site_id"], "ADMIN")
    return db, auth, admin, bootstrap["actors"]


def test_initial_enrollment_atomic_and_no_second_admin(env):
    db, auth, admin, actors = env
    with pytest.raises(AccessDenied):
        auth.initialize_offline(admin.site_id, "another.admin", "Another Secure Passphrase 2026")
    with db.sessions() as s:
        rows = s.scalars(select(StaffCredential)).all()
        assert len(rows) == 1
        assert rows[0].password_hash != "Correct Horse Battery Stable!42"
        assert len(rows[0].password_salt) == 32


def test_authentication_revocation_password_rotation_and_duplicate_provision(env):
    _db, auth, admin, actors = env
    staff = auth.provision(admin, actors["TECHNICIAN"].id, "tech.1", "Technician Safe Passphrase 987")
    with pytest.raises(WorkflowError):
        auth.provision(admin, staff, "tech.2", "Another Valid Passphrase 123")
    result = auth.login("  TECH.1 ", "Technician Safe Passphrase 987")
    token = result["access_token"]
    assert result["role"] == "TECHNICIAN" and len(token) == 64
    assert auth.verify(token).id == staff
    assert token not in str(_db.engine)
    with _db.sessions() as s:
        session = s.scalar(select(StaffSession).where(StaffSession.staff_id == staff))
        assert token != session.token_digest
    auth.rotate_password(token, "Technician Safe Passphrase 987", "Rotated Safe Passphrase 000")
    with pytest.raises(AuthenticationFailed):
        auth.verify(token)
    with pytest.raises(AuthenticationFailed):
        auth.login("tech.1", "Technician Safe Passphrase 987")
    newer = auth.login("tech.1", "Rotated Safe Passphrase 000")["access_token"]
    auth.logout(newer)
    with pytest.raises(AuthenticationFailed):
        auth.verify(newer)


def test_lockout_persists_and_login_generic(env):
    db, auth, admin, actors = env
    auth.provision(admin, actors["CASHIER"].id, "cashier.1", "Cashier Passphrase Secure 88")
    for _ in range(5):
        with pytest.raises(AuthenticationFailed, match="Invalid username or password"):
            auth.login("cashier.1", "Wrongpassphrase123")
    with db.sessions() as s:
        row = s.scalar(select(StaffCredential).where(StaffCredential.username == "cashier.1"))
        assert row.failure_count == 5 and row.locked_until is not None
    with pytest.raises(AuthenticationFailed, match="Invalid username or password"):
        auth.login("cashier.1", "Cashier Passphrase Secure 88")
    with pytest.raises(AuthenticationFailed, match="Invalid username or password"):
        auth.login("missing.user", "Wrongpassphrase123")
    with db.sessions.begin() as s:
        row = s.scalar(select(StaffCredential).where(StaffCredential.username == "cashier.1"))
        row.locked_until = utcnow() - timedelta(minutes=1)
    assert auth.login("cashier.1", "Cashier Passphrase Secure 88")["access_token"]


def test_site_restrictions_role_downgrade_and_disabled_account(env):
    db, auth, admin, actors = env
    actor = actors["INTERN"]
    with pytest.raises(AccessDenied):
        auth.provision(actor, actors["TECHNICIAN"].id, "tech.3", "Technician Safe Passphrase 987")
    other = db.bootstrap_demo()["actors"]["TECHNICIAN"]
    with pytest.raises(WorkflowError):
        auth.provision(admin, other.id, "other.site", "Technician Safe Passphrase 987")
    auth.provision(admin, actors["TECHNICIAN"].id, "tech.1", "Technician Safe Passphrase 987")
    token = auth.login("tech.1", "Technician Safe Passphrase 987")["access_token"]
    with db.sessions.begin() as s:
        s.get(Staff, actors["TECHNICIAN"].id).role = "INTERN"
    with pytest.raises(AuthenticationFailed):
        auth.verify(token)
    with db.sessions.begin() as s:
        s.get(Staff, actors["TECHNICIAN"].id).role = "TECHNICIAN"
    token = auth.login("tech.1", "Technician Safe Passphrase 987")["access_token"]
    auth.disable(admin, actors["TECHNICIAN"].id)
    with pytest.raises(AuthenticationFailed):
        auth.verify(token)
    with pytest.raises(AccessDenied):
        auth.disable(admin, admin.id)


def test_expired_idle_and_malformed_sessions(env):
    db, auth, admin, actors = env
    auth.provision(admin, actors["AUDITOR"].id, "auditor.1", "Auditor Safe Passphrase 2026")
    tok = auth.login("auditor.1", "Auditor Safe Passphrase 2026")["access_token"]
    with pytest.raises(AuthenticationFailed):
        auth.verify("not-a-token")
    with db.sessions.begin() as s:
        row = s.scalar(select(StaffSession).where(StaffSession.staff_id == actors["AUDITOR"].id))
        row.last_seen_at = utcnow() - timedelta(minutes=31)
    with pytest.raises(AuthenticationFailed):
        auth.verify(tok)
    tok = auth.login("auditor.1", "Auditor Safe Passphrase 2026")["access_token"]
    with db.sessions.begin() as s:
        row = s.scalar(select(StaffSession).where(StaffSession.token_digest == __import__("hashlib").sha256(tok.encode()).hexdigest()))
        row.expires_at = utcnow() - timedelta(minutes=1)
    with pytest.raises(AuthenticationFailed):
        auth.verify(tok)


def test_api_uses_bearer_and_rejects_demo_impersonation(tmp_path, monkeypatch):
    # This integration test runs with the assembled current GitHub branch and its API modules.
    from pharmacy1os.api import create_app
    monkeypatch.setenv("DOCUMENT_STORAGE_ROOT", str(tmp_path / "vault"))
    svc = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'api.db'}")
    svc.create_schema()
    demo = svc.bootstrap_demo()
    auth = AuthService(svc)
    admin_id = auth.initialize_offline(demo["site_id"], "api.admin", "Initial Secure Passphrase 123")
    app = TestClient(create_app(svc, synthetic_enabled=True, auth_mode="session"))
    identity = demo["actors"]["TECHNICIAN"]
    assert app.get("/api/queue", headers={"x-demo-staff-id": identity.id}).status_code == 401
    assert app.get("/api/queue").status_code == 401
    bad = app.post("/api/auth/login", json={"username":"api.admin", "password":"NotThePassword123"})
    assert bad.status_code == 401
    login = app.post("/api/auth/login", json={"username":"api.admin", "password":"Initial Secure Passphrase 123"})
    assert login.status_code == 200
    token = login.json()["access_token"]
    headers={"Authorization":f"Bearer {token}"}
    assert app.get("/api/auth/me", headers=headers).json()["staff_id"] == admin_id
    assert app.get("/api/queue", headers=headers).status_code == 200
    assert app.get("/api/queue", headers={**headers,"x-demo-staff-id": identity.id}).status_code == 401
    provision = app.post("/api/auth/admin/enroll", headers=headers,
                         json={"staff_id":identity.id,"username":"api.tech", "password":"Technician Secure Passphrase 555"})
    assert provision.status_code == 200
    token2 = app.post("/api/auth/login", json={"username":"api.tech", "password":"Technician Secure Passphrase 555"}).json()["access_token"]
    assert app.get("/api/auth/me",headers={"Authorization":f"Bearer {token2}"}).json()["role"]=="TECHNICIAN"
    assert app.post("/api/auth/admin/disable/"+identity.id,headers={"Authorization":f"Bearer {token2}"}).status_code==403
    assert app.post("/api/auth/admin/disable/"+identity.id,headers=headers).status_code==200
    assert app.get("/api/queue",headers={"Authorization":f"Bearer {token2}"}).status_code==401
    assert app.post("/api/auth/logout",headers=headers).status_code==200
    assert app.get("/api/queue",headers=headers).status_code==401
