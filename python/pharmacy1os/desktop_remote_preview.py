"""Separate-process, Qt workstation with one pharmacist-reviewed SIG edit.

All pharmacy reads and the lone edit use LocalSessionWorkstationClient; no
database, ORM or domain transaction service exists on this UI path.
SYNTHETIC ONLY. No physical dispensing, payer or inventory work.
"""
from __future__ import annotations

import os

from .remote_preview import LocalSessionWorkstationClient, WorkstationConnectionError
from .remote_review_fields import collect_review_changes
from .workstation_recovery_journal import JournalSafetyError, WorkstationRecoveryJournal
from .workstation_recovery import ReviewedEditRecovery


def main() -> None:
    if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise SystemExit("Synthetic desktop preview disabled; opt in explicitly")
    try:
        from PySide6.QtCore import Qt, QTimer
        from PySide6.QtGui import QKeySequence, QShortcut
        from .qt_recovery_worker import RecoveryLookupThread
        from PySide6.QtWidgets import (
            QApplication, QComboBox, QDialog, QHBoxLayout, QLabel, QInputDialog,
            QLineEdit, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton,
            QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget, QFormLayout,
            QDialogButtonBox, QSpinBox,
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

    journal = None
    recovery = None
    if identity["role"] in ("PHARMACIST", "ADMIN"):
        try:
            journal = WorkstationRecoveryJournal()
            recovery = ReviewedEditRecovery(client, journal)
        except (JournalSafetyError, OSError) as exc:
            if journal is not None:
                journal.close()
            QMessageBox.critical(None, "Recovery journal unavailable",
                "Reviewed edits are disabled because the private recovery journal "
                "could not be verified: " + str(exc))
            client.logout()
            return

    class LocalWorkstation(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("Pharmacy1OS — Local reviewed-Rx preview")
            self.last_review_key = None
            self.last_review_rx = None
            self._lookup_thread = None
            self._lookup_busy = False
            self._close_after_lookup = False
            self.resize(920, 630)
            central = QWidget()
            self.setCentralWidget(central)
            layout = QVBoxLayout(central)
            layout.addWidget(QLabel(
                "SYNTHETIC DATA ONLY • PHARMACIST REVIEWED RX EDITS • NO DISPENSING"))
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
            self.edit_sig_button = QPushButton("Pharmacist: review Rx fields")
            self.edit_sig_button.setEnabled(identity["role"] in ("PHARMACIST", "ADMIN"))
            self.edit_sig_button.clicked.connect(self.review_fields)
            actions.addWidget(self.edit_sig_button)
            outcome = QPushButton("Last review receipt")
            outcome.clicked.connect(self.last_review_outcome)
            actions.addWidget(outcome)
            if recovery is not None:
                self.check_pending_button = QPushButton("Reconcile pending reviews")
                self.check_pending_button.clicked.connect(self.reconcile_outstanding)
                actions.addWidget(self.check_pending_button)
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
            QShortcut(QKeySequence("F5"), self, activated=self.review_fields)
            self.reload()
            if recovery is not None:
                pending = recovery.outstanding()
                if pending:
                    self.info.setText(
                        f"{len(pending)} saved review receipt(s) need confirmation. "
                        "Only read-only reconciliation is permitted.")
                    # Small bounded startup check; manually reconcile the rest.
                    QTimer.singleShot(0, lambda: self.reconcile_outstanding(limit=2))

        def _read(self, action):
            try:
                return action()
            except (WorkstationConnectionError, JournalSafetyError, ValueError, OSError) as exc:
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
                "Only reviewed SIG, quantity, and refill changes are supported in this preview.",
            ]
            self._show_text("Synthetic Rx detail", "\n".join(lines))

        def review_fields(self):
            if self._lookup_busy or self._close_after_lookup:
                QMessageBox.warning(
                    self, "Recovery in progress",
                    "Prescription editing is disabled while receipt reconciliation runs.")
                return
            rx_id = self.selected_id()
            if not rx_id or identity["role"] not in ("PHARMACIST", "ADMIN"):
                return
            context = self._read(lambda: client.edit_context(rx_id))
            if context is None:
                return
            if not context["editable"]:
                QMessageBox.warning(self, "Review unavailable",
                    context.get("blocked_reason") or "Prescription cannot be edited")
                return

            before_values = context["values"]
            dialog = QDialog(self)
            dialog.setWindowTitle("Synthetic pharmacist prescription review")
            dialog.resize(630, 480)
            layout = QVBoxLayout(dialog)
            fields = QFormLayout()
            sig = QPlainTextEdit()
            sig.setPlainText(before_values["sig"])
            fields.addRow("Directions (SIG)", sig)
            quantity = QLineEdit(before_values["quantity"])
            fields.addRow("Quantity", quantity)
            refills = QSpinBox()
            refills.setRange(0, 999)
            refills.setValue(before_values["refills_allowed"])
            fields.addRow("Refills authorized", refills)
            layout.addLayout(fields)
            layout.addWidget(QLabel(
                "Required: describe independent prescriber confirmation and change reason"))
            attestation = QPlainTextEdit()
            layout.addWidget(attestation)
            buttons = QDialogButtonBox(
                QDialogButtonBox.StandardButton.Save |
                QDialogButtonBox.StandardButton.Cancel)
            buttons.accepted.connect(dialog.accept)
            buttons.rejected.connect(dialog.reject)
            layout.addWidget(buttons)
            if dialog.exec() != QDialog.DialogCode.Accepted:
                return
            try:
                changes = collect_review_changes(before_values, {
                    "sig": sig.toPlainText(), "quantity": quantity.text().strip(),
                    "refills_allowed": refills.value()})
            except ValueError as exc:
                QMessageBox.warning(self, "Invalid reviewed fields", str(exc))
                return
            if not changes:
                QMessageBox.information(self, "No changes", "No fields were modified")
                return
            note = attestation.toPlainText().strip()
            if not 12 <= len(note) <= 2000:
                QMessageBox.warning(self, "Missing clinical attestation",
                                    "Review documentation requires 12–2000 characters")
                return

            # UI preflight never replaces the expected version or status.
            # The server independently locks the prescription and rechecks.
            fresh = self._read(lambda: client.edit_context(rx_id))
            if fresh is None:
                return
            if (not fresh["editable"] or fresh["version"] != context["version"]
                    or fresh["status"] != context["status"]
                    or any(fresh["values"][key] != before_values[key]
                           for key in ("sig", "quantity", "refills_allowed"))):
                QMessageBox.warning(self, "Prescription changed",
                                    "Another workstation modified or advanced this Rx. "
                                    "Your draft was NOT saved; begin a fresh review.")
                self.reload()
                return
            summary = "\n".join(
                f"{key}: {before_values[key]} -> {val}"
                for key, val in sorted(changes.items()))
            if QMessageBox.question(
                    self, "Confirm versioned pharmacist review",
                    f"Apply reviewed synthetic Rx changes to {rx_id[:8]}?\n\n"
                    f"{summary}\n\nThis may reset DUR review. The immutable source is "
                    "unchanged. No payer, stock, label or dispensing action occurs.",
                    QMessageBox.StandardButton.Yes |
                    QMessageBox.StandardButton.No
            ) != QMessageBox.StandardButton.Yes:
                return
            if recovery is None:
                QMessageBox.warning(self, "Recovery unavailable",
                                    "Cannot submit without a protected journal")
                return
            result = self._read(lambda: recovery.submit(
                rx_id, changes=changes, expected_version=context["version"],
                expected_status=context["status"], attestation_note=note))
            if result is None:
                # The request has already been journaled, unless pre-send
                # validation/storage failed (which forbids any HTTP mutation).
                # NEVER automatically retry any uncertain submitted review.
                self.reconcile_outstanding(limit=2)
                self.reload()
                return
            self.last_review_key = result["request_id"]
            self.last_review_rx = rx_id
            self.reload()
            QMessageBox.information(self, "Synthetic reviewed change saved",
                f"Prescription now at version {result['version']}. "
                "The request ID and receipt are saved for post-crash reconciliation.")

        def _start_receipt_lookup(self, batch, *, manual_request_id=None,
                                  notify=True):
            if recovery is None or self._lookup_busy:
                if notify and not self._close_after_lookup:
                    QMessageBox.information(
                        self, "Receipt check already running",
                        "A receipt lookup is already in progress; no edit was retried.")
                return
            if not batch.entries:
                if notify:
                    QMessageBox.information(
                        self, "No pending receipts", "No unconfirmed review IDs remain.")
                return
            self._lookup_busy = True
            self.edit_sig_button.setEnabled(False)
            self.check_pending_button.setEnabled(False)
            self.info.setText(
                f"Checking {len(batch.entries)} synthetic receipt(s) in background; "
                "edits temporarily disabled")
            worker = RecoveryLookupThread(recovery, batch)
            self._lookup_thread = worker
            worker.completed.connect(
                lambda outcome: self._recovery_result(
                    batch, outcome, manual_request_id, notify))
            worker.finished.connect(self._recovery_finished)
            worker.finished.connect(worker.deleteLater)
            worker.start()

        def _recovery_result(self, batch, outcome, manual_request_id, notify):
            if self._close_after_lookup:
                # The user requested close: do not modify or acknowledge the
                # journal from an obsolete window; remaining entries stay safe.
                return
            if outcome[0] != "ok":
                self.info.setText(
                    "Receipt check failed; saved IDs remain pending; no retry sent")
                if notify:
                    QMessageBox.warning(
                        self, "Recovery lookup unavailable",
                        "Saved request IDs remain in the protected journal. "
                        "Sign in and reconcile again; no request was resent.")
                return
            report = self._read(lambda: recovery.apply_lookup(batch, outcome[1]))
            if report is None:
                self.info.setText(
                    "Recovery application blocked; saved IDs remain for manual review")
                return
            self.info.setText(
                f"Receipt check: {report['recorded']} confirmed, "
                f"{report['remaining']} pending; no edits were resent")
            if manual_request_id:
                detail = next((item for item in report["details"]
                               if item["request_id"] == manual_request_id), None)
                if detail is not None and detail["state"] == "RECORDED":
                    choice = QMessageBox.question(
                        self, "Server confirmed recorded review",
                        f"Request {manual_request_id}\nReview {detail['review_id']}\n"
                        f"Version {detail['version']}\n\n"
                        "Acknowledge this server-confirmed receipt locally? "
                        "The server's immutable audit record will remain.",
                        QMessageBox.StandardButton.Yes |
                        QMessageBox.StandardButton.No)
                    if choice == QMessageBox.StandardButton.Yes:
                        self._read(lambda: recovery.acknowledge(manual_request_id))
                else:
                    QMessageBox.warning(
                        self, "Request not confirmed",
                        f"Request {manual_request_id} remains uncertain. "
                        "NOT_RECORDED or a failed lookup is NOT permission to retry.")
            elif notify:
                QMessageBox.information(
                    self, "Read-only receipt reconciliation",
                    f"Checked {report['checked']}; recorded {report['recorded']}; "
                    f"still unconfirmed {report['uncertain']}; "
                    f"lookup failures {len(report['errors'])}; "
                    f"pending {report['remaining']}.\n\n"
                    "No prescription edit was automatically retried.")

        def _recovery_finished(self):
            self._lookup_busy = False
            self._lookup_thread = None
            if self._close_after_lookup:
                QTimer.singleShot(0, self.close)
            else:
                self.edit_sig_button.setEnabled(
                    recovery is not None and
                    identity["role"] in ("PHARMACIST", "ADMIN"))
                self.check_pending_button.setEnabled(recovery is not None)

        def reconcile_outstanding(self, checked=False, *, limit: int = 8):
            if recovery is None:
                return
            if self._lookup_busy:
                return
            batch = self._read(lambda: recovery.prepare_lookup(limit=limit))
            if batch is not None:
                self._start_receipt_lookup(batch, notify=limit != 2)

        def last_review_outcome(self):
            if recovery is None or self._lookup_busy:
                return
            entries = self._read(recovery.outstanding)
            if not entries:
                QMessageBox.information(
                    self, "No saved review", "No saved review IDs for this account")
                return
            options = [
                f"{x['request_id']} | {x['state']} | Rx {x['prescription_id'][:8]}"
                for x in entries]
            selected, ok = QInputDialog.getItem(
                self, "Saved review request IDs",
                "Select one synthetic request (read-only lookup):",
                options, 0, False)
            if not ok:
                return
            key = entries[options.index(selected)]["request_id"]
            batch = self._read(
                lambda: recovery.prepare_lookup(request_id=key, limit=1))
            if batch is not None:
                self._start_receipt_lookup(
                    batch, manual_request_id=key, notify=True)

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
            if self._lookup_busy:
                # Never destroy a running QThread or close its journal owner.
                self._close_after_lookup = True
                self.info.setText(
                    "Closing after the in-flight read-only receipt lookup ends")
                event.ignore()
                return
            try:
                client.logout()
            except WorkstationConnectionError:
                pass
            finally:
                if journal is not None:
                    journal.close()
            event.accept()

    window = LocalWorkstation()
    window.show()
    app.exec()


if __name__ == "__main__":
    main()
