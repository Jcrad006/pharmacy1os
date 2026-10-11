"""Interactive native *synthetic-only* Third Party exception worklist.

Qt is imported only when the native desktop is launched. Every command delegates
to site/role-enforcing transactional domain services; this module does not
alter claims or bypass audit/verification gates.
"""
from __future__ import annotations

import json

from PySide6.QtWidgets import (
    QComboBox, QDialog, QHBoxLayout, QLabel, QMessageBox, QPushButton,
    QPlainTextEdit, QInputDialog, QTableWidget, QTableWidgetItem, QVBoxLayout,
)

from .third_party_exceptions import STATUSES


class ThirdPartyExceptionDialog(QDialog):
    COLUMNS = ("Status", "Rx", "Patient", "COB", "Mock reject",
               "Workflow", "Fill", "Event")

    def __init__(self, actor, queue, planner, claims, batch, tracker, parent=None):
        super().__init__(parent)
        self.actor = actor
        self.queue = queue
        self.planner = planner
        self.claims = claims
        self.batch = batch
        self.tracker = tracker
        self.offset = 0
        self.rows: list[dict] = []
        self.setWindowTitle("Third Party — synthetic exception worklist")
        self.resize(1120, 690)
        root = QVBoxLayout(self)
        warning = QLabel(
            "SYNTHETIC TEST DATA ONLY — no insurer contact, claim approval, "
            "payment or dispense authorization")
        warning.setWordWrap(True)
        warning.setObjectName("warning")
        root.addWidget(warning)
        selectors = QHBoxLayout()
        selectors.addWidget(QLabel("Work queue status"))
        self.status = QComboBox()
        self.status.addItem("All exceptions", "ALL")
        for state in sorted(STATUSES):
            self.status.addItem(state.replace("_", " "), state)
        self.status.currentIndexChanged.connect(
            lambda _index: self._change_filter())
        selectors.addWidget(self.status)
        selectors.addStretch()
        root.addLayout(selectors)
        self.grid = QTableWidget(0, len(self.COLUMNS))
        self.grid.setHorizontalHeaderLabels(list(self.COLUMNS))
        self.grid.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.grid.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.grid.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.grid.setAlternatingRowColors(True)
        self.grid.horizontalHeader().setStretchLastSection(True)
        self.grid.verticalHeader().hide()
        self.grid.itemDoubleClicked.connect(lambda _item: self._run(self.inspect))
        root.addWidget(self.grid, 1)
        commands = QHBoxLayout()
        self.inspect_button = QPushButton("Review selected evidence")
        self.inspect_button.clicked.connect(lambda _checked=False: self._run(self.inspect))
        commands.addWidget(self.inspect_button)
        self.track_button = QPushButton("Track selected replacement rescan")
        self.track_button.clicked.connect(lambda _checked=False: self._run(self.track_replacement))
        commands.addWidget(self.track_button)
        self.clear_button = QPushButton("Pharmacist: clear selected mock hold")
        self.clear_button.clicked.connect(lambda _checked=False: self._run(self.clear))
        commands.addWidget(self.clear_button)
        self.retry_button = QPushButton("Pharmacist: retry entire mock COB")
        self.retry_button.clicked.connect(lambda _checked=False: self._run(self.retry))
        commands.addWidget(self.retry_button)
        root.addLayout(commands)
        pager = QHBoxLayout()
        self.previous = QPushButton("Previous page")
        self.previous.clicked.connect(lambda _checked=False: self._run(self.back))
        self.next = QPushButton("Next page")
        self.next.clicked.connect(lambda _checked=False: self._run(self.forward))
        self.reload = QPushButton("Refresh from ledger")
        self.reload.clicked.connect(lambda _checked=False: self._run(self.refresh))
        pager.addWidget(self.previous)
        pager.addWidget(self.next)
        pager.addWidget(self.reload)
        pager.addStretch()
        self.page_label = QLabel()
        pager.addWidget(self.page_label)
        root.addLayout(pager)
        self.can_correct = actor.role in ("PHARMACIST", "ADMIN")
        self.clear_button.setEnabled(self.can_correct)
        self.retry_button.setEnabled(self.can_correct)
        self.refresh()

    def _run(self, operation):
        try:
            operation()
        except Exception as exc:
            QMessageBox.warning(self, "Local action blocked", str(exc))

    def _change_filter(self):
        self.offset = 0
        self._run(self.refresh)

    def selected(self) -> dict:
        index = self.grid.currentRow()
        if not 0 <= index < len(self.rows):
            raise ValueError("Choose an exception row before continuing")
        return self.rows[index]

    def refresh(self):
        report = self.queue.snapshot(
            self.actor, status=self.status.currentData(), limit=25, offset=self.offset)
        self.rows = report["items"]
        self.grid.setRowCount(len(self.rows))
        for index, row in enumerate(self.rows):
            values = (
                row["status"], str(row["rx_number"]), row["patient_name"],
                str(row["coverage_position"] or "—"), str(row["reason_code"] or "—"),
                row["recommended_action"], row["fill_id"][:8], row["event_id"][:8],
            )
            for column, value in enumerate(values):
                self.grid.setItem(index, column, QTableWidgetItem(value))
        self.grid.resizeColumnsToContents()
        self.previous.setEnabled(self.offset > 0)
        self.next.setEnabled(report["next_offset"] is not None)
        self.page_label.setText(
            f"Site worklist — page {self.offset // 25 + 1}, {len(self.rows)} records")
        self.grid.clearSelection()

    def back(self):
        self.offset = max(0, self.offset - 25)
        self.refresh()

    def forward(self):
        self.offset += 25
        self.refresh()

    def inspect(self):
        item = self.selected()
        # List only identifier/status provenance; never display raw claim
        # payloads, member IDs, free text or invented payer payment amounts.
        history = self.claims.list_for_fill(self.actor, item["fill_id"])
        summary = [{
            "id": event["id"], "operation": event["operation"],
            "outcome": event["outcome"], "recorded_at": event["recorded_at"],
            "original_transaction_id": event["original_transaction_id"],
        } for event in history]
        report = {"selected_exception": item, "local_event_history": summary,
                  "warning": "SYNTHETIC TEST EVENTS ONLY — NOT EXTERNAL PAYER HISTORY"}
        details = QDialog(self)
        details.setWindowTitle("Local immutable test provenance")
        details.resize(820, 520)
        layout = QVBoxLayout(details)
        view = QPlainTextEdit()
        view.setReadOnly(True)
        view.setPlainText(json.dumps(report, indent=2))
        layout.addWidget(view)
        close = QPushButton("Close")
        close.clicked.connect(details.accept)
        layout.addWidget(close)
        details.exec()

    def _note(self, label):
        note, ok = QInputDialog.getMultiLineText(
            self, "Pharmacist documentation", label)
        if not ok:
            return None
        note = note.strip()
        if not 12 <= len(note) <= 2000:
            raise ValueError("Pharmacist documentation must be 12–2000 characters")
        return note

    def clear(self):
        if not self.can_correct:
            raise PermissionError("Only a pharmacist or administrator may clear mock holds")
        item = self.selected()
        if item["kind"] != "TEST_HOLD" or item["status"] != "OPEN_TEST_REJECTION":
            raise ValueError("Select an open test hold, not a completed or reconciliation item")
        note = self._note("Document reviewed test hold and local clearance:")
        if note is None:
            return
        confirmation = QMessageBox.question(
            self, "Clear development hold only",
            "Record pharmacist local clearance? This does NOT mean an insurer "
            "approved a claim and does not release a prescription.")
        if confirmation != QMessageBox.StandardButton.Yes:
            return
        self.claims.resolve_rejection(self.actor, item["event_id"], note)
        self.refresh()

    def retry(self):
        if not self.can_correct:
            raise PermissionError("Only a pharmacist or administrator may retry mock claims")
        item = self.selected()
        if (item["kind"] != "TEST_HOLD"
                or item["status"] != "CLEARED_AWAITING_RETRY"):
            raise ValueError("Choose a pharmacist-cleared mock hold awaiting retry")
        # The plan is generated from *all* current events for this fill;
        # never infer all coverage/hold IDs from only a paginated page.
        plan = self.planner.plan(self.actor, item["fill_id"])
        if item["event_id"] not in {row["rejection_id"] for row in plan["rejections"]}:
            raise ValueError("Selected exception is no longer part of the active mock fill")
        reason = self._note("Document reason for retrying all simulated COB positions:")
        if reason is None:
            return
        confirmation = QMessageBox.question(
            self, "Prepare synthetic COB claims only",
            f"Retry {plan['test_holds']} resolved mock hold(s) and prepare "
            f"{len(plan['coverage_ids'])} synthetic payer position(s)? "
            "This does NOT contact an insurer or print/verify a real prescription.")
        if confirmation != QMessageBox.StandardButton.Yes:
            return
        if plan["mode"] == "SINGLE":
            pair = plan["rejections"][0]
            self.claims.retry_cleared_rejection(
                self.actor, pair["rejection_id"],
                expected_resolution_id=pair["expected_resolution_id"],
                coverage_ids=plan["coverage_ids"], reason=reason)
        else:
            self.batch.retry(
                self.actor, plan["fill_id"],
                rejections=[{
                    "rejection_id": pair["rejection_id"],
                    "expected_resolution_id": pair["expected_resolution_id"],
                } for pair in plan["rejections"]],
                coverage_ids=plan["coverage_ids"], reason=reason)
        QMessageBox.information(
            self, "Local retry prepared",
            "Synthetic claims/labels were prepared in the test database. "
            "No external payer response, real payment, or pharmacist verification exists.")
        self.refresh()

    def track_replacement(self):
        item = self.selected()
        if item["kind"] != "REPLACEMENT_FILL":
            raise ValueError("Choose a replacement fill exception to track")
        report = self.tracker.detail(self.actor, item["fill_id"])
        dialog = QDialog(self)
        dialog.setWindowTitle("Local replacement rescan and history")
        dialog.resize(780, 480)
        layout = QVBoxLayout(dialog)
        viewer = QPlainTextEdit()
        viewer.setReadOnly(True)
        viewer.setPlainText(json.dumps(report, indent=2))
        layout.addWidget(viewer)
        close = QPushButton("Close")
        close.clicked.connect(dialog.accept)
        layout.addWidget(close)
        dialog.exec()
