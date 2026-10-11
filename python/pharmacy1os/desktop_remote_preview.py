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
        from PySide6.QtCore import Qt, QTimer, Slot
        from PySide6.QtGui import QKeySequence, QShortcut
        from .qt_recovery_worker import RecoveryLookupThread
        from .qt_workstation_worker import WorkstationRequestThread
        from .qt_session_dialog import SessionLoginDialog, SessionLogoutThread
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
    signin = SessionLoginDialog(client)
    if signin.exec() != QDialog.DialogCode.Accepted or signin.identity is None:
        # The dialog may be closed while a login was in progress. It waits for
        # that worker to exit and revokes any session it established.
        return
    identity = signin.identity

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
            self._active_lookup_batch = None
            self._active_manual_request_id = None
            self._active_lookup_notify = False
            self._request_thread = None
            self._request_operation = None
            self._request_context = None
            self._next_request = None
            self._review_draft = None
            self._pending_submission = None
            self._close_after_request = False
            self._needs_reconcile = False
            self._startup_reconcile = False
            self._completed_request = None
            self._handling_result = False
            self._logout_thread = None
            self._logout_done = False
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
                    self._startup_reconcile = True
                    # The initial queue GET must finish first. No overlapping
                    # network workers may use the same session client.

        def _read(self, action):
            try:
                return action()
            except (WorkstationConnectionError, JournalSafetyError, ValueError, OSError) as exc:
                self.info.setText("Action blocked: " + str(exc))
                QMessageBox.warning(self, "Refresh or sign in again", str(exc))
                return None

        def _request_busy(self) -> bool:
            return (self._request_thread is not None or
                    self._lookup_busy or self._handling_result)

        def _set_network_controls(self):
            authorized = (client.identity is not None
                          and client.identity.get("staff_id") == identity["staff_id"]
                          and client.identity.get("site_id") == identity["site_id"])
            available = (not self._request_busy() and not self._close_after_request
                         and not self._close_after_lookup and authorized)
            self.refresh_button.setEnabled(available)
            self.edit_sig_button.setEnabled(
                available and recovery is not None
                and client.identity.get("role") in ("PHARMACIST", "ADMIN"))
            if recovery is not None:
                self.check_pending_button.setEnabled(available)

        def _launch_request(self, operation, payload, *, context=None):
            if self._request_thread is not None or self._handling_result:
                # Only retain the latest refresh/filter. Do not queue mutations,
                # dialogs or clinical notes for automatic replay.
                if operation == "queue":
                    self._next_request = (operation, dict(payload), None)
                return False
            if self._lookup_busy or self._close_after_lookup or self._close_after_request:
                return False
            if client.identity is None:
                self.info.setText("Session expired; sign in again")
                self._set_network_controls()
                return False
            worker = WorkstationRequestThread(client, operation, payload)
            self._request_thread = worker
            self._request_operation = operation
            self._request_context = context
            self._set_network_controls()
            self.info.setText(f"Checking synthetic {operation.replace('_', ' ')} on service…")
            worker.completed.connect(
                self._on_request_completed, Qt.ConnectionType.QueuedConnection)
            worker.finished.connect(
                self._on_request_finished, Qt.ConnectionType.QueuedConnection)
            worker.finished.connect(worker.deleteLater)
            worker.start()
            return True

        @Slot(object)
        def _on_request_completed(self, result):
            # A worker can emit "completed" before QThread emits "finished".
            # Defer dialogs and follow-on requests until the thread exits,
            # to avoid nested modal event loops racing a still-active worker.
            self._completed_request = (
                self._request_operation, self._request_context, result)

        def _handle_network_completion(self, operation, context, result):
            if result[0] != "ok":
                error = result[1]
                code = error.get("status") if isinstance(error, dict) else None
                if code == 401 or client.identity is None:
                    # Server-side session expiry/revocation invalidates all
                    # previously displayed synthetic prescription details.
                    # Preserve encrypted pending request IDs for next login.
                    self.table.setRowCount(0)
                    self._review_draft = None
                    self._next_request = None
                    self.info.setText(
                        "Synthetic session expired or revoked; close and sign "
                        "in again. Review receipt journal remains protected.")
                    if operation == "submit_review":
                        self._pending_submission = None
                    return
                self.info.setText(
                    f"Server request {operation} failed (HTTP {code or 'unavailable'}). "
                    "No automatic retry.")
                if operation == "submit_review":
                    self._pending_submission = None
                    self._review_draft = None
                    self._needs_reconcile = True
                elif operation == "edit_context":
                    self._review_draft = None
                return
            data = result[1]
            if operation == "queue":
                self._render_queue(data)
            elif operation == "detail":
                self._display_detail(data)
            elif operation == "audit":
                self._display_audit(data)
            elif operation == "edit_context":
                self._received_edit_context(data, context)
            elif operation == "submit_review":
                self._received_submission(data, context)

        @Slot()
        def _on_request_finished(self):
            self._request_thread = None
            self._request_operation = None
            self._request_context = None
            completed = self._completed_request
            self._completed_request = None
            if self._close_after_request:
                self._review_draft = None
                self._next_request = None
                QTimer.singleShot(0, self.close)
                return
            if completed is not None:
                self._handling_result = True
                try:
                    self._handle_network_completion(*completed)
                except Exception:
                    # A malformed synthetic response or UI processing bug
                    # cannot turn an uncertain review into a confirmed one.
                    self.info.setText(
                        "Unexpected workstation response; verify server audit "
                        "and saved request receipt before any other edit")
                    if completed[0] == "submit_review":
                        self._needs_reconcile = True
                        self._pending_submission = None
                    self._review_draft = None
                finally:
                    self._handling_result = False
            else:
                # Unobserved server outcome: fail closed and preserve journal.
                self.info.setText(
                    "Request finished without a recognized response; "
                    "inspect the server receipt before another edit")
                self._review_draft = None
                self._needs_reconcile = True
            self._set_network_controls()
            next_request = self._next_request
            self._next_request = None
            if self._close_after_request:
                self._next_request = None
                self._review_draft = None
                QTimer.singleShot(0, self.close)
                return
            if next_request:
                QTimer.singleShot(0, lambda: self._launch_request(
                    next_request[0], next_request[1], context=next_request[2]))
            elif self._needs_reconcile or self._startup_reconcile:
                startup = self._startup_reconcile
                self._needs_reconcile = False
                self._startup_reconcile = False
                QTimer.singleShot(
                    0, lambda: self.reconcile_outstanding(limit=2 if startup else 8))

        def reload(self, *args):
            self._launch_request("queue", self._queue_parameters())

        def _render_queue(self, result):
            if not isinstance(result, dict) or not isinstance(result.get("prescriptions"), list):
                self.info.setText("Malformed prescription queue; refresh required")
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
                for col, text_value in enumerate(values):
                    cell = QTableWidgetItem(str(text_value))
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
            if rx_id:
                self._launch_request("detail", {"rx_id": rx_id})

        def _display_detail(self, info):
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
            if self._request_busy() or self._close_after_request or self._close_after_lookup:
                return
            rx_id = self.selected_id()
            if (rx_id and recovery is not None and client.identity is not None
                    and client.identity.get("role") in ("PHARMACIST", "ADMIN")):
                self._launch_request(
                    "edit_context", {"rx_id": rx_id},
                    context={"phase": "open", "rx_id": rx_id})

        def _received_edit_context(self, current, context):
            if not isinstance(context, dict):
                return
            rx_id = context["rx_id"]
            if context["phase"] == "open":
                if not current.get("editable"):
                    QMessageBox.warning(self, "Review unavailable",
                        current.get("blocked_reason") or "Prescription cannot be edited")
                    return
                before = current["values"]
                dialog = QDialog(self)
                dialog.setWindowTitle("Synthetic pharmacist prescription review")
                dialog.resize(630, 480)
                layout = QVBoxLayout(dialog)
                fields = QFormLayout()
                sig = QPlainTextEdit()
                sig.setPlainText(before["sig"])
                fields.addRow("Directions (SIG)", sig)
                quantity = QLineEdit(before["quantity"])
                fields.addRow("Quantity", quantity)
                refills = QSpinBox()
                refills.setRange(0, 999)
                refills.setValue(before["refills_allowed"])
                fields.addRow("Refills authorized", refills)
                layout.addLayout(fields)
                layout.addWidget(QLabel(
                    "Required: independently verify corrections and record the reason"))
                attestation = QPlainTextEdit()
                layout.addWidget(attestation)
                buttons = QDialogButtonBox(
                    QDialogButtonBox.StandardButton.Save |
                    QDialogButtonBox.StandardButton.Cancel)
                buttons.accepted.connect(dialog.accept)
                buttons.rejected.connect(dialog.reject)
                layout.addWidget(buttons)
                if dialog.exec() != QDialog.DialogCode.Accepted or self._close_after_request:
                    return
                try:
                    changes = collect_review_changes(before, {
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
                    QMessageBox.warning(
                        self, "Missing clinical attestation",
                        "Review documentation requires 12–2000 characters")
                    return
                self._review_draft = {
                    "rx_id": rx_id, "before": before, "status": current["status"],
                    "version": current["version"], "changes": changes, "note": note,
                }
                # This worker is still finishing. Only a subsequent GET is
                # queued; no clinical mutation may be queued automatically.
                self._next_request = (
                    "edit_context", {"rx_id": rx_id},
                    {"phase": "preflight", "rx_id": rx_id})
                return
            if context["phase"] != "preflight":
                return
            draft = self._review_draft
            if draft is None or draft["rx_id"] != rx_id:
                return
            if (not current["editable"]
                    or current["version"] != draft["version"]
                    or current["status"] != draft["status"]
                    or any(current["values"][name] != draft["before"][name]
                           for name in ("sig", "quantity", "refills_allowed"))):
                self._review_draft = None
                QMessageBox.warning(
                    self, "Stale workstation",
                    "Prescription changed during review. The draft was NOT saved. "
                    "Reload the record before attempting another correction.")
                self._next_request = ("queue", self._queue_parameters(), None)
                return
            summary = "\n".join(
                f"{name}: {draft['before'][name]} -> {value}"
                for name, value in sorted(draft["changes"].items()))
            if QMessageBox.question(
                    self, "Confirm synthetic pharmacist review",
                    f"Apply reviewed changes to Rx {rx_id[:8]}?\n\n"
                    f"{summary}\n\nThis may reset DUR review. No payer, "
                    "stock, label or dispensing action will occur.",
                    QMessageBox.StandardButton.Yes |
                    QMessageBox.StandardButton.No
            ) != QMessageBox.StandardButton.Yes:
                self._review_draft = None
                return
            if self._close_after_request:
                self._review_draft = None
                return
            if recovery is None:
                self._review_draft = None
                QMessageBox.warning(self, "Recovery unavailable",
                                    "Cannot submit a review without protected journal")
                return
            # The only prepared mutation is first fsynced to encrypted local
            # metadata storage, while still executing on Qt's main thread.
            key = self._read(lambda: recovery.prepare_submission(
                rx_id, changes=draft["changes"], attestation_note=draft["note"]))
            if key is None:
                self._review_draft = None
                return
            self._pending_submission = {"rx_id": rx_id, "request_id": key}
            self._next_request = ("submit_review", {
                "rx_id": rx_id,
                "changes": draft["changes"],
                "expected_version": draft["version"],
                "expected_status": draft["status"],
                "attestation_note": draft["note"],
                "request_id": key,
            }, self._pending_submission)
            # Remove clinical content from the window after constructing the
            # worker-bound request. The worker discards args on completion.
            self._review_draft = None

        def _received_submission(self, receipt, context):
            self._pending_submission = None
            if not isinstance(context, dict):
                self.info.setText("Uncertain review outcome; manual recovery required")
                return
            try:
                recovery.confirm_submission(
                    context["rx_id"], context["request_id"], receipt)
            except (JournalSafetyError, WorkstationConnectionError, ValueError, OSError):
                self.info.setText(
                    "Server review response received, but local receipt confirmation "
                    "failed. Preserve journal and reconcile; do NOT repeat the edit.")
                self._needs_reconcile = True
                return
            self.last_review_rx = context["rx_id"]
            self.last_review_key = context["request_id"]
            self._next_request = ("queue", self._queue_parameters(), None)
            self.info.setText(
                f"Review response received at version {receipt['version']}; "
                "verify the saved request receipt before proceeding.")

        def _queue_parameters(self):
            return {"query": self.search.text().strip(),
                    "status": self.status.currentData(),
                    "sort": self.sort.currentData(), "limit": 100}

        def _start_receipt_lookup(self, batch, *, manual_request_id=None,
                                  notify=True):
            if (recovery is None or self._lookup_busy
                    or self._request_thread is not None
                    or self._close_after_request or self._close_after_lookup):
                if notify and not self._close_after_lookup and not self._close_after_request:
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
            self._set_network_controls()
            self.edit_sig_button.setEnabled(False)
            self.check_pending_button.setEnabled(False)
            self.info.setText(
                f"Checking {len(batch.entries)} synthetic receipt(s) in background; "
                "edits temporarily disabled")
            worker = RecoveryLookupThread(recovery, batch)
            self._lookup_thread = worker
            self._active_lookup_batch = batch
            self._active_manual_request_id = manual_request_id
            self._active_lookup_notify = notify
            # Explicit queued QObject slots: the journal is NEVER updated from
            # the worker thread, even when Qt signal affinity rules differ.
            worker.completed.connect(
                self._on_recovery_completed, Qt.ConnectionType.QueuedConnection)
            worker.finished.connect(
                self._recovery_finished, Qt.ConnectionType.QueuedConnection)
            worker.finished.connect(worker.deleteLater)
            worker.start()

        @Slot(object)
        def _on_recovery_completed(self, outcome):
            self._recovery_result(
                self._active_lookup_batch, outcome,
                self._active_manual_request_id, self._active_lookup_notify)

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

        @Slot()
        def _recovery_finished(self):
            self._lookup_busy = False
            self._lookup_thread = None
            self._active_lookup_batch = None
            self._active_manual_request_id = None
            self._active_lookup_notify = False
            if self._close_after_lookup:
                QTimer.singleShot(0, self.close)
            else:
                self._set_network_controls()

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
            if rx_id:
                self._launch_request("audit", {"rx_id": rx_id, "limit": 100})

        def _display_audit(self, data):
            lines = ["SYNTHETIC AUDIT — READ ONLY (free-text metadata excluded)", ""]
            for event in data["events"]:
                actor = event.get("actor") or {}
                lines.append(
                    f"{event.get('occurredAt', '')} • {event.get('action', '')} • "
                    f"{actor.get('displayName', '')} ({actor.get('role', '')})")
            self._show_text("Prescription audit trail", "\n".join(lines))

        @Slot(object)
        def _logout_outcome(self, outcome):
            # Logout might fail after server revocation (lost reply). Do not
            # claim that server-side revocation was confirmed.
            self._logout_result = outcome

        @Slot()
        def _logout_finished(self):
            self._logout_done = True
            self._logout_thread = None
            if journal is not None:
                journal.close()
            QTimer.singleShot(0, self.close)

        def closeEvent(self, event):
            if self._request_thread is not None or self._handling_result:
                self._close_after_request = True
                self._review_draft = None
                self._next_request = None
                self.info.setText(
                    "Closing after in-flight network request completes; "
                    "no edit will be automatically retried")
                event.ignore()
                return
            if self._lookup_busy:
                self._close_after_lookup = True
                self.info.setText(
                    "Closing after the in-flight read-only receipt lookup ends")
                event.ignore()
                return
            if self._logout_thread is not None:
                event.ignore()
                return
            if self._logout_done:
                event.accept()
                return
            # Closing must not block Qt while network logout is pending.
            self._close_after_request = True
            self._next_request = None
            self._review_draft = None
            worker = SessionLogoutThread(client)
            self._logout_thread = worker
            worker.completed.connect(
                self._logout_outcome, Qt.ConnectionType.QueuedConnection)
            worker.finished.connect(
                self._logout_finished, Qt.ConnectionType.QueuedConnection)
            worker.finished.connect(worker.deleteLater)
            self.info.setText(
                "Signing out local synthetic session in background…")
            worker.start()
            event.ignore()

    window = LocalWorkstation()
    window.show()
    app.exec()


if __name__ == "__main__":
    main()
