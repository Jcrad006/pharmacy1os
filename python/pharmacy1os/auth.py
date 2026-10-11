"""Synthetic-development account credentials and revocable API sessions.

Deliberately NOT a production identity provider or HIPAA-ready deployment.
No client-chosen staff identities are accepted by session-mode API endpoints.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Audit, Base, Site, Staff, utcnow
from .service import AccessDenied, Actor, PharmacyService, WorkflowError

SESSION_HOURS = 8
IDLE_MINUTES = 30
LOCKOUT_MINUTES = 15
MAX_FAILURES = 5
USERNAME_RE = re.compile(r"[a-z][a-z0-9._-]{2,63}\Z")
DUMMY_SALT = b"Pharmacy1OSDemo!"  # timing work only; not used to store credentials


class AuthenticationFailed(PermissionError):
    """Generic authentication rejection: never reveal account existence."""


class StaffCredential(Base):
    __tablename__ = "py_auth_credentials"
    staff_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), primary_key=True)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    username: Mapped[str] = mapped_column(String(64))
    password_salt: Mapped[str] = mapped_column(String(32))
    password_hash: Mapped[str] = mapped_column(String(64))
    password_version: Mapped[int] = mapped_column(Integer, default=1)
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (UniqueConstraint("username", name="uq_py_auth_credentials_username"),)


class StaffSession(Base):
    __tablename__ = "py_auth_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    token_digest: Mapped[str] = mapped_column(String(64))
    staff_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), index=True)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), index=True)
    role_snapshot: Mapped[str] = mapped_column(String(30))
    password_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __table_args__ = (UniqueConstraint("token_digest", name="uq_py_auth_sessions_token_digest"),)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _username(value: str) -> str:
    if not isinstance(value, str):
        raise WorkflowError("Username must be 3-64 lowercase letters, digits or ._- characters")
    cleaned = value.strip().lower()
    if not USERNAME_RE.fullmatch(cleaned):
        raise WorkflowError("Username must be 3-64 lowercase letters, digits or ._- characters")
    return cleaned


def _password(value: str) -> bytes:
    if not isinstance(value, str):
        raise WorkflowError("A password is required")
    raw = value.encode("utf-8")
    if len(raw) < 12 or len(raw) > 256 or b"\0" in raw or not value.strip():
        raise WorkflowError("Password must contain 12-256 UTF-8 bytes and not be blank")
    return raw


def _derive(raw: bytes, salt: bytes) -> str:
    return hashlib.scrypt(raw, salt=salt, n=2**14, r=8, p=1, dklen=32).hex()


def _digest(token: str) -> str:
    if not isinstance(token, str) or len(token) != 64 or not re.fullmatch(r"[A-Za-z0-9_-]{64}", token):
        raise AuthenticationFailed("Authentication required")
    return hashlib.sha256(token.encode("ascii")).hexdigest()


class AuthService:
    def __init__(self, service: PharmacyService):
        self.service = service

    @staticmethod
    def _create_credential(s, staff: Staff, username: str, password: str) -> StaffCredential:
        salt = secrets.token_bytes(16)
        row = StaffCredential(staff_id=staff.id, site_id=staff.site_id,
                              username=_username(username), password_salt=salt.hex(),
                              password_hash=_derive(_password(password), salt),
                              password_version=1, failure_count=0)
        s.add(row)
        return row

    def initialize_offline(self, site_id: str, username: str, password: str) -> str:
        """One-time offline synthetic enrollment; CLI requires explicit safety gate."""
        if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
            raise AccessDenied("Synthetic offline initial-admin enrollment is disabled")
        with self.service.sessions.begin() as s:
            if s.get(Site, site_id) is None:
                raise WorkflowError("Synthetic pharmacy site not found")
            if s.scalar(select(StaffCredential.staff_id).limit(1)) is not None:
                raise AccessDenied("An administrator is already enrolled; use administrator provisioning")
            admin = Staff(site_id=site_id, name="Synthetic Bootstrap Administrator", role="ADMIN")
            s.add(admin)
            s.flush()
            self._create_credential(s, admin, username, password)
            self.service._audit(s, Actor(admin.id, site_id, "ADMIN"), "AUTH_INITIAL_ADMIN_ENROLLED", admin.id,
                                {"initial": True})
            return admin.id

    def provision(self, actor: Actor, staff_id: str, username: str, password: str) -> str:
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            if actor.role != "ADMIN":
                raise AccessDenied("Only the synthetic administrator can manage credentials")
            staff = self.service._site(s, Staff, staff_id, actor)
            if not staff.active:
                raise WorkflowError("Cannot enroll an inactive account")
            if s.get(StaffCredential, staff.id):
                raise WorkflowError("Credential already exists; change password instead")
            self._create_credential(s, staff, username, password)
            self.service._audit(s, actor, "AUTH_ACCOUNT_ENROLLED", staff.id, {"role": staff.role})
            return staff.id

    def login(self, username: str, password: str) -> dict[str, Any]:
        # Reject grossly malformed input before expensive hashing, without echoing credentials.
        if not isinstance(username, str) or len(username) > 100 or not isinstance(password, str) or len(password.encode('utf-8')) > 256:
            raise AuthenticationFailed("Invalid username or password")
        normalized = username.strip().lower()
        now = utcnow()
        with self.service.sessions.begin() as s:
            account = s.scalar(select(StaffCredential).where(StaffCredential.username == normalized).with_for_update())
            if account is None:
                _derive(password.encode("utf-8"), DUMMY_SALT)
                raise AuthenticationFailed("Invalid username or password")
            staff = s.get(Staff, account.staff_id)
            if staff is None or not staff.active or staff.site_id != account.site_id:
                raise AuthenticationFailed("Invalid username or password")
            if account.locked_until and _utc(account.locked_until) > now:
                raise AuthenticationFailed("Invalid username or password")
            if account.locked_until and _utc(account.locked_until) <= now:
                account.failure_count = 0
                account.locked_until = None
            candidate = _derive(password.encode("utf-8"), bytes.fromhex(account.password_salt))
            if not hmac.compare_digest(candidate, account.password_hash):
                account.failure_count += 1
                if account.failure_count >= MAX_FAILURES:
                    account.locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
                # Deliberately do not raise inside the transaction: persist failed-attempt count.
                denied = True
            else:
                denied = False
            if denied:
                # Final exception is raised after commit, to avoid rolling back lockout counters.
                result = None
            else:
                account.failure_count = 0
                account.locked_until = None
                secret = secrets.token_urlsafe(48)
                session_id = secrets.token_hex(16)
                expiry = now + timedelta(hours=SESSION_HOURS)
                s.add(StaffSession(id=session_id, staff_id=staff.id, site_id=staff.site_id,
                                   token_digest=_digest(secret), role_snapshot=staff.role,
                                   password_version=account.password_version,
                                   created_at=now, expires_at=expiry, last_seen_at=now))
                self.service._audit(s, Actor(staff.id, staff.site_id, staff.role), "AUTH_LOGIN", session_id,
                                    {"mode": "synthetic_session"})
                result = {"access_token": secret, "token_type": "bearer",
                          "expires_at": expiry.isoformat(), "staff_id": staff.id,
                          "site_id": staff.site_id, "role": staff.role}
        if result is None:
            raise AuthenticationFailed("Invalid username or password")
        return result

    def _authenticated_session(self, s, token: str, *, touch: bool = True):
        now = utcnow()
        row = s.scalar(select(StaffSession).where(StaffSession.token_digest == _digest(token)).with_for_update())
        if (row is None or row.revoked_at is not None or _utc(row.expires_at) <= now
                or _utc(row.last_seen_at) + timedelta(minutes=IDLE_MINUTES) <= now):
            raise AuthenticationFailed("Session expired or revoked")
        staff = s.get(Staff, row.staff_id)
        account = s.get(StaffCredential, row.staff_id)
        if (staff is None or account is None or not staff.active or staff.site_id != row.site_id
                or account.site_id != staff.site_id or staff.role != row.role_snapshot
                or row.password_version != account.password_version):
            raise AuthenticationFailed("Session expired or revoked")
        if touch:
            row.last_seen_at = now
        return row, Actor(staff.id, staff.site_id, staff.role)

    def verify(self, token: str) -> Actor:
        with self.service.sessions.begin() as s:
            _row, actor = self._authenticated_session(s, token)
            return actor

    def logout(self, token: str) -> None:
        with self.service.sessions.begin() as s:
            row, actor = self._authenticated_session(s, token, touch=False)
            row.revoked_at = utcnow()
            self.service._audit(s, actor, "AUTH_LOGOUT", row.id, {})

    def rotate_password(self, token: str, old_password: str, new_password: str) -> None:
        new_raw = _password(new_password)
        if old_password == new_password:
            raise WorkflowError("New password must differ from old password")
        with self.service.sessions.begin() as s:
            row, actor = self._authenticated_session(s, token, touch=False)
            account = s.get(StaffCredential, actor.id)
            old = _derive(old_password.encode("utf-8"), bytes.fromhex(account.password_salt))
            if not hmac.compare_digest(old, account.password_hash):
                raise AuthenticationFailed("Invalid username or password")
            salt = secrets.token_bytes(16)
            account.password_salt = salt.hex()
            account.password_hash = _derive(new_raw, salt)
            account.password_version += 1
            account.changed_at = utcnow()
            for session in s.scalars(select(StaffSession).where(StaffSession.staff_id == actor.id,
                                                               StaffSession.revoked_at.is_(None))):
                session.revoked_at = utcnow()
            self.service._audit(s, actor, "AUTH_PASSWORD_ROTATED", actor.id, {"sessions_revoked": True})

    def disable(self, actor: Actor, staff_id: str) -> None:
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            if actor.role != "ADMIN" or actor.id == staff_id:
                raise AccessDenied("Only an administrator may disable another staff account")
            staff = self.service._site(s, Staff, staff_id, actor)
            staff.active = False
            for row in s.scalars(select(StaffSession).where(StaffSession.staff_id == staff_id,
                                                            StaffSession.revoked_at.is_(None))):
                row.revoked_at = utcnow()
            self.service._audit(s, actor, "AUTH_STAFF_DISABLED", staff_id, {"sessions_revoked": True})
