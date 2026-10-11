"""Separate-process, Qt workstation with one pharmacist-reviewed SIG edit.

All pharmacy reads and the lone edit use LocalSessionWorkstationClient; no
database, ORM or domain transaction service exists on this UI path.
SYNTHETIC ONLY. No physical dispensing, payer or inventory work.
"""
from __future__ import annotations

import os

from .remote_preview import LocalSessionWorkstationClient, WorkstationConnectionError


def main() -> None:
    if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise SystemExit("Synthetic desktop preview disabled; opt in explicitly")
    try:
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QKeySequence, QShortcut
        from PySide6.QtWidgets import (
            QApplication, QComboBox, QDialog, QHBoxLayout, QLabel, QInputDialog,
            QLineEdit, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton,
            QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
        )
    except ImportError as exc:
        raise SystemExit("Install native PySide6: pip install -e '.[desktop]'") from exc

    client = LocalSessionWorkstationClient(os.getenv(
        "PHARMACY1OS_LOOPBACK_URL", "http://127.0.0.1:8008"))
    app = QApplication([])
    app.setApplicationName("Pharmacy1OS — Local Session Workstation (synthetic)")
    username, ok = QInputDialog.getText(None, "Synthetic session", "Username:")
    if not ok or not username.strip():
        return
    password, ok = QInputDialog.getText(
        None, "Synthetic session", "Password:",
        QLineEdit.EchoMode.Password)
    if not ok:
        return
    try:
        identity = client.login(username, password)
    except WorkstationConnectionError as exc:
        QMessageBox.critical(None, "Local session unavailable", str(exc))
        return
    finally:
        # Only the session token (in client memory) survives the login dialog.
        password = None

    class LocalWorkstation(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("Pharmacy1OS — Local reviewed-Rx preview")
            self.resize(920, 630)
            central = QWidget()
            self.setCentralWidget(central)
            layout = QVBoxLayout(central)
            layout.addWidget(QLabel(
                "SYNTHETIC DATA ONLY • REVIEWED SIG EDIT ONLY • NO DISPENSING"))
            layout.addWidget(QLabel(
                f"Signed-in synthetic role: {identity['role']} • "
                f"Site: {identity['site_id'][:8]} • Server: {client.base_url}"))
            controls = QHBoxLayout()
            self.search = QLineEdit()
            self.search.setPlaceholderText("Search Rx number, patient, prescriber or medication")
            self.search.returnPressed.connect(self.reload)
            controls.addWidget(self.search)
            self.status = QComboBox()
            self.status.addItem("All", None)
            for state in ("RECEIVED", "DATA_ENTRY", "DUR_REVIEW",
                          "PRODUCT_FILL", "PHARMACIST_REVIEW", "READY",
                          "SOLD", "ON_HOLD", "CANCELLED", "RETURNED"):
                self.status.addItem(state.replace("_", " "), state)
            controls.addWidget(self.status)
            self.sort = QComboBox()
            self.sort.addItem("Oldest first", "oldest")
            self.sort.addItem("Newest first", "newest")
            controls.addWidget(self.sort)
            self.refresh_button = QPushButton("Refresh")
            self.refresh_button.clicked.connect(self.reload)
            controls.addWidget(self.refresh_button)
            layout.addLayout(controls)
            self.table = QTableWidget(0, 5)
            self.table.setHorizontalHeaderLabels(
                ["Rx number", "Patient", "Medication", "Status", "Last activity"])
            self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
            self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
            self.table.verticalHeader().hide()
            self.table.doubleClicked.connect(lambda _: self.detail())
            layout.addWidget(self.table)
            actions = QHBoxLayout()
            detail = QPushButton("Selected prescription detail")
            detail.clicked.connect(self.detail)
            actions.addWidget(detail)
            audit = QPushButton("Selected audit history")
            audit.clicked.connect(self.audit)
            actions.addWidget(audit)
            self.edit_sig_button = QPushButton("Pharmacist: review SIG change")
            self.edit_sig_button.setEnabled(identity["role"] in ("PHARMACIST", "ADMIN"))
            self.edit_sig_button.clicked.connect(self.review_sig)
            actions.addWidget(self.edit_sig_button)
            actions.addStretch()
            layout.addLayout(actions)
            self.info = QLabel("No database is opened by this desktop")
            layout.addWidget(self.info)
            self.status.currentIndexChanged.connect(self.reload)
            self.sort.currentIndexChanged.connect(self.reload)
            QShortcut(QKeySequence("F1"), self, activated=self.reload)
            QShortcut(QKeySequence("F2"), self, activated=self.search.setFocus)
            QShortcut(QKeySequence("F3"), self, activated=self.detail)
            QShortcut(QKeySequence("F4"), self, activated=self.audit)
            QShortcut(QKeySequence("F5"), self, activated=self.review_sig)
            self.reload()

        def _read(self, action):
            try:
                return action()
            except (WorkstationConnectionError, ValueError) as exc:
                self.info.setText("Action blocked: " + str(exc))
                QMessageBox.warning(self, "Refresh or sign in again", str(exc))
                return None

        def reload(self, *args):
            result = self._read(lambda: client.queue(
                query=self.search.text().strip(), status=self.status.currentData(),
                sort=self.sort.currentData(), limit=100))
            if result is None:
                self.table.setRowCount(0)
                return
            items = result["prescriptions"]
            self.table.setRowCount(len(items))
            for row, record in enumerate(items):
                patient = record.get("patient") or {}
                values = [
                    record.get("rxNumber", ""),
                    (patient.get("lastName", "") + ", " + patient.get("firstName", "")).strip(", "),
                    record.get("medicationName", ""),
                    record.get("status", ""),
                    record.get("updatedAt") or "unknown",
                ]
                for col, text in enumerate(values):
                    cell = QTableWidgetItem(str(text))
                    if col == 0:
                        cell.setData(Qt.ItemDataRole.UserRole, record.get("id"))
                    self.table.setItem(row, col, cell)
            self.info.setText(
                f"Showing {len(items)} synthetic prescriptions. F2 search • F3 detail • F4 audit")

        def selected_id(self) -> str | None:
            row = self.table.currentRow()
            item = self.table.item(row, 0) if row >= 0 else None
            return item.data(Qt.ItemDataRole.UserRole) if item else None

        def _show_text(self, heading: str, text: str):
            popup = QDialog(self)
            popup.setWindowTitle(heading)
            popup.resize(690, 450)
            body = QVBoxLayout(popup)
            display = QPlainTextEdit()
            display.setReadOnly(True)
            display.setPlainText(text)
            body.addWidget(display)
            close = QPushButton("Close")
            close.clicked.connect(popup.accept)
            body.addWidget(close)
            popup.exec()

        def detail(self):
            rx_id = self.selected_id()
            if not rx_id:
                return
            info = self._read(lambda: client.detail(rx_id))
            if info is None:
                return
            patient, prescriber = info.get("patient") or {}, info.get("prescriber") or {}
            lines = [
                "SYNTHETIC PRESCRIPTION — READ ONLY",
                f"Rx: {info.get('rxNumber', '')}",
                f"Patient: {patient.get('lastName', '')}, {patient.get('firstName', '')}",
                f"Prescriber: {prescriber.get('lastName', '')}, {prescriber.get('firstName', '')}",
                f"Medication: {info.get('medicationName', '')} {info.get('strength', '')}",
                f"Status: {info.get('status', '')}",
                f"Directions: {info.get('sig', '')}",
                f"Quantity: {info.get('quantityWritten', '')}",
                f"Refills: {info.get('refillsUsed', '')}/{info.get('refillsAllowed', '')}",
                f"Source: {info.get('sourceType', '')}",
                f"Physical fill attempts: {len(info.get('fills') or [])}",
                "",
                "Only a pharmacist-reviewed SIG change is supported in this preview.",
            ]
            self._show_text("Synthetic Rx detail", "\n".join(lines))

        def review_sig(self):
            rx_id = self.selected_id()
            if rx_id is None or identity["role"] not in ("PHARMACIST", "ADMIN"):
                return
            context = self._read(lambda: client.edit_context(rx_id))
            if context is None:
                return
            if not context["editable"]:
                QMessageBox.warning(
                    self, "Review unavailable",
                    context.get("blocked_reason") or "This prescription cannot be edited")
                return
            original = context["values"]["sig"]
            proposed, ok = QInputDialog.getMultiLineText(
                self, "Synthetic pharmacist SIG review",
                "Reviewed replacement SIG:", original)
            if not ok:
                return
            if not proposed.strip() or proposed.strip() == original:
                QMessageBox.warning(self, "No SIG change", "Enter a different, nonempty SIG")
                return
            note, ok = QInputDialog.getMultiLineText(
                self, "Review attestation (synthetic)",
                "Record the independently confirmed change and why it is appropriate:")
            if not ok:
                return
            if not 12 <= len(note.strip()) <= 2000:
                QMessageBox.warning(
                    self, "Missing review", "Attestation requires 12–2000 characters")
                return
            # Do not silently use a newer version or overwrite another operator.
            latest = self._read(lambda: client.edit_context(rx_id))
            if latest is None:
                return
            if (latest["version"] != context["version"]
                    or latest["values"]["sig"] != original
                    or latest["status"] != context["status"]
                    or not latest["editable"]):
                QMessageBox.warning(
                    self, "Prescription changed",
                    "Another workstation changed or advanced this prescription. "
                    "Your draft was NOT saved. Reload before editing.")
                self.reload()
                return
            confirmation = (
                f"Apply pharmacist-reviewed synthetic SIG change to Rx {rx_id[:8]}?\n\n"
                f"Before: {original}\nAfter: {proposed.strip()}\n\n"
                "This resets DUR review where appropriate. No source scan, "
                "payer claim, label or dispensing action will be performed.")
            if QMessageBox.question(
                    self, "Confirm versioned Rx change", confirmation,
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
            ) != QMessageBox.StandardButton.Yes:
                return
            result = self._read(lambda: client.review_sig(
                rx_id, sig=proposed.strip(),
                expected_version=context["version"],
                expected_status=context["status"], attestation_note=note.strip()))
            if result is None:
                QMessageBox.information(
                    self, "Check current state", "Do not automatically retry. "
                    "Refresh prescription details and its audit to determine "
                    "whether the requested change committed.")
                return
            self.reload()
            QMessageBox.information(
                self, "Synthetic edit recorded",
                f"Review recorded as prescription version {result['version']}. "
                "Reopen the prescription and audit to verify the current state.")

        def audit(self):
            rx_id = self.selected_id()
            if not rx_id:
                return
            data = self._read(lambda: client.audit(rx_id, limit=100))
            if data is None:
                return
            lines = ["SYNTHETIC AUDIT — READ ONLY (free-text metadata excluded)", ""]
            for event in data["events"]:
                actor = event.get("actor") or {}
                lines.append(
                    f"{event.get('occurredAt', '')} • {event.get('action', '')} • "
                    f"{actor.get('displayName', '')} ({actor.get('role', '')})")
            self._show_text("Prescription audit trail", "\n".join(lines))

        def closeEvent(self, event):
            try:
                client.logout()
            except WorkstationConnectionError:
                pass
            event.accept()

    window = LocalWorkstation()
    window.show()
    app.exec()


if __name__ == "__main__":
    main()
