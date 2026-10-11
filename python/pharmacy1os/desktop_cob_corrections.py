"""Native selection-driven synthetic COB correction window.

Use only in the opt-in synthetic desktop. The underlying domain service
validates exact current paid transaction ancestry under database row locks.
No payer network calls, hardware output, money or physical stock changes.
"""
from __future__ import annotations

import json

from PySide6.QtWidgets import (
    QComboBox, QDialog, QHBoxLayout, QLabel, QLineEdit, QMessageBox,
    QPushButton, QPlainTextEdit, QInputDialog, QTableWidget,
    QTableWidgetItem, QVBoxLayout,
)


class CobCorrectionDialog(QDialog):
    HEADERS = ("Rx", "Patient", "Fill", "Attempt", "Payers", "Quantity", "Fill ID")

    def __init__(self, actor, worklist, planner, correction, parent=None):
        super().__init__(parent)
        self.actor = actor
        self.worklist = worklist
        self.planner = planner
        self.correction = correction
        self.offset = 0
        self.records: list[dict] = []
        self.current_plan: dict | None = None
        self.setWindowTitle("Prepared COB corrections — local synthetic only")
        self.resize(1140, 770)
        root = QVBoxLayout(self)
        warning = QLabel(
            "LOCAL TEST PAYER RECORDS ONLY — NO REAL INSURANCE REVERSAL, "
            "ADJUDICATION, PAYMENT OR DISPENSE AUTHORIZATION")
        warning.setObjectName("warning")
        warning.setWordWrap(True)
        root.addWidget(warning)
        search_row = QHBoxLayout()
        search_row.addWidget(QLabel("Filter by Rx number"))
        self.rx_filter = QLineEdit()
        self.rx_filter.setPlaceholderText("Optional Rx number")
        self.rx_filter.returnPressed.connect(lambda: self._run(self.change_search))
        search_row.addWidget(self.rx_filter)
        search_button = QPushButton("Search")
        search_button.clicked.connect(lambda _checked=False: self._run(self.change_search))
        search_row.addWidget(search_button)
        root.addLayout(search_row)
        self.table = QTableWidget(0, len(self.HEADERS))
        self.table.setHorizontalHeaderLabels(list(self.HEADERS))
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.verticalHeader().hide()
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.itemSelectionChanged.connect(lambda: self._run(self.select_fill))
        root.addWidget(self.table, 1)
        controls = QHBoxLayout()
        controls.addWidget(QLabel("Correct COB position"))
        self.position = QComboBox()
        self.position.currentIndexChanged.connect(lambda _i: self._run(self.preview))
        controls.addWidget(self.position)
        controls.addWidget(QLabel("Scanned billing NDC"))
        self.ndc = QComboBox()
        controls.addWidget(self.ndc)
        self.apply_button = QPushButton("Pharmacist: commit synthetic correction")
        self.apply_button.clicked.connect(lambda _checked=False: self._run(self.apply))
        controls.addWidget(self.apply_button)
        root.addLayout(controls)
        self.provenance = QPlainTextEdit()
        self.provenance.setReadOnly(True)
        root.addWidget(self.provenance, 1)
        pager = QHBoxLayout()
        self.previous = QPushButton("Previous 25")
        self.previous.clicked.connect(lambda _checked=False: self._run(self.back))
        self.next = QPushButton("Next 25")
        self.next.clicked.connect(lambda _checked=False: self._run(self.forward))
        self.refresh_button = QPushButton("Refresh candidates")
        self.refresh_button.clicked.connect(lambda _checked=False: self._run(self.refresh))
        self.count_label = QLabel()
        pager.addWidget(self.previous)
        pager.addWidget(self.next)
        pager.addWidget(self.refresh_button)
        pager.addStretch()
        pager.addWidget(self.count_label)
        root.addLayout(pager)
        self.can_correct = actor.role in ("ADMIN", "PHARMACIST")
        self.refresh()

    def _run(self, action):
        try:
            action()
        except Exception as exc:
            self.current_plan = None
            self.apply_button.setEnabled(False)
            self.provenance.setPlainText(
                "Action blocked: " + str(exc) +
                "\nRefresh and review synthetic payer provenance before attempting again.")
            QMessageBox.warning(self, "COB workflow blocked", str(exc))

    def change_search(self):
        self.offset = 0
        self.refresh()

    def refresh(self):
        report = self.worklist.page(self.actor, offset=self.offset, limit=25,
                                    rx_query=self.rx_filter.text())
        self.records = report["items"]
        self.current_plan = None
        self.apply_button.setEnabled(False)
        self.position.blockSignals(True)
        self.position.clear()
        self.ndc.clear()
        self.position.blockSignals(False)
        self.provenance.setPlainText(
            "Select a candidate prepared fill to verify its current payer chain.\n"
            "Listing a fill does NOT guarantee correction eligibility.")
        self.table.blockSignals(True)
        self.table.clearSelection()
        self.table.setRowCount(len(self.records))
        for index, record in enumerate(self.records):
            values = (
                record["rx_number"], record["patient_name"], str(record["fill_number"]),
                str(record["attempt"]), str(record["payer_count"]),
                record["physical_quantity"], record["fill_id"][:8],
            )
            for column, value in enumerate(values):
                self.table.setItem(index, column, QTableWidgetItem(value))
        self.table.blockSignals(False)
        self.table.resizeColumnsToContents()
        self.previous.setEnabled(self.offset > 0)
        self.next.setEnabled(report["next_offset"] is not None)
        self.count_label.setText(
            f"Page {self.offset // 25 + 1}; {len(self.records)} candidate(s)")

    def back(self):
        self.offset = max(0, self.offset - 25)
        self.refresh()

    def forward(self):
        self.offset += 25
        self.refresh()

    def chosen(self):
        index = self.table.currentRow()
        if not 0 <= index < len(self.records):
            raise ValueError("Select a prepared COB fill")
        return self.records[index]

    def select_fill(self):
        if self.table.currentRow() < 0:
            self.current_plan = None
            self.apply_button.setEnabled(False)
            return
        candidate = self.chosen()
        # All position options come from the validated preflight, not the
        # stored candidate payer count (which is only a preliminary query).
        self.position.blockSignals(True)
        self.position.clear()
        self.ndc.clear()
        self.current_plan = None
        self.apply_button.setEnabled(False)
        try:
            preview = self.planner.plan(
                self.actor, candidate["fill_id"], target_position=1)
            for number in range(1, preview["payer_count"] + 1):
                self.position.addItem(f"COB {number}", number)
        finally:
            self.position.blockSignals(False)
        self.preview()

    def preview(self):
        self.current_plan = None
        self.apply_button.setEnabled(False)
        candidate = self.chosen()
        target = self.position.currentData()
        if target is None:
            return
        plan = self.planner.plan(
            self.actor, candidate["fill_id"], target_position=target)
        self.ndc.clear()
        current_target = plan["full_chain"][target - 1]["current_billing_ndc"]
        for ndc in plan["available_billing_ndcs"]:
            self.ndc.addItem(ndc, ndc)
        match = self.ndc.findData(current_target)
        if match >= 0:
            self.ndc.setCurrentIndex(match)
        # The current paid attempt IDs are rechecked just before mutating.
        self.current_plan = plan
        self.provenance.setPlainText(json.dumps({
            "rx_number": plan["rx_number"],
            "payer_chain": plan["full_chain"],
            "reverse_positions_last_to_first": plan["reverse_positions"],
            "reprocess_positions_first_to_last": plan["then_reprocess_positions"],
            "unchanged_positions": plan["upstream_positions_unchanged"],
            "available_scanned_NDCs": plan["available_billing_ndcs"],
            "warning": plan["warning"],
        }, indent=2))
        self.apply_button.setEnabled(self.can_correct and bool(plan["available_billing_ndcs"]))

    def apply(self):
        if not self.can_correct:
            raise PermissionError("A pharmacist or administrator must authorize this test correction")
        original = self.current_plan
        if original is None:
            raise ValueError("Review a valid selected COB correction plan first")
        ndc = self.ndc.currentData()
        if ndc not in original["available_billing_ndcs"]:
            raise ValueError("Choose an NDC already present in the physical scanned sources")
        text, accepted = QInputDialog.getMultiLineText(
            self, "Local pharmacist correction documentation",
            "Describe why this synthetic payer position requires NDC correction "
            "(12–1000 characters):")
        if not accepted:
            return
        reason = text.strip()
        if not 12 <= len(reason) <= 1000:
            raise ValueError("Pharmacist correction documentation must be 12–1000 characters")
        fresh = self.planner.plan(
            self.actor, original["fill_id"], target_position=original["target_position"])
        if (fresh["expected_active_paid_transaction_ids"]
                != original["expected_active_paid_transaction_ids"]
                or fresh["available_billing_ndcs"] != original["available_billing_ndcs"]
                or fresh["full_chain"] != original["full_chain"]):
            raise ValueError("Payer history or physical sources changed; refresh the selected plan")
        message = (
            f"Rx {fresh['rx_number']} | target COB {fresh['target_position']}\n"
            f"Reverse local positions {fresh['reverse_positions']} then reprocess "
            f"{fresh['then_reprocess_positions']} using NDC {ndc}.\n\n"
            "No real insurance claim or pharmacy stock is affected. "
            "Confirm one auditable synthetic-only correction?"
        )
        confirm = QMessageBox.question(self, "Pharmacist synthetic correction", message)
        if confirm != QMessageBox.StandardButton.Yes:
            return
        outcome = self.correction.correct(
            self.actor, fresh["fill_id"], reason,
            target_position=fresh["target_position"],
            expected_active_paid_transaction_ids=fresh[
                "expected_active_paid_transaction_ids"],
            corrected_billing_ndc=ndc,
        )
        QMessageBox.information(
            self, "Synthetic COB correction recorded",
            "Local test claim attempts updated. No insurer was contacted.\n"
            f"Reversed {len(outcome['reversal_transaction_ids'])} payer "
            f"position(s), prepared {len(outcome['new_paid_transaction_ids'])} "
            "new local mock attempts.")
        self.refresh()
