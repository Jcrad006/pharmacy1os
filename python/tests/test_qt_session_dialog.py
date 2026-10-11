"""Headless Qt tests for local-only session login/logout lifecycle.

Synthetic fake accounts. Test workers must not emit passwords or bearer tokens
and must keep Qt's GUI event loop responsive while a server call is delayed.
"""
from __future__ import annotations

import os
from threading import Event

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
pytest.importorskip("PySide6.QtWidgets")
from PySide6.QtCore import Qt, QEventLoop, QThread, QTimer, QObject, Slot
from PySide6.QtWidgets import QApplication, QDialog, QDialogButtonBox

from pharmacy1os.qt_session_dialog import (
    SessionLoginDialog, SessionLogoutThread,
)
from pharmacy1os.remote_preview import WorkstationConnectionError


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


class FakeSessionClient:
    def __init__(self):
        self.login_gate = Event()
        self.logout_gate = Event()
        self.login_gate.set()
        self.logout_gate.set()
        self.login_calls = []
        self.logout_calls = 0
        self.logout_thread = None
        self._identity = None
        self.login_error = None

    @property
    def identity(self):
        return self._identity

    def login(self, username, password):
        self.login_calls.append((username, password, QThread.currentThread()))
        assert self.login_gate.wait(timeout=3)
        if self.login_error is not None:
            raise self.login_error
        self._identity = {
            "staff_id": "synthetic-staff", "site_id": "synthetic-site",
            "role": "PHARMACIST", "synthetic_only": True,
        }
        return dict(self._identity)

    def logout(self):
        self.logout_calls += 1
        self.logout_thread = QThread.currentThread()
        assert self.logout_gate.wait(timeout=3)
        self._identity = None


class Receiver(QObject):
    def __init__(self, loop):
        super().__init__()
        self.loop = loop
        self.outcomes = []
        self.threads = []

    @Slot(object)
    def on_completed(self, response):
        self.outcomes.append(response)
        self.threads.append(QThread.currentThread())
        self.loop.quit()


def test_slow_login_runs_off_ui_and_discards_password(app):
    main_thread = QThread.currentThread()
    client = FakeSessionClient()
    client.login_gate.clear()
    dialog = SessionLoginDialog(client)
    dialog.username.setText("synthetic.pharmacist")
    dialog.password.setText("SYNTHETIC_SECRET_DO_NOT_EMIT")
    dialog.begin_login()
    assert dialog.password.text() == ""
    assert not dialog.buttons.button(QDialogButtonBox.StandardButton.Ok).isEnabled()
    ticked = []

    def release():
        ticked.append(QThread.currentThread())
        client.login_gate.set()

    QTimer.singleShot(30, release)
    QTimer.singleShot(3500, dialog.reject)
    assert dialog.exec() == QDialog.DialogCode.Accepted
    assert ticked == [main_thread]
    assert client.login_calls[0][:2] == (
        "synthetic.pharmacist", "SYNTHETIC_SECRET_DO_NOT_EMIT")
    assert client.login_calls[0][2] != main_thread
    assert dialog.identity["role"] == "PHARMACIST"
    assert "SYNTHETIC_SECRET" not in repr(dialog.identity)


def test_failed_login_does_not_accept_or_retain_password(app):
    client = FakeSessionClient()
    client.login_error = WorkstationConnectionError(
        "SIMULATED_PRIVATE_PASSWORD", status=401)
    dialog = SessionLoginDialog(client)
    dialog.username.setText("invalid.synthetic")
    dialog.password.setText("SYNTHETIC_FAILED_LOGIN_SECRET")
    worker = None
    dialog.begin_login()
    worker = dialog._worker
    loop = QEventLoop()
    worker.finished.connect(loop.quit, Qt.ConnectionType.QueuedConnection)
    QTimer.singleShot(3500, loop.quit)
    loop.exec()
    app.processEvents()
    assert dialog.identity is None
    assert dialog.password.text() == ""
    assert "PRIVATE" not in dialog.info.text()
    assert "SYNTHETIC_FAILED_LOGIN_SECRET" not in dialog.info.text()
    assert dialog.buttons.button(QDialogButtonBox.StandardButton.Ok).isEnabled()
    dialog.reject()


def test_cancel_during_login_revokes_any_successful_session(app):
    client = FakeSessionClient()
    client.login_gate.clear()
    dialog = SessionLoginDialog(client)
    dialog.username.setText("synthetic.cancel")
    dialog.password.setText("SYNTHETIC_PASSPHRASE")
    dialog.begin_login()
    # Simulate user closing while the HTTP login request is in flight.
    dialog.reject()
    assert dialog._closing

    QTimer.singleShot(30, client.login_gate.set)
    QTimer.singleShot(3500, client.login_gate.set)
    assert dialog.exec() == QDialog.DialogCode.Rejected
    assert client.logout_calls == 1
    assert client.identity is None
    assert client.logout_thread != QThread.currentThread()


def test_background_logout_does_not_block_qt_timer(app):
    client = FakeSessionClient()
    client.logout_gate.clear()
    loop = QEventLoop()
    worker = SessionLogoutThread(client)
    receiver = Receiver(loop)
    ui = QThread.currentThread()
    worker.completed.connect(receiver.on_completed, Qt.ConnectionType.QueuedConnection)
    timer_seen = []

    def finish():
        timer_seen.append(QThread.currentThread())
        client.logout_gate.set()

    QTimer.singleShot(25, finish)
    QTimer.singleShot(3500, loop.quit)
    worker.start()
    try:
        loop.exec()
    finally:
        client.logout_gate.set()
        assert worker.wait(3500)
    assert timer_seen == [ui]
    assert receiver.threads == [ui]
    assert receiver.outcomes == [("ok", None)]
    assert client.logout_calls == 1
    assert client.logout_thread != ui


def test_logout_failure_emits_no_secret_or_false_success(app):
    class Offline:
        def logout(self):
            raise WorkstationConnectionError(
                "SIMULATED_PRIVATE_SESSION_IDENTIFIER", status=401)

    loop = QEventLoop()
    worker = SessionLogoutThread(Offline())
    receiver = Receiver(loop)
    worker.completed.connect(receiver.on_completed, Qt.ConnectionType.QueuedConnection)
    QTimer.singleShot(3500, loop.quit)
    worker.start()
    try:
        loop.exec()
    finally:
        assert worker.wait(3500)
    assert receiver.outcomes == [
        ("error", {"category": "UNCONFIRMED_LOGOUT"})]
    assert "SIMULATED_PRIVATE" not in repr(receiver.outcomes)
