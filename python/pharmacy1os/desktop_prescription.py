"""Native prescription detail and reviewed edit form for synthetic workstations.

Imported only by the optional desktop entry point. All reads and saves resolve
the current actor again; a dialog is never an authorization or version token.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Callable

from PySide6.QtCore import Qt
from PySide6.QtGui import QKeySequence, QPalette, QShortcut
from PySide6.QtWidgets import (
    QComboBox, QDialog, QFormLayout, QHBoxLayout, QLabel, QLineEdit,
    QMessageBox, QPlainTextEdit, QPushButton, QScrollArea, QSpinBox,
    QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget,
)

from .prescription_directory import PrescriptionDirectory
from .prescription_edit import DATE_FIELDS, PrescriptionEditService
from .service import AccessDenied, Actor, PharmacyService, WorkflowError


def _label(text: str = "") -> QLabel:
    widget = QLabel(text)
    widget.setTextFormat(Qt.TextFormat.PlainText)
    widget.setWordWrap(True)
    widget.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
    return widget


def _table(headers: list[str]) -> QTableWidget:
    widget = QTableWidget(0, len(headers))
    widget.setHorizontalHeaderLabels(headers)
    widget.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
    widget.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
    widget.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
    widget.verticalHeader().hide()
    widget.horizontalHeader().setStretchLastSection(True)
    return widget


def _rows(table: QTableWidget, rows) -> None:
    table.setRowCount(0)
    for values in rows:
        row = table.rowCount()
        table.insertRow(row)
        for col, value in enumerate(values):
            text = "" if value is None else str(value)
            item = QTableWidgetItem(text)
            item.setToolTip(text)
            table.setItem(row, col, item)
    table.resizeColumnsToContents()


class PrescriptionDetailDialog(QDialog):
    def __init__(self, service: PharmacyService, actor_provider: Callable[[], Actor],
                 prescription_id: str, parent: QWidget | None = None):
        super().__init__(parent)
        self.service = service
        self.actor_provider = actor_provider
        self.prescription_id = prescription_id
        self.directory = PrescriptionDirectory(service)
        self.edits = PrescriptionEditService(service)
        self.loaded_actor: Actor | None = None
        self.snapshot = None
        self.context = None
        self.editing = False
        self.fills = []
        self.setWindowTitle("Prescription details — synthetic workstation")
        self.resize(1050, 760)
        root = QVBoxLayout(self)
        root.addWidget(_label("SYNTHETIC DEVELOPMENT ONLY • NOT FOR DISPENSING"))
        self.summary = _label()
        self.summary.setObjectName("rx_summary")
        root.addWidget(self.summary)
        self.tabs = QTabWidget()
        root.addWidget(self.tabs, 1)

        page = QWidget()
        layout = QVBoxLayout(page)
        self.provenance = _label()
        layout.addWidget(self.provenance)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self.form_widget = QWidget()
        form = QFormLayout(self.form_widget)
        self.fields = {
            "prescriber_id": QComboBox(), "drug_id": QComboBox(),
            "prescribed_product_id": QComboBox(),
            "product_selection_directive": QComboBox(),
            "sig": QPlainTextEdit(), "quantity": QLineEdit(),
            "refills_allowed": QSpinBox(), "written_date": QLineEdit(),
            "expiration_date": QLineEdit(), "do_not_fill_before": QLineEdit(),
        }
        self.fields["sig"].setMaximumHeight(90)
        self.fields["refills_allowed"].setRange(0, 999)
        for option in ("UNSPECIFIED", "SELECTION_PERMITTED", "DISPENSE_AS_WRITTEN"):
            self.fields["product_selection_directive"].addItem(option.replace("_", " "), option)
        labels = {
            "prescriber_id": "Prescriber", "drug_id": "Medication",
            "prescribed_product_id": "Prescribed NDC", "product_selection_directive": "Product selection",
            "sig": "Directions", "quantity": "Quantity written", "refills_allowed": "Refills allowed",
            "written_date": "Written date", "expiration_date": "Expiration date",
            "do_not_fill_before": "Do not fill before",
        }
        for key, widget in self.fields.items():
            widget.setObjectName(key)
            widget.setAccessibleName(labels[key])
            if key in DATE_FIELDS:
                widget.setPlaceholderText("YYYY-MM-DD; blank clears this date")
            if isinstance(widget, QComboBox):
                # Read-only choices must stay legible on the detail screen.
                palette = widget.palette()
                for role in (QPalette.ColorRole.Text, QPalette.ColorRole.ButtonText):
                    palette.setColor(QPalette.ColorGroup.Disabled, role,
                        palette.color(QPalette.ColorGroup.Active, role))
                widget.setPalette(palette)
            form.addRow(labels[key], widget)
        self.fields["drug_id"].currentIndexChanged.connect(self._products_for_drug)
        self.attestation = QPlainTextEdit()
        self.attestation.setObjectName("edit_attestation")
        self.attestation.setAccessibleName("Pharmacist review note")
        self.attestation.setPlaceholderText("Document the confirmed change and reason (12–2000 characters)")
        self.attestation.setMaximumHeight(85)
        form.addRow("Pharmacist review note", self.attestation)
        scroll.setWidget(self.form_widget)
        layout.addWidget(scroll, 1)
        self.edit_hint = _label()
        layout.addWidget(self.edit_hint)
        self.tabs.addTab(page, "Prescription")

        fills_page = QWidget()
        fills_layout = QVBoxLayout(fills_page)
        self.fill_table = _table(["Fill / attempt", "Status", "Physical qty", "Billed qty",
                                  "Original container", "Discard date", "Bag / bin"])
        self.fill_table.setObjectName("fill_history")
        fills_layout.addWidget(self.fill_table, 1)
        self.fill_table.itemSelectionChanged.connect(self._show_fill)
        parts = QTabWidget()
        self.source_table = _table(["NDC", "Manufacturer", "Lot", "Expiration", "Quantity"])
        self.claim_table = _table(["Sequence", "Payer", "Status", "Billed quantity"])
        self.label_table = _table(["Bottle", "NDC", "Quantity / total"])
        for name, table in (("Scanned sources", self.source_table),
                            ("Synthetic claims", self.claim_table), ("Bottle labels", self.label_table)):
            parts.addTab(table, name)
        fills_layout.addWidget(parts, 1)
        self.tabs.addTab(fills_page, "Fill history")

        audit_page = QWidget()
        audit_layout = QVBoxLayout(audit_page)
        audit_layout.addWidget(_label(
            "Latest 200 Rx, fill and reviewed-edit events. Free-text audit metadata is omitted. "
            "Other clinical and inventory records have separate histories."))
        self.audit_table = _table(["Time (UTC)", "Action", "Staff", "Role"])
        audit_layout.addWidget(self.audit_table)
        self.tabs.addTab(audit_page, "Audit")
        self.edit_table = _table(["Version", "Time (UTC)", "Field", "Before", "After", "Reviewer", "Review note"])
        self.tabs.addTab(self.edit_table, "Form edit history")
        self.message = _label()
        self.message.setObjectName("detail_message")
        root.addWidget(self.message)
        buttons = QHBoxLayout()
        self.edit_button = QPushButton("Edit prescription")
        self.save_button = QPushButton("Save reviewed changes")
        self.reload_button = QPushButton("Reload")
        close_button = QPushButton("Close")
        for button in (self.edit_button, self.save_button, self.reload_button, close_button):
            button.setAutoDefault(False)
            buttons.addWidget(button)
        root.addLayout(buttons)
        self.edit_button.clicked.connect(self.begin_edit)
        self.save_button.clicked.connect(self.save_changes)
        self.reload_button.clicked.connect(self.reload)
        close_button.clicked.connect(self.reject)
        QShortcut(QKeySequence("Ctrl+S"), self).activated.connect(self.save_changes)
        QShortcut(QKeySequence("Ctrl+R"), self).activated.connect(self.reload)
        self.reload()

    def _set_editing(self, editing: bool) -> None:
        self.editing = editing
        for field in self.fields.values():
            if isinstance(field, QComboBox):
                field.setEnabled(editing)
            else:
                field.setReadOnly(not editing)
        self.attestation.setReadOnly(not editing)
        self.save_button.setEnabled(editing)
        self.edit_button.setEnabled(bool(self.context and self.context["editable"] and not editing))

    def _clear(self) -> None:
        self.snapshot = self.context = self.loaded_actor = None
        self.fills = []
        self.summary.clear()
        self.provenance.clear()
        self.edit_hint.clear()
        for key, field in self.fields.items():
            if isinstance(field, QComboBox):
                if key == "product_selection_directive":
                    field.setCurrentIndex(0)
                else:
                    field.clear()
            elif isinstance(field, QSpinBox):
                field.setValue(0)
            else:
                field.clear()
        self.attestation.clear()
        for table in (self.fill_table, self.source_table, self.claim_table,
                      self.label_table, self.audit_table, self.edit_table):
            table.setRowCount(0)
        self._set_editing(False)

    def _values(self) -> dict:
        result = {}
        for key, field in self.fields.items():
            if isinstance(field, QComboBox):
                value = field.currentData()
            elif isinstance(field, QPlainTextEdit):
                value = field.toPlainText().strip()
            elif isinstance(field, QSpinBox):
                value = field.value()
            else:
                value = field.text().strip()
            result[key] = (value or None) if key in DATE_FIELDS else value
        return result

    def _changes(self) -> dict:
        if not self.context:
            return {}
        changes = {}
        for field, value in self._values().items():
            old = self.context["values"][field]
            if field == "quantity":
                try:
                    if Decimal(str(value)) == Decimal(str(old)):
                        continue
                except InvalidOperation:
                    pass  # Service validation will provide the useful error.
            if value != old:
                changes[field] = value
        return changes

    def _confirm_discard(self) -> bool:
        if not self.editing or not (self._changes() or self.attestation.toPlainText().strip()):
            return True
        return QMessageBox.question(self, "Unsaved prescription changes",
            "Discard your unsaved changes?", QMessageBox.StandardButton.Discard |
            QMessageBox.StandardButton.Cancel, QMessageBox.StandardButton.Cancel
        ) == QMessageBox.StandardButton.Discard

    def reject(self) -> None:
        if self._confirm_discard():
            super().reject()

    def reload(self) -> bool:
        if not self._confirm_discard():
            return False
        self._clear()
        try:
            actor = self.actor_provider()
            payload = self.directory.detail(actor, self.prescription_id)
            context = self.edits.context(actor, self.prescription_id)
            timeline = self.directory.audit(actor, self.prescription_id)
            history = self.edits.history(actor, self.prescription_id)
            if payload["version"] != context["version"]:
                raise WorkflowError("Prescription changed during loading; reload before editing")
            self.loaded_actor, self.snapshot, self.context = actor, payload["prescription"], context
            rx = self.snapshot
            self.summary.setText(
                f"Rx {rx['rxNumber']}  •  {rx['status']}  •  Version {rx['version']}\n"
                f"Patient: {rx['patient']['lastName']}, {rx['patient']['firstName']}\n"
                f"Medication: {rx['medicationName']} {rx['strength']} {rx['dosageForm']}")
            self.provenance.setText(
                f"Source: {rx['sourceType']}  •  Electronic reference: {rx['electronicMessageId'] or '—'}  •  "
                f"Refills used: {rx['refillsUsed']} of {rx['refillsAllowed']}")
            for key, options in (("prescriber_id", context["prescribers"]), ("drug_id", context["drugs"])):
                field = self.fields[key]
                field.blockSignals(True)
                for option in options:
                    field.addItem(option["label"], option["id"])
                field.setCurrentIndex(field.findData(context["values"][key]))
                field.blockSignals(False)
            self._products_for_drug()
            for key, value in context["values"].items():
                field = self.fields[key]
                if isinstance(field, QComboBox):
                    field.setCurrentIndex(field.findData(value))
                elif isinstance(field, QPlainTextEdit):
                    field.setPlainText(value or "")
                elif isinstance(field, QSpinBox):
                    field.setValue(value)
                else:
                    field.setText(value or "")
            self.edit_hint.setText(context["blocked_reason"] or
                "Save all reviewed changes together. Editing a DUR prescription returns it to Data Entry.")
            self.fills = rx["fills"]
            _rows(self.fill_table, ((f"{f['fillNumber']} / {f['attempt']}", f["status"],
                f["quantity"], f["billedQuantity"], "Yes" if f["dispensedInOriginalContainer"] else "No",
                f["patientDiscardDate"],
                f"{f['willCall']['bagBarcode']} / {f['willCall']['binName']} ({f['willCall']['status']})"
                if f["willCall"] else "—") for f in self.fills))
            if self.fills:
                self.fill_table.selectRow(0)
            _rows(self.audit_table, ((e["occurredAt"], e["action"], e["actor"]["displayName"],
                e["actor"]["role"]) for e in timeline["events"]))
            _rows(self.edit_table, ((f"{e['version_before']} → {e['version_after']}", e["occurred_at"],
                field, change["before"], change["after"],
                f"{e['actor_name']} ({e['actor_role']})", e["attestation_note"])
                for e in reversed(history) for field, change in e["changes"].items()))
            self._set_editing(False)
            self.message.setText("Loaded. Ctrl+S saves reviewed edits; Ctrl+R reloads.")
            return True
        except Exception as exc:
            self._clear()
            self.message.setText(f"Unable to load prescription: {exc}")
            return False

    def _products_for_drug(self) -> None:
        field = self.fields["prescribed_product_id"]
        previous = field.currentData()
        field.clear()
        field.addItem("No exact NDC specified", None)
        if self.context:
            for product in self.context["products"]:
                if product["drug_id"] == self.fields["drug_id"].currentData():
                    field.addItem(product["label"], product["id"])
        index = field.findData(previous)
        field.setCurrentIndex(max(index, 0))

    def _show_fill(self) -> None:
        index = self.fill_table.currentRow()
        fill = self.fills[index] if 0 <= index < len(self.fills) else None
        _rows(self.source_table, ((s["ndc"], s["manufacturer"], s["lotNumber"], s["expirationDate"],
            s["sourceQuantity"]) for s in (fill["sources"] if fill else [])))
        _rows(self.claim_table, ((c["sequence"], c["payer"], c["status"], c["billedQuantity"])
            for c in (fill["claims"] if fill else [])))
        _rows(self.label_table, ((f"{l['bottleNumber']} of {l['bottleCount']}", l["ndc"],
            f"{l['quantity']} / {l['total']}") for l in (fill["labels"] if fill else [])))

    def _current_actor(self) -> Actor:
        actor = self.actor_provider()
        if actor != self.loaded_actor:
            raise AccessDenied("Signed-in staff changed; reload this prescription")
        # Recheck active identity even if the cached form looked editable.
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
        return actor

    def begin_edit(self) -> None:
        try:
            self._current_actor()
            if not self.context or not self.context["editable"]:
                return
            self._set_editing(True)
            self.tabs.setCurrentIndex(0)
            self.fields["sig"].setFocus()
        except Exception as exc:
            self._clear()
            self.message.setText(f"Edit blocked: {exc}")

    def save_changes(self) -> None:
        if not self.editing or not self.context:
            return
        try:
            actor = self._current_actor()
        except Exception as exc:
            self._clear()
            self.message.setText(f"Save blocked: {exc}")
            return
        try:
            result = self.edits.update(actor, self.prescription_id, self._changes(),
                expected_version=self.context["version"],
                attestation_note=self.attestation.toPlainText())
        except Exception as exc:
            # Keep local input on a stale version/validation conflict; never
            # silently refresh the expected version and overwrite someone else.
            self.message.setText(f"Save blocked: {exc}")
            return
        self._set_editing(False)
        if self.reload():
            self.message.setText(f"Saved version {result['version']}. Status: {result['status']}.")
