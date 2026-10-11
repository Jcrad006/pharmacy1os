"""Synthetic-only, nonblocking Qt login and logout for loopback workstations.

Every server request runs in a QThread. Passwords and bearer tokens are never
emitted over UI signals, displayed or written to local recovery storage.
"""
from __future__ import annotations

from PySide6.QtCore import Qt, QThread, Signal, Slot
from PySide6.QtWidgets import (
    QDialog, QDialogButtonBox, QFormLayout, QLabel, QLineEdit,
    QVBoxLayout,
)

from .remote_preview import WorkstationConnectionError


class SessionLoginThread(QThread):
    completed = Signal(object)

    def __init__(self, client, username: str, password: str, parent=None):
        super().__init__(parent)
        self.client = client
        self._username = username
        self._password = password

    def run(self):
        try:
            identity = self.client.login(self._username, self._password)
            # Only a non-secret synthetic account projection reaches the UI.
            self.completed.emit(("ok", {
                key: identity[key] for key in
                ("staff_id", "site_id", "role", "synthetic_only")}))
        except WorkstationConnectionError as exc:
            self.completed.emit(("error", {"category": "HTTP", "status": exc.status}))
        except Exception:
            self.completed.emit(("error", {"category": "UNEXPECTED", "status": None}))
        finally:
            self._password = None
            self._username = None


class SessionLogoutThread(QThread):
    completed = Signal(object)

    def __init__(self, client, parent=None):
        super().__init__(parent)
        self.client = client

    def run(self):
        try:
            self.client.logout()
            self.completed.emit(("ok", None))
        except Exception:
            # The client clears its own credentials even when logout fails.
            # The server might retain a session until expiry.
            self.completed.emit(("error", {"category": "UNCONFIRMED_LOGOUT"}))


class SessionLoginDialog(QDialog):
    """Keeps login controls responsive during slow localhost authentication."""

    def __init__(self, client, parent=None):
        super().__init__(parent)
        self.client = client
        self.identity: dict | None = None
        self._worker: SessionLoginThread | None = None
        self._completed = None
        self._closing = False
        self.setWindowTitle("Pharmacy1OS — synthetic local sign-in")
        self.setMinimumWidth(430)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(
            "SYNTHETIC DATA ONLY — local development session"))
        form = QFormLayout()
        self.username = QLineEdit()
        self.username.setMaxLength(128)
        self.username.setPlaceholderText("Synthetic staff username")
        form.addRow("Username", self.username)
        self.password = QLineEdit()
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        self.password.setMaxLength(256)
        form.addRow("Password", self.password)
        layout.addLayout(form)
        self.info = QLabel("No real patient or pharmacy credentials")
        layout.addWidget(self.info)
        self.buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok |
            QDialogButtonBox.StandardButton.Cancel)
        self.buttons.accepted.connect(self.begin_login)
        self.buttons.rejected.connect(self.reject)
        layout.addWidget(self.buttons)

    def begin_login(self):
        if self._worker is not None or self._closing:
            return
        username = self.username.text().strip()
        password = self.password.text()
        if not username or not password:
            self.info.setText("Enter synthetic username and password")
            return
        # Clear visible secret immediately. Only the running worker retains it.
        self.password.clear()
        self.username.setEnabled(False)
        self.password.setEnabled(False)
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(False)
        self.buttons.button(QDialogButtonBox.StandardButton.Cancel).setEnabled(False)
        self.info.setText("Authenticating with localhost; no UI blocking…")
        worker = SessionLoginThread(self.client, username, password)
        self._worker = worker
        self._completed = None
        worker.completed.connect(
            self._capture_login, Qt.ConnectionType.QueuedConnection)
        worker.finished.connect(
            self._login_finished, Qt.ConnectionType.QueuedConnection)
        worker.finished.connect(worker.deleteLater)
        password = None
        worker.start()

    @Slot(object)
    def _capture_login(self, result):
        self._completed = result

    @Slot()
    def _login_finished(self):
        outcome = self._completed
        self._worker = None
        self._completed = None
        if self._closing:
            self.identity = None
            # No window is opened if cancellation was requested.
            # Explicit logout, when possible, will be handled by the caller.
            super().reject()
            return
        if outcome is not None and outcome[0] == "ok":
            self.identity = outcome[1]
            if self.identity.get("synthetic_only") is True:
                super().accept()
                return
            self.identity = None
        self.username.setEnabled(True)
        self.password.setEnabled(True)
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(True)
        self.buttons.button(QDialogButtonBox.StandardButton.Cancel).setEnabled(True)
        code = outcome[1].get("status") if outcome and outcome[0] == "error" else None
        self.info.setText(
            "Authentication refused or local synthetic server unavailable"
            + (f" (HTTP {code})" if code is not None else ""))
        self.password.setFocus()

    def reject(self):
        if self._worker is not None:
            self._closing = True
            self.info.setText("Finishing active sign-in before closing")
            return
        super().reject()

    def closeEvent(self, event):
        if self._worker is not None:
            self._closing = True
            self.info.setText("Finishing active sign-in before closing")
            event.ignore()
        else:
            super().closeEvent(event)
