"""Native Qt workstation. Runs Python services in-process; no browser/Chromium.

Install the optional 'desktop' dependency and opt in to synthetic demo mode.
The GUI is an early rewrite workbench, not feature-parity with React yet.
"""
from __future__ import annotations

import os
import json
from pathlib import Path
from decimal import Decimal
from uuid import uuid4

from .documents import DocumentService
from .inventory_ops import InventoryService
from .inventory_fefo import FefoPolicyService
from .inventory_locations import InventoryLocationService
from .inventory_allocations import InventoryAllocationService
from .inventory_demands import InventoryDemandService
from .inventory_discrepancies import ReceivingDiscrepancyService, DISCREPANCY_TYPES
from .inventory_asof import HistoricalInventoryService
from .inventory_exceptions import InventoryExceptionRegistry
from .inventory_advanced import AdvancedInventoryService
from .inventory_planning import InventoryPlanningService
from .lifecycle import LifecycleService
from .prescription_transfer import TransferService
from .prescription_edit import PrescriptionEditService
from .clinical_records import ClinicalRecordService
from .label_printing import LabelPrintService
from .fill_completion import FillCompletionService, FillObligation
from .emergency_supply import EmergencySupplyService
from .provider_directory import ProviderDirectory
from .scheduling import SchedulingService
from .billing import BillingService
from .insurance import InsuranceDirectory
from .claim_transactions import SandboxClaimService
from .willcall import WillCallService
from .pos import PosService
from .patient_directory import PatientDirectory
from .exceptions import ExceptionService
from .communications import CommunicationService
from .structured_changes import StructuredChangeService
from .date_rules import DateRulesService
from .auth import AuthService, AuthenticationFailed

from sqlalchemy import select

from .models import Claim, DocumentChange, Drug, DUR, Fill, Patient, Prescriber, Prescription, Product, Staff, Stock, WillCall
from .service import Actor, PharmacyService


VIEWS = [
    "Dashboard", "Exceptions", "Will Call", "New Prescription", "Patients",
    "Providers", "Drug / Product", "Receiving", "Inventory", "Third Party",
    "Supply Chain", "Future Fills", "Communications",
]


def main() -> None:
    if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise SystemExit("Native workstation disabled by default. Set PHARMACY1OS_SYNTHETIC_DEMO=1 for synthetic data.")
    try:
        from PySide6.QtCore import Qt, QRectF
        from PySide6.QtGui import QBrush, QColor, QImage, QKeySequence, QPainter, QPen, QPixmap, QShortcut
        from PySide6.QtWidgets import (
            QApplication, QComboBox, QDialog, QFileDialog, QFormLayout, QGraphicsScene, QGraphicsView, QHBoxLayout, QInputDialog,
            QLabel, QLineEdit, QMainWindow, QMessageBox, QPushButton,
            QStackedWidget, QTableWidget, QTableWidgetItem, QVBoxLayout,
            QWidget,
        )
    except ImportError as exc:
        raise SystemExit("Install the native UI dependency: pip install -e './python[desktop]'") from exc

    base = Path.home() / ".pharmacy1os" / "synthetic"
    base.mkdir(parents=True, exist_ok=True)
    mode = os.getenv("PHARMACY1OS_NATIVE_AUTH_MODE", "demo")
    if mode not in ("demo", "session"):
        raise SystemExit("Unsupported synthetic workstation authentication mode")
    service = PharmacyService(f"sqlite+pysqlite:///{base / 'pharmacy1os.sqlite3'}")
    service.create_schema()
    auth_service = AuthService(service)
    document_service = DocumentService.from_demo_env(service)
    inventory_service = InventoryService(service)
    inventory_locations = InventoryLocationService(service)
    fefo_policies = FefoPolicyService(service)
    inventory_allocations = InventoryAllocationService(service)
    inventory_demands = InventoryDemandService(service)
    receiving_discrepancies = ReceivingDiscrepancyService(service)
    inventory_history = HistoricalInventoryService(service)
    stock_exceptions = InventoryExceptionRegistry(service)
    advanced_service = AdvancedInventoryService(service)
    planning_service = InventoryPlanningService(service)
    lifecycle_service = LifecycleService(service)
    transfer_service = TransferService(service)
    edit_service = PrescriptionEditService(service)
    clinical_records = ClinicalRecordService(service)
    label_printer = LabelPrintService(service)
    completion_service = FillCompletionService(service)
    emergency_service = EmergencySupplyService(service)
    directory_service = ProviderDirectory(service)
    scheduling_service = SchedulingService(service)
    billing_service = BillingService(service)
    insurance_service = InsuranceDirectory(service)
    sandbox_claims = SandboxClaimService(service)
    will_call_service = WillCallService(service)
    pos_service = PosService(service)
    patient_directory = PatientDirectory(service)
    exception_service = ExceptionService(service)
    communication_service = CommunicationService(service, document_service)
    structured_changes = StructuredChangeService(service, document_service)
    date_rules_service = DateRulesService(service)
    with service.sessions() as session:
        users = session.scalars(select(Staff).order_by(Staff.name)).all()
    if not users:
        if mode == "session":
            raise SystemExit("No synthetic user enrolled; provision a synthetic administrator offline first")
        service.bootstrap_demo()

    app = QApplication([])
    app.setApplicationName("Pharmacy1OS — Synthetic Python Workstation")
    app.setStyleSheet("""
        QMainWindow, QWidget { background: #101827; color: #e6edf7; font-size: 13px; }
        QPushButton { background: #23344c; color: white; padding: 9px 12px; border: 1px solid #46617e; border-radius: 5px; text-align: left; }
        QPushButton:hover { background: #355273; }
        QPushButton:disabled { color: #8595a7; }
        QLineEdit, QComboBox, QTableWidget { background: #172438; color: #f0f5fc; padding: 6px; border: 1px solid #496078; }
        QTableWidget::item:selected { background: #356090; }
        QLabel#warning { color: #f3c683; font-size: 13px; }
    """)

    class Window(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("Pharmacy1OS — Python native synthetic workstation")
            self.resize(1280, 760)
            root = QWidget(); self.setCentralWidget(root)
            frame = QHBoxLayout(root)
            left = QWidget(); left.setFixedWidth(220)
            menu = QVBoxLayout(left)
            title = QLabel("Pharmacy1OS  |  Rx"); title.setStyleSheet("font-size: 22px; font-weight: bold")
            menu.addWidget(title)
            menu.addWidget(QLabel("Python-native desktop preview"))
            self.nav_buttons = []
            for i, name in enumerate(VIEWS):
                btn = QPushButton(f"F{i + 1}  {name}")
                btn.clicked.connect(lambda _checked=False, index=i: self.navigate(index))
                menu.addWidget(btn)
                self.nav_buttons.append(btn)
                shortcut = QShortcut(QKeySequence(f"F{i + 1}"), self)
                shortcut.activated.connect(lambda index=i: self.navigate(index))
            menu.addStretch(1)
            menu.addWidget(QLabel("Development identity (NOT authentication)" if mode == "demo"
                                  else "Signed-in synthetic session"))
            self.actor_box = QComboBox()
            self.actors = {}
            with service.sessions() as s:
                for staff in s.scalars(select(Staff).order_by(Staff.role, Staff.name)).all():
                    self.actors[staff.id] = Actor(staff.id, staff.site_id, staff.role)
                    self.actor_box.addItem(f"{staff.name} — {staff.role}", staff.id)
            menu.addWidget(self.actor_box)
            self.actor_box.setVisible(mode == "demo")
            self.auth_token = None
            if mode == "session":
                username, ok = QInputDialog.getText(self, "Synthetic login", "Username")
                if not ok:
                    raise SystemExit("Synthetic login cancelled")
                password, ok = QInputDialog.getText(
                    self, "Synthetic login", "Password", QLineEdit.EchoMode.Password)
                if not ok:
                    raise SystemExit("Synthetic login cancelled")
                try:
                    session = auth_service.login(username, password)
                except AuthenticationFailed:
                    raise SystemExit("Invalid synthetic account credentials")
                self.auth_token = session["access_token"]
                menu.addWidget(QLabel("Signed in as " + session["role"]))
                logout_button = QPushButton("Sign out")
                logout_button.clicked.connect(self.sign_out)
                menu.addWidget(logout_button)
            menu.addWidget(QLabel("No real patient information.", objectName="warning"))
            frame.addWidget(left)

            right = QWidget(); main = QVBoxLayout(right)
            self.heading = QLabel(); self.heading.setStyleSheet("font-size: 23px; font-weight: bold")
            main.addWidget(self.heading)
            self.notice = QLabel("SYNTHETIC DEVELOPMENT ONLY  •  NOT FOR DISPENSING  •  NO LIVE CLAIMS")
            self.notice.setObjectName("warning"); main.addWidget(self.notice)
            self.search = QLineEdit(); self.search.setPlaceholderText("Search Rx number, patient, or drug")
            self.search.returnPressed.connect(self.refresh)
            main.addWidget(self.search)
            self.toolbar = QHBoxLayout(); main.addLayout(self.toolbar)
            self.table = QTableWidget()
            self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
            self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
            self.table.setAlternatingRowColors(True)
            self.table.verticalHeader().hide()
            main.addWidget(self.table, 1)
            self.message = QLabel("Ready")
            main.addWidget(self.message)
            frame.addWidget(right, 1)
            self.selected_view = 0
            self.rows: list[tuple[str, ...]] = []
            self.navigate(0)
            self.actor_box.currentIndexChanged.connect(self.refresh)

        @property
        def actor(self) -> Actor:
            if mode == "session":
                return auth_service.verify(self.auth_token)
            return self.actors[self.actor_box.currentData()]

        def sign_out(self):
            if self.auth_token:
                auth_service.logout(self.auth_token)
                self.auth_token = None
            self.close()

        def action(self, title: str, handler):
            btn = QPushButton(title)
            btn.clicked.connect(lambda: self.invoke(handler))
            self.toolbar.addWidget(btn)

        def invoke(self, handler):
            try:
                handler()
                self.message.setText("Action completed (synthetic database)")
                self.refresh()
            except Exception as exc:
                QMessageBox.warning(self, "Action blocked", str(exc))
                self.message.setText(f"Blocked: {exc}")

        def ask(self, title: str, prompt: str, default: str = "") -> str:
            value, ok = QInputDialog.getText(self, title, prompt, text=default)
            if not ok or not value.strip():
                raise ValueError("Action cancelled or required value missing")
            return value.strip()

        def selected_id(self) -> str:
            index = self.table.currentRow()
            if index < 0 or index >= len(self.rows):
                raise ValueError("Select a row first")
            return self.rows[index][0]

        def navigate(self, page: int):
            self.selected_view = page
            self.heading.setText(VIEWS[page])
            for i, btn in enumerate(self.nav_buttons):
                btn.setStyleSheet("background: #326394" if i == page else "")
            while self.toolbar.count():
                widget = self.toolbar.takeAt(0).widget()
                if widget:
                    widget.deleteLater()
            self.search.setVisible(page in (0, 1, 4))
            if page == 0:
                self.action("Advance → DUR", self.advance)
                self.action("Start Fill", self.start_fill)
                self.action("Stop / Convert To Partial", self.convert_to_partial)
                self.action("Supply Owed Completion", self.start_completion)
                self.action("View Physical Balance", self.view_completion_balance)
                self.action("Authorize Synthetic Emergency", self.authorize_emergency)
                self.action("Complete Emergency Follow-up", self.emergency_followup)
                self.action("Scan Product Source", self.scan)
                self.action("Remove Incorrect Scanned Source", self.remove_scanned_source)
                self.action("Set Original Container Packaging", self.set_fill_packaging)
                self.action("Prepare Labels / Sandbox COB", self.prepare)
                self.action("Prepare With Patient Coverages", self.prepare_with_coverages)
                self.action("Preview / Print Synthetic Bottle", self.print_test_label)
                self.action("Pharmacist Verify", self.verify)
                self.action("Stage Will Call", self.stage)
                self.action("Sell / Pickup", self.sell)
                self.action("Return To Stock", self.return_stock)
                self.action("Hold Rx", self.hold_rx)
                self.action("Resume Rx", self.resume_rx)
                self.action("Cancel Rx", self.cancel_rx)
                self.action("Pharmacist Edit Unfilled Rx", self.edit_unfilled_rx)
                self.action("Record Pharmacist Intervention", self.record_pharmacist_intervention)
                self.action("Review Rx Clinical Record", self.review_rx_clinical_record)
                self.action("Request Transfer Out", self.request_transfer_out)
                self.action("Attest External Transfer", self.attest_transfer_out)
                self.action("Withdraw Transfer Request", self.withdraw_transfer_out)
                self.action("Rx Documents", self.document_window)
                self.action("Date Rules / Min Refill Interval", self.rx_date_policy)
            elif page == 2:
                self.action("Multi-Fill Checkout (Synthetic)", self.pos_checkout)
                self.action("Refund / Void (Synthetic)", self.pos_adjust)
                self.action("Rebag / Retire Old Barcode", self.rebag_will_call)
                self.action("Relocate Package", self.relocate_will_call)
                self.action("Custody History", self.will_call_history)
            elif page == 3:
                self.action("Enter New Prescription", self.new_rx)
            elif page == 4:
                self.action("Register Patient", self.add_patient)
            elif page == 5:
                self.action("Register Provider", self.add_provider)
                self.action("Add Identifier", self.provider_add_identifier)
                self.action("Add Phone / Fax", self.provider_add_contact)
                self.action("Add Address", self.provider_add_address)
                self.action("View Directory", self.provider_detail)
            elif page == 6:
                self.action("Add Drug", self.add_drug)
                self.action("Add Detailed Drug / Compliance", self.add_drug_detailed)
                self.action("Add Product / NDC", self.add_product)
                self.action("Add Detailed Product Package", self.add_product_detailed)
                self.action("Register Barcode", self.register_barcode)
            elif page == 7:
                self.action("Receive Scanned Product", self.receive)
                self.action("View Receiving Discrepancies", self.view_receiving_discrepancies)
                self.action("Report Receiving Discrepancy", self.report_receiving_discrepancy)
                self.action("Resolve Receiving Discrepancy (Pharmacist)", self.resolve_receiving_discrepancy)
                self.action("View Discrepancy Audit History", self.view_receiving_discrepancy_history)
            elif page == 8:
                self.action("Quarantine", self.quarantine_stock)
                self.action("Resolve Hold", self.resolve_stock_hold)
                self.action("Adjust Stock", self.adjust_stock)
                self.action("Stock Ledger", self.stock_ledger)
                self.action("Historical As-Of Lot Balance", self.inventory_asof_balance)
                self.action("View Inventory Exception Register", self.view_inventory_exceptions)
                self.action("Refresh Inventory Exceptions", self.refresh_inventory_exceptions)
                self.action("Acknowledge Inventory Exception", self.acknowledge_inventory_exception)
                self.action("Resolve Inventory Exception (Pharmacist)", self.resolve_inventory_exception)
                self.action("Inventory Exception History", self.inventory_exception_history)
                self.action("Create Physical Location", self.create_inventory_location)
                self.action("View Locations", self.show_inventory_locations)
                self.action("Reconcile Lot To Location", self.reconcile_inventory_location)
                self.action("View Lot Positions", self.show_inventory_positions)
                self.action("Move Available Stock Between Locations", self.move_inventory_location)
                self.action("FEFO Advisory", self.show_fefo_advisory)
                self.action("View FEFO Policies", self.view_fefo_policies)
                self.action("Configure FEFO Policy (Pharmacist)", self.configure_fefo_policy)
                self.action("View Fill / Physical Allocation History", self.show_fill_allocations)
                self.action("View Inventory Demands / Backorders", self.view_inventory_demands)
                self.action("Create Manual / Reorder Demand", self.create_inventory_demand)
                self.action("Reconcile Drug Inventory Demands", self.reconcile_inventory_demands)
                self.action("Cancel Manual / Reorder Demand", self.cancel_inventory_demand)
                self.action("View Demand History", self.view_inventory_demand_history)
            elif page == 9:
                self.action("Create Synthetic Payer", self.create_payer)
                self.action("View Payers", self.show_payers)
                self.action("Set Patient Coverage Position", self.set_coverage)
                self.action("View Patient Coverages", self.view_coverages)
                self.action("Deactivate Patient Coverage", self.deactivate_coverage)
                self.action("New Payer Rule Version", self.configure_payer)
                self.action("Coverage-Linked Claim History", self.covered_claim_history)
                self.action("Synthetic Claim Transactions", self.view_claim_transactions)
                self.action("View Rejection Queue", self.show_test_rejections)
                self.action("Inject Development Test Rejection", self.inject_test_rejection)
                self.action("Pharmacist Clear Test Rejection", self.clear_test_rejection)
                self.action("Claim History", self.claim_history)
            elif page == 12:
                self.action("New Communication Task", self.communication_create)
                self.action("Approve / Review", self.communication_review)
                self.action("Manual Contact Attempt", self.communication_attempt)
                self.action("Cancel Communication", self.communication_cancel)
                self.action("Event History", self.communication_history)
            elif page == 11:
                self.action("Schedule Fill", self.schedule_new)
                self.action("Start Due Fill", self.schedule_start)
                self.action("Cancel Schedule", self.schedule_cancel)
                self.action("Begin Refill DUR", self.schedule_refill_review)
            elif page == 10:
                self.action("Replenishment Planner", self.manage_replenishment)
                self.action("Purchase Orders", self.manage_po)
                self.action("Site Transfers", self.manage_transfer)
                self.action("Cycle Counts", self.manage_count)
                self.action("Product Recalls", self.manage_recall)
            self.action("Refresh", self.refresh)
            self.refresh()

        def refresh(self):
            self.rows = []
            page = self.selected_view
            if page == 12:
                headers = ["Rx", "Direction", "Channel", "Status", "Purpose"]
                self.rows = [(x["id"], x["prescription_id"][:8], x["direction"],
                              x["channel"], x["status"], x["summary"])
                             for x in communication_service.list(self.actor)]
            elif page == 11:
                headers = ["Rx", "Due", "Status", "Quantity"]
                self.rows = [(x["id"], x["prescription_id"][:8], x["due_date"],
                              x["status"], x["quantity"] or "Full")
                             for x in scheduling_service.list(self.actor)]
            elif page == 10:
                headers = ["Type", "Identifier", "Status", "Detail"]
                self.rows = [(x['id'], 'PO', x['reference'], x['status'], x['vendor'])
                             for x in advanced_service.purchase_orders(self.actor)]
                self.rows += [(x['id'], 'Transfer', x['id'][:8], x['status'],
                               f"{x['quantity']} to {x['to_site_id'][:8]}")
                              for x in advanced_service.transfers(self.actor)]
                self.rows += [(x['id'], 'Cycle count', x['id'][:8], x['status'],
                               f"{len(x['lines'])} lines")
                              for x in advanced_service.cycle_counts(self.actor)]
                self.rows += [(x['id'], 'Recall', x['reference'], x['status'],
                               x['lot'] or 'Entire NDC')
                              for x in advanced_service.recalls(self.actor)]
            elif page == 0:
                headers = ["Rx", "Patient", "Drug", "Workflow"]
                self.rows = [(x["id"], x["rx_number"], x["patient"], x["drug"], x["status"])
                             for x in service.queue(self.actor, self.search.text())]
            else:
                with service.sessions() as s:
                    if page == 1:
                        headers = ["Kind", "Severity", "Rx", "Patient", "Issue / Next step"]
                        self.rows = [(x["id"], x["kind"], x["severity"], x["rx_number"],
                                      x["patient_name"], x["title"])
                                     for x in exception_service.list(self.actor, query=self.search.text())]
                    elif page == 2:
                        headers = ["Bag", "Bin", "Status"]
                        self.rows = [(x.id, x.bag_barcode, x.bin_name, x.status)
                                     for x in s.scalars(select(WillCall).join(Fill, WillCall.fill_id == Fill.id).join(Prescription, Fill.prescription_id == Prescription.id).where(Prescription.site_id == self.actor.site_id)).all()]
                    elif page == 3:
                        headers = ["Rx number", "Patient", "Status"]
                        self.rows = [(x["id"], x["rx_number"], x["patient"], x["status"])
                                     for x in service.queue(self.actor)]
                    elif page == 4:
                        headers = ["Last", "First", "DOB", "Phone"]
                        self.rows = [(x["id"], x["last_name"], x["first_name"], x["date_of_birth"] or "", x["phone"] or "")
                                     for x in patient_directory.search(self.actor, query=self.search.text())]
                    elif page == 5:
                        headers = ["Last", "First", "Credential", "NPI"]
                        self.rows = [(x.id, x.last_name, x.first_name, x.practice_level, x.npi or "")
                                     for x in s.scalars(select(Prescriber).where(Prescriber.site_id == self.actor.site_id)).all()]
                    elif page == 6:
                        headers = ["Drug", "Strength", "Form", "Controlled"]
                        self.rows = [(x.id, x.name, x.strength, x.dosage_form, str(x.controlled))
                                     for x in s.scalars(select(Drug)).all()]
                    elif page in (7, 8):
                        headers = ["NDC", "Lot", "Expiration", "On hand", "Reserved", "Quarantine"]
                        stock = s.scalars(select(Stock).where(Stock.site_id == self.actor.site_id)).all()
                        self.rows = [(x.id, s.get(Product, x.product_id).ndc, x.lot, x.expires,
                                      str(x.on_hand), str(x.reserved), str(x.quarantined)) for x in stock]
                    else:
                        headers = ["Payer", "Sequence", "Status", "Billed qty"]
                        self.rows = [(x.id, x.payer, str(x.sequence), x.status, str(x.billed_quantity))
                                     for x in s.scalars(select(Claim).join(Fill, Claim.fill_id == Fill.id).join(Prescription, Fill.prescription_id == Prescription.id).where(Prescription.site_id == self.actor.site_id)).all()]
            self.table.setColumnCount(len(headers))
            self.table.setHorizontalHeaderLabels(headers)
            self.table.setRowCount(len(self.rows))
            for i, row in enumerate(self.rows):
                for j, value in enumerate(row[1:]):
                    self.table.setItem(i, j, QTableWidgetItem(str(value)))
            self.table.resizeColumnsToContents()
            self.message.setText(f"{len(self.rows)} records · {self.actor.role} · development")

        def schedule_new(self):
            rx_number = self.ask("Future fill", "Existing prescription number")
            with service.sessions() as s:
                rx = s.scalar(select(Prescription).where(Prescription.site_id == self.actor.site_id,
                                                          Prescription.rx_number == rx_number))
                if rx is None:
                    raise ValueError("Prescription not found at this pharmacy")
            due = self.ask("Future fill", "Due date YYYY-MM-DD")
            qty = self.ask("Future fill", "Quantity or '-' for full", "-")
            key = self.ask("Future fill", "Unique request reference / idempotency key")
            scheduling_service.schedule(self.actor, rx.id, due, key,
                                        None if qty == "-" else qty)

        def schedule_start(self):
            scheduling_service.start_due(self.actor, self.selected_id())

        def schedule_cancel(self):
            scheduling_service.cancel(self.actor, self.selected_id(),
                                      self.ask("Future fill", "Cancellation reason"))

        def schedule_refill_review(self):
            rx_number = self.ask("Refill", "Existing sold prescription number")
            with service.sessions() as s:
                rx = s.scalar(select(Prescription).where(Prescription.site_id == self.actor.site_id,
                                                          Prescription.rx_number == rx_number))
                if rx is None:
                    raise ValueError("Prescription not found at this pharmacy")
            scheduling_service.begin_refill_review(self.actor, rx.id,
                                                    self.ask("Refill", "Reason for new DUR review"))

        def choose_insurance_patient(self):
            with service.sessions() as s:
                users = s.scalars(select(Patient).where(
                    Patient.site_id == self.actor.site_id)
                    .order_by(Patient.last_name, Patient.first_name)).all()
                options = [(x.id, x.last_name, x.first_name) for x in users]
            return self.choose_item("Patients", "Select patient",
                options, lambda x: f"{x[1]}, {x[2]} [{x[0][:8]}]")[0]

        def create_payer(self):
            payer = self.ask("Insurance payer", "Payer display name")
            bin = self.ask("Insurance payer", "Six-digit BIN (optional)", "")
            pcn = self.ask("Insurance payer", "Processor control number (optional)", "")
            group = self.ask("Insurance payer", "Default group number (optional)", "")
            insurance_service.create_payer(self.actor, payer,
                bin=bin or None, pcn=pcn or None, default_group_id=group or None)
            QMessageBox.information(self, "Synthetic insurance",
                "Payer record created. No payer network eligibility or claims integration was enabled.")

        def show_payers(self):
            records = insurance_service.list_payers(self.actor)
            QMessageBox.information(self, "Site payers (synthetic)",
                json.dumps(records, indent=2))

        def set_coverage(self):
            patient = self.choose_insurance_patient()
            payers = insurance_service.list_payers(self.actor)
            chosen = self.choose_item("Payers", "Select payer",
                [x for x in payers if x["active"]],
                lambda x: f"{x['name']} [{x['id'][:8]}]")
            position = int(self.ask("Coverage", "Coordination order (1-4)", "1"))
            member = self.ask("Coverage", "Synthetic member ID (not real patient data)")
            group = self.ask("Coverage", "Group ID (optional)", "")
            relation = self.choose_item("Relationship", "Cardholder relationship",
                ["SELF", "SPOUSE", "CHILD", "OTHER"], lambda x: x)
            insurance_service.upsert_coverage(self.actor, patient, position, chosen["id"],
                member, group_id=group or None, relationship=relation)

        def view_coverages(self):
            patient = self.choose_insurance_patient()
            rows = insurance_service.list_coverages(self.actor, patient)
            QMessageBox.information(self, "Synthetic coverage (member IDs masked)",
                json.dumps(rows, indent=2))

        def deactivate_coverage(self):
            patient = self.choose_insurance_patient()
            rows = insurance_service.list_coverages(self.actor, patient)
            choice = self.choose_item("Coverage positions", "Select to deactivate",
                [x for x in rows if x["active"]],
                lambda x: f"{x['position']} – {x['payer_name']} ({x['member_id_masked']})")
            reason = self.ask("Coverage", "Reason for deactivation")
            insurance_service.deactivate_coverage(self.actor, patient,
                choice["position"], reason)

        def covered_claim_history(self):
            rx_id = self.ask("Coverage claim history", "Prescription ID")
            fid = self.fill_for_rx(rx_id)
            history = insurance_service.fill_claim_history(self.actor, fid)
            QMessageBox.information(self, "Coverage-linked synthetic history",
                json.dumps(history, indent=2))

        def prepare_with_coverages(self):
            rx_id = self.selected_id()
            fid = self.fill_for_rx(rx_id)
            with service.sessions() as s:
                rx = service._site(s, Prescription, rx_id, self.actor)
                patient = rx.patient_id
            available = insurance_service.list_coverages(self.actor, patient)
            ordered = sorted([x for x in available if x["active"] and x["payer_active"]],
                             key=lambda x: x["position"])
            if not ordered:
                raise ValueError("No active patient payer coverages; use the Third Party page")
            selected = [x["id"] for x in ordered]
            question = "\\n".join(
                f"{x['position']}: {x['payer_name']} [{x['member_id_masked']}]"
                for x in ordered)
            answer = QMessageBox.question(self, "Synthetic insurance coverage",
                "Prepare using these coverage positions? This does NOT transmit insurance "
                "claims, verify eligibility or calculate real COB.\\n" + question)
            if answer != QMessageBox.StandardButton.Yes:
                return
            labels = service.prepare_for_review(
                self.actor, fid, [], coverage_ids=selected)
            QMessageBox.information(self, "Synthetic label creation",
                "\\n".join(labels))

        def view_claim_transactions(self):
            fill_id = self.ask("Synthetic claim history", "Fill ID")
            history = sandbox_claims.list_for_fill(self.actor, fill_id)
            QMessageBox.information(self, "Immutable synthetic claim operations",
                json.dumps(history, indent=2)[:12000] or "No synthetic claim operations")

        def show_test_rejections(self):
            records = sandbox_claims.rejection_queue(self.actor)
            QMessageBox.information(self, "Synthetic rejection queue",
                json.dumps(records, indent=2)[:12000] or "No development-only rejections")

        def inject_test_rejection(self):
            with service.sessions() as s:
                service._authorized(s, self.actor, "correct")
                candidates = s.scalars(select(Fill).join(Prescription, Fill.prescription_id == Prescription.id)
                    .where(Prescription.site_id == self.actor.site_id,
                           Fill.status == "PRODUCT_FILL")).all()
                fill_rows = [(f.id, s.get(Prescription, f.prescription_id).rx_number,
                              s.get(Prescription, f.prescription_id).patient_id)
                             for f in candidates]
            selected = self.choose_item("Active fills", "Choose target for TEST rejection",
                fill_rows, lambda row: f"{row[1]} [{row[0][:8]}]")
            covs = insurance_service.list_coverages(self.actor, selected[2])
            cov = self.choose_item("Patient coverages", "Choose synthetic coverage",
                covs, lambda row: f"#{row['position']} {row['payer_name']} [{row['member_id_masked']}]")
            code = self.choose_item("Development rejection code",
                "Simulated reject only — NOT a real payer response",
                ["TEST_70", "TEST_75", "TEST_79"], lambda row: row)
            reason = self.ask("Synthetic rejection", "Document testing reason")
            ident = "gui-reject-" + str(uuid4())
            sandbox_claims.inject_rejection(self.actor, selected[0], cov["id"],
                code, ident, reason)
            QMessageBox.information(self, "Development test rejection",
                "TEST rejection saved locally and fill review is blocked. "
                "No insurance claim was transmitted or rejected by an insurer.")

        def clear_test_rejection(self):
            with service.sessions() as s:
                service._authorized(s, self.actor, "correct")
            rejects = [row for row in sandbox_claims.rejection_queue(self.actor)
                       if row["status"] == "OPEN_TEST_REJECTION"]
            chosen = self.choose_item("Development rejections", "Select test hold",
                rejects, lambda row: f"{row['code']} | Fill {row['fill_id'][:8]}")
            note = self.ask("Pharmacist test resolution",
                "Document independently reviewed simulated test hold")
            sandbox_claims.resolve_rejection(self.actor, chosen["id"], note)
            QMessageBox.information(self, "Test hold cleared",
                "Local development hold cleared; NO insurance approval was obtained.")

        def configure_payer(self):
            payer = self.ask("Payer", "Payer name")
            max_sources = int(self.ask("Payer", "Maximum physical sources (1-4)", "4"))
            strategy = self.ask("Payer", "Sandbox NDC strategy: MAJORITY_NDC or FIRST_SCANNED",
                                "MAJORITY_NDC")
            reason = self.ask("Payer", "Document why this billing profile is being changed")
            billing_service.update_profile(self.actor, payer, max_physical_sources=max_sources,
                                           billing_ndc_strategy=strategy, reason=reason)

        def claim_history(self):
            with service.sessions() as s:
                claim = s.get(Claim, self.selected_id())
                if claim is None:
                    raise ValueError("Select a claim record")
                fill_id = claim.fill_id
            history = billing_service.history(self.actor, fill_id)
            QMessageBox.information(self, "Synthetic claim provenance",
                                    json.dumps(history, indent=2))

        def pos_checkout(self):
            fill_ids = [x.strip() for x in self.ask(
                "Synthetic checkout", "Fill IDs separated by commas").split(",") if x.strip()]
            amounts = [x.strip() for x in self.ask(
                "Synthetic checkout", "Manual line amounts separated by commas (no real pricing)").split(",")]
            mode = self.ask("Synthetic checkout", "WILL_CALL or IMMEDIATE", "WILL_CALL").upper()
            if len(fill_ids) != len(amounts):
                raise ValueError("Provide exactly one line amount per fill")
            bags = {}
            if mode == "WILL_CALL":
                barcodes = [x.strip() for x in self.ask(
                    "Synthetic checkout", "Scanned physical bag barcodes, same order").split(",")]
                if len(barcodes) != len(fill_ids):
                    raise ValueError("Provide one scanned bag per fill")
                bags = dict(zip(fill_ids, barcodes))
            from decimal import Decimal
            total = sum((Decimal(x) for x in amounts), Decimal("0"))
            tender_type = self.ask("Synthetic checkout", "CASH/CARD/CHECK/OTHER", "CASH").upper()
            tenders = [] if total == 0 else [{"method": tender_type, "amount": str(total)}]
            recipient = self.ask("Synthetic checkout", "Recipient name")
            identity = self.ask("Synthetic checkout", "Identity verification method",
                                "DATE_OF_BIRTH").upper()
            signature = self.ask("Synthetic checkout", "Attested signature method",
                                 "PAPER").upper()
            approval = QMessageBox.question(self, "Synthetic checkout",
                "Confirm identity verified and signature attested?\\n"
                "NO REAL MONEY OR CLAIMS WILL BE PROCESSED.")
            if approval != QMessageBox.StandardButton.Yes:
                return
            key = self.ask("Synthetic checkout", "Unique checkout request key")
            result = pos_service.checkout(self.actor,
                lines=[{"fill_id":fid, "amount":amt} for fid, amt in zip(fill_ids, amounts)],
                tenders=tenders, scanned_bags=bags, recipient_name=recipient,
                identity_method=identity, signature_method=signature,
                signature_attested=True, idempotency_key=key, mode=mode)
            QMessageBox.information(self, "Synthetic POS receipt",
                pos_service.receipt(self.actor, result["id"]))

        def pos_adjust(self):
            tx_id = self.ask("Synthetic POS", "Transaction ID")
            action = self.ask("Synthetic POS", "REFUND, VOID, or LEDGER", "LEDGER").upper()
            if action == "LEDGER":
                data = pos_service.ledger(self.actor, tx_id)
                QMessageBox.information(self, "Financial event ledger",
                                        json.dumps(data, indent=2))
                return
            reason = self.ask("Synthetic POS", "Document financial adjustment reason")
            key = self.ask("Synthetic POS", "Unique idempotency request key")
            if action == "REFUND":
                amount = self.ask("Synthetic POS", "Refund amount")
                method = self.ask("Synthetic POS", "Refund method", "CASH").upper()
                result = pos_service.refund(self.actor, tx_id, amount, method, reason, key)
            elif action == "VOID":
                result = pos_service.void(self.actor, tx_id, reason, key)
            else:
                raise ValueError("Unknown synthetic POS adjustment")
            QMessageBox.information(self, "Synthetic financial record",
                                    json.dumps(result, indent=2))

        def communication_create(self):
            number = self.ask("Communication", "Existing prescription number")
            with service.sessions() as session:
                rx = session.scalar(select(Prescription).where(
                    Prescription.site_id == self.actor.site_id,
                    Prescription.rx_number == number))
                if rx is None:
                    raise ValueError("Prescription not found at this pharmacy")
            sources = document_service.list_sources(self.actor, rx.id)
            if not sources:
                raise ValueError("An immutable document must be stored before opening a communication task")
            doc = self.ask("Communication", "Immutable source document ID", sources[-1]["id"])
            direction = self.ask("Communication", "INBOUND or OUTBOUND", "OUTBOUND")
            channel = self.ask("Communication", "FAX or PHONE; ERX inbound only", "FAX")
            destination = self.ask("Communication", "Office or communication party")
            reason = self.ask("Communication", "Purpose of contact")
            key = self.ask("Communication", "Unique request key")
            communication_service.create(self.actor, rx.id, doc, direction,
                                         channel, destination, reason, key)

        def communication_review(self):
            task_id = self.selected_id()
            task = next((x for x in communication_service.list(self.actor)
                         if x["id"] == task_id), None)
            if task is None:
                raise ValueError("Communication task no longer exists")
            action = "REVIEWED" if task["direction"] == "INBOUND" else "APPROVED"
            reason = self.ask("Communication", "Document pharmacist review")
            key = self.ask("Communication", "Unique review key")
            communication_service.change(self.actor, task_id, action, reason, key)

        def communication_attempt(self):
            task_id = self.selected_id()
            detail = self.ask("Contact attempt", "Describe manual attempt; delivery is NOT verified")
            key = self.ask("Contact attempt", "Unique event key")
            communication_service.change(self.actor, task_id, "ATTEMPT_RECORDED", detail, key)

        def communication_cancel(self):
            task_id = self.selected_id()
            detail = self.ask("Communication cancel", "Cancellation reason")
            key = self.ask("Communication cancel", "Unique cancellation key")
            communication_service.change(self.actor, task_id, "CANCELLED", detail, key)

        def communication_history(self):
            events = communication_service.history(self.actor, self.selected_id())
            QMessageBox.information(self, "Communication events — NOT proof of delivery",
                                    json.dumps(events, indent=2))

        def selected_will_call_fill(self):
            with service.sessions() as session:
                bag = session.get(WillCall, self.selected_id())
                if bag is None:
                    raise ValueError("Select a Will Call package first")
                return bag.fill_id

        def rebag_will_call(self):
            fill_id = self.selected_will_call_fill()
            barcode = self.ask("Rebag Will Call", "New unique bag barcode")
            reason = self.ask("Rebag Will Call", "Reason for replacing physical bag")
            will_call_service.rebag(self.actor, fill_id, barcode, reason)

        def relocate_will_call(self):
            fill_id = self.selected_will_call_fill()
            bin_name = self.ask("Move Will Call", "New bin/location label")
            reason = self.ask("Move Will Call", "Document reason for move")
            will_call_service.relocate(self.actor, fill_id, bin_name, reason)

        def will_call_history(self):
            fill_id = self.selected_will_call_fill()
            events = will_call_service.history(self.actor, fill_id)
            QMessageBox.information(self, "Will Call custody (synthetic)",
                                    json.dumps(events, indent=2))

        def rx_date_policy(self):
            rx_id = self.selected_id()
            current = date_rules_service.preview(self.actor, rx_id)
            QMessageBox.information(self, "Synthetic Rx date eligibility",
                                    json.dumps(current, indent=2))
            if self.actor.role not in ("PHARMACIST", "ADMIN"):
                return
            selection = QMessageBox.question(
                self, "Synthetic Rx date policy",
                "Edit the minimum interval between sold fills?\n"
                "This is a synthetic safety setting, NOT insurance or legal authorization.")
            if selection != QMessageBox.StandardButton.Yes:
                return
            days = int(self.ask("Rx minimum interval", "Number of days (0–365)",
                                str(current["minimum_days_between_fills"])))
            reason = self.ask("Rx minimum interval", "Document reason for rule change")
            date_rules_service.set_minimum_days(self.actor, rx_id, days, reason)

        def fill_for_rx(self, rx_id):
            with service.sessions() as s:
                fills = s.scalars(select(Fill).where(Fill.prescription_id == rx_id)).all()
                available = [x for x in fills if x.status in ("PRODUCT_FILL", "PHARMACIST_REVIEW", "READY")]
                if not available:
                    raise ValueError("No active fill for the selected prescription")
                return sorted(available, key=lambda x: (x.fill_number, x.attempt))[-1].id

        def advance(self):
            service.advance_to_dur(self.actor, self.selected_id())

        def start_fill(self):
            rx_id = self.selected_id()
            qty = self.ask("Start Fill", "Dispense quantity (partial or full)")
            service.start_fill(self.actor, rx_id, qty)

        def choose_anchor(self):
            rx_id = self.selected_id()
            with service.sessions() as s:
                obligations = s.scalars(select(FillObligation).where(
                    FillObligation.prescription_id == rx_id,
                    FillObligation.site_id == self.actor.site_id).order_by(
                    FillObligation.id)).all()
                anchors = [(x.anchor_fill_id, str(x.remaining), x.status)
                           for x in obligations]
            return self.choose_item("Partial fills", "Select original physical fill",
                anchors, lambda x: f"{x[0][:8]} | Remaining {x[1]} | {x[2]}")[0]

        def convert_to_partial(self):
            fill_id = self.fill_for_rx(self.selected_id())
            amount = self.ask("Partial interruption", "Physical quantity available")
            reason = self.ask("Partial interruption", "Describe the stock shortage/interruption")
            completion_service.interrupt_as_partial(self.actor, fill_id, amount, reason)
            QMessageBox.information(self, "Physical fill reset",
                "Previous reservations were released. Rescan the actual physical part "
                "before proceeding. The originally billed quantity is preserved.")

        def start_completion(self):
            anchor_id = self.choose_anchor()
            current = completion_service.balance(self.actor, anchor_id)
            if current["status"] != "OPEN":
                raise ValueError("No owed quantity remains on this partial fill")
            amount = self.ask("Physical completion",
                "Quantity to supply (maximum remaining owed)", current["remaining_owed"])
            completion_service.begin_completion(self.actor, anchor_id, amount)
            QMessageBox.information(self, "Completion created",
                "Scan the supplied physical products and complete pharmacist review. "
                "The original payer claim is not duplicated.")

        def view_completion_balance(self):
            balance = completion_service.balance(self.actor, self.choose_anchor())
            QMessageBox.information(self, "Owed physical quantity",
                f"Logical quantity: {balance['intended']}\n"
                f"Physically sold: {balance['physically_sold']}\n"
                f"Remaining owed: {balance['remaining_owed']}\n"
                f"Status: {balance['status']}")

        def authorize_emergency(self):
            rx_id = self.selected_id()
            amount = self.ask("Synthetic emergency", "Physical quantity (prior SOLD Rx only)")
            note = self.ask("Synthetic emergency", "Pharmacist reason for exception")
            due = self.ask("Synthetic emergency",
                "Follow-up due with timezone (e.g. 2026-11-01T15:00:00-04:00)")
            fill_id = emergency_service.authorize(self.actor, rx_id, amount, note, due)
            QMessageBox.information(self, "Synthetic emergency authorization",
                f"Physical fill {fill_id[:8]} created. Scan and submit for pharmacist review. "
                "No payer claims permitted. Follow-up appears in Exceptions.")

        def emergency_followup(self):
            events = emergency_service.list(self.actor, include_closed=False)
            selected = self.choose_item("Emergency follow-up", "Select emergency fill",
                events, lambda e: f"{e['fill_id'][:8]} | due {e['follow_up_due_at']} | {e['status']}")
            emergency_service.complete_follow_up(self.actor, selected["fill_id"],
                self.ask("Emergency follow-up", "Document completed clinical follow-up"))
        def request_transfer_out(self):
            rx_id = self.selected_id()
            pharmacy = self.ask("External transfer request", "Receiving pharmacy name")
            phone = self.ask("External transfer request", "Receiving pharmacy phone")
            reason = self.ask("External transfer request", "Transfer request justification")
            key = self.ask("External transfer request", "Stable request reference")
            event_id = transfer_service.request(self.actor, rx_id, pharmacy, phone, reason, key)
            QMessageBox.information(self, "Transfer recorded",
                f"Request {event_id[:8]} saved. NO fax/eRx or external transmission "
                "occurred. A pharmacist must separately attest the completed handoff.")

        def transfer_selection(self):
            items = transfer_service.list(self.actor)
            pending = [x for x in items if x["status"] == "REQUESTED"]
            return self.choose_item("Transfer requests", "Select pending request",
                pending, lambda x: f"{x['destination_name']} | {x['id'][:8]}")

        def attest_transfer_out(self):
            item = self.transfer_selection()
            receiver = self.ask("Transfer attestation", "Receiving pharmacist name")
            reference = self.ask("Transfer attestation", "Independent handoff reference")
            note = self.ask("Transfer attestation", "Document the actual outside exchange")
            answer = QMessageBox.question(self, "Transfer attestation",
                "Did you personally confirm an external transfer took place? "
                "No electronic transmission is performed by Pharmacy1OS.")
            if answer != QMessageBox.StandardButton.Yes:
                return
            transfer_service.attest_out(self.actor, item["id"],
                receiving_pharmacist=receiver, handoff_reference=reference,
                note=note, personally_confirmed=True)

        def withdraw_transfer_out(self):
            item = self.transfer_selection()
            reason = self.ask("Withdraw transfer", "Reason for withdrawing request")
            transfer_service.withdraw(self.actor, item["id"], reason)

        def scan(self):
            fid = self.fill_for_rx(self.selected_id())
            barcode = self.ask("Product Fill", "Scan/enter registered barcode")
            lot = self.ask("Product Fill", "Lot number")
            exp = self.ask("Product Fill", "Expiration YYYY-MM-DD")
            qty = self.ask("Product Fill", "Quantity from this physical bottle")
            location_id = None
            with service.sessions() as session:
                from .models import Barcode
                row = session.scalar(select(Barcode).where(Barcode.value == barcode))
                stock = session.scalar(select(Stock).where(
                    Stock.site_id == self.actor.site_id,
                    Stock.product_id == row.product_id if row else "",
                    Stock.lot == lot, Stock.expires == exp))
                if stock is not None and stock.location_tracking_enabled:
                    available = inventory_locations.positions(self.actor, stock.id)
                    chosen = self.choose_item("Physical product fill", "Confirm scanned stock location",
                        [p for p in available if Decimal(p["available"]) > 0],
                        lambda p: f"{p['code']} | available {p['available']}")
                    location_id = chosen["location_id"]
            try:
                service.scan_source(self.actor, fid, barcode, lot, exp, qty,
                                    location_id=location_id)
            except Exception as exc:
                if (not str(exc).startswith("FEFO policy requires earlier stock")
                        or self.actor.role not in {"PHARMACIST", "ADMIN"}):
                    raise
                note = self.ask("Pharmacist FEFO override",
                    "Document why an earlier lot or minimum shelf life cannot be used")
                service.scan_source(self.actor, fid, barcode, lot, exp, qty,
                                    location_id=location_id, fefo_override_note=note)

        def set_fill_packaging(self):
            fill_id = self.fill_for_rx(self.selected_id())
            in_original = QMessageBox.question(self,
                "Product packaging", "Will the product be dispensed in its original manufacturer container?"
            ) == QMessageBox.StandardButton.Yes
            reason = self.ask("Packaging attestation",
                "Document original-container or repackaging decision")
            details = service.set_fill_packaging(self.actor, fill_id,
                dispensed_in_original_container=in_original, note=reason)
            QMessageBox.information(self, "Packaging choice recorded",
                json.dumps(details, indent=2) + "\n\nPatient discard metadata is calculated at pharmacist verification.")

        def remove_scanned_source(self):
            fill_id = self.fill_for_rx(self.selected_id())
            sources = service.scanned_sources(self.actor, fill_id)
            source = self.choose_item("Source correction",
                "Select the incorrectly scanned product", sources,
                lambda x: f"{x['ndc']} | {x['lot']} | {x['quantity']} | {x['description']}")
            reason = self.ask("Source correction", "Reason for releasing this reservation")
            result = service.remove_scanned_source(
                self.actor, fill_id, source["id"], reason)
            QMessageBox.information(self, "Stock reservation released",
                json.dumps(result, indent=2) + "\n\nRescan the verified bottle to proceed.")

        def prepare(self):
            fid = self.fill_for_rx(self.selected_id())
            payers = self.ask("Billing", "Comma-separated sandbox payers, or CASH", "CASH")
            names = [] if payers.upper() == "CASH" else [p.strip() for p in payers.split(",")]
            labels = service.prepare_for_review(self.actor, fid, names)
            QMessageBox.information(self, "Synthetic bottle labels", "\n".join(labels))

        def print_test_label(self):
            """Operator-initiated native OS dialog; all output visibly marked synthetic."""
            fill_id = self.fill_for_rx(self.selected_id())
            jobs = label_printer.list(self.actor, fill_id)
            job = self.choose_item("Bottle label snapshots", "Select physical bottle",
                jobs, lambda x: f"Bottle {x['bottle_number']} | {x['status']} | {x['id'][:8]}")
            label_text = label_printer.preview(self.actor, job["id"])
            QMessageBox.information(self, "SYNTHETIC bottle label preview", label_text)
            decision = QMessageBox.question(self, "Development-only local printing",
                "Open your operating system's native print dialog for this clearly "
                "watermarked SYNTHETIC TEST LABEL? Never print or dispense for patients.")
            if decision != QMessageBox.StandardButton.Yes:
                return
            with service.sessions() as s:
                service._authorized(s, self.actor, "verify")
            try:
                from PySide6.QtPrintSupport import QPrinter, QPrintDialog
                from PySide6.QtGui import QTextDocument
            except ImportError as exc:
                raise ValueError("Native OS print support is not installed") from exc
            printer = QPrinter(QPrinter.PrinterMode.HighResolution)
            printer.setDocName("Pharmacy1OS SYNTHETIC TEST LABEL")
            dialogue = QPrintDialog(printer, self)
            if dialogue.exec() != QDialog.DialogCode.Accepted:
                return
            reason = self.ask("Test print audit", "Document print/reprint reason")
            event_id = label_printer.record_output_attempt(
                self.actor, job["id"], f"QT-{uuid4()}", reason,
                dialog_accepted=True)
            paper = QTextDocument()
            paper.setPlainText(label_text)
            paper.print_(printer)
            QMessageBox.information(self, "Test spool requested",
                f"Recorded output attempt {event_id[:8]}. The application cannot "
                "confirm that the printer physically produced a label.")

        def verify(self):
            service.verify(self.actor, self.fill_for_rx(self.selected_id()))

        def stage(self):
            fid = self.fill_for_rx(self.selected_id())
            bin_name = self.ask("Will Call", "Bin")
            bag = self.ask("Will Call", "Unique bag barcode")
            service.stage_will_call(self.actor, fid, bin_name, bag)

        def sell(self):
            fid = self.fill_for_rx(self.selected_id())
            with service.sessions() as s:
                staged = s.scalar(select(WillCall).where(WillCall.fill_id == fid))
            bag = self.ask("Checkout", "Scan bag barcode") if staged else None
            identity = QMessageBox.question(self, "Checkout", "Was recipient identity verified?")
            signature = QMessageBox.question(self, "Checkout", "Was signature attested?")
            amount = self.ask("Checkout", "Patient amount (synthetic)", "0")
            tender = self.ask("Checkout", "Tender method", "CASH")
            service.sell(self.actor, fid, identity == QMessageBox.StandardButton.Yes,
                         signature == QMessageBox.StandardButton.Yes, amount, tender, bag)

        def return_stock(self):
            fid = self.fill_for_rx(self.selected_id())
            service.return_to_stock(self.actor, fid, self.ask("Return to stock", "Reason"))

        def add_patient(self):
            service.add_patient(self.actor, self.ask("Patient", "First name"), self.ask("Patient", "Last name"))

        def add_provider(self):
            service.add_prescriber(self.actor, self.ask("Provider", "First name"),
                                   self.ask("Provider", "Last name"), self.ask("Provider", "Practice level (MD/NP/etc)") )

        def provider_add_identifier(self):
            prescriber_id = self.selected_id()
            kind = self.ask("Provider identifier", "Type: NPI, DEA, STATE_ID, OTHER", "NPI")
            number = self.ask("Provider identifier", "Registration / identifier number")
            jurisdiction = self.ask("Provider identifier", "Jurisdiction or '-' for none", "-")
            primary = QMessageBox.question(self, "Provider identifier", "Set as primary identifier?")
            directory_service.add_identifier(self.actor, prescriber_id, kind, number,
                                             "" if jurisdiction == "-" else jurisdiction,
                                             primary == QMessageBox.StandardButton.Yes)

        def provider_add_contact(self):
            prescriber_id = self.selected_id()
            kind = self.ask("Provider contact", "Type: PHONE or FAX", "PHONE")
            number = self.ask("Provider contact", "Phone / fax number")
            label = self.ask("Provider contact", "Label", "Office")
            primary = QMessageBox.question(self, "Provider contact", "Set as primary contact of this type?")
            directory_service.add_contact(self.actor, prescriber_id, kind, number, label=label,
                                          is_primary=primary == QMessageBox.StandardButton.Yes)

        def provider_add_address(self):
            prescriber_id = self.selected_id()
            line1 = self.ask("Provider address", "Street address")
            city = self.ask("Provider address", "City")
            state = self.ask("Provider address", "State", "NC")
            postal = self.ask("Provider address", "Postal code")
            primary = QMessageBox.question(self, "Provider address", "Set as primary practice address?")
            directory_service.add_address(self.actor, prescriber_id, line1, city, state, postal,
                                          is_primary=primary == QMessageBox.StandardButton.Yes)

        def provider_detail(self):
            detail = directory_service.details(self.actor, self.selected_id())
            QMessageBox.information(self, "Provider directory — synthetic", json.dumps(detail, indent=2))

        def add_drug(self):
            service.add_drug(self.actor, self.ask("Drug", "Name"), self.ask("Drug", "Strength"),
                             self.ask("Drug", "Dosage form"))

        def add_product(self):
            drug_id = self.selected_id()
            service.add_product(self.actor, drug_id, self.ask("NDC", "NDC"),
                                self.ask("NDC", "Manufacturer"), self.ask("NDC", "Descriptor"))

        def add_drug_detailed(self):
            """Preserve source catalog metadata; block unvalidated classes from filling."""
            name = self.ask("Detailed Drug", "Generic name")
            strength = self.ask("Detailed Drug", "Strength")
            dosage = self.ask("Detailed Drug", "Dosage form")
            brand = self.ask("Detailed Drug", "Brand (optional)", "")
            route = self.ask("Detailed Drug", "Route (optional)", "")
            schedule = self.choose_item("Controlled classification", "Schedule", [
                "NONE", "II", "III", "IV", "V", "UNCLASSIFIED"
            ], lambda x: x)
            flags = {}
            for key, label in (
                ("nc_narrow_therapeutic_index", "Narrow therapeutic index"),
                ("is_biological", "Biological medicine"),
                ("requires_cold_chain", "Cold-chain handling required"),
            ):
                flags[key] = QMessageBox.question(self, label,
                    f"Is this drug classified as: {label}?") == QMessageBox.StandardButton.Yes
            service.add_drug(self.actor, name, strength, dosage,
                brand_name=brand or None, route=route or None,
                controlled_substance_schedule=schedule,
                **flags)

        def add_product_detailed(self):
            drug_id = self.selected_id()
            ndc = self.ask("Detailed product", "NDC")
            manufacturer = self.ask("Detailed product", "Manufacturer")
            descriptor = self.ask("Detailed product", "Product description")
            price = self.ask("Detailed product", "Unit price", "0")
            units = self.ask("Detailed product", "Units per package", "100")
            package_price = self.ask("Detailed product", "Package price", "0")
            package_type = self.ask("Detailed product", "Package type (optional)", "")
            te = self.ask("Detailed product", "Therapeutic equivalence code (optional)", "")
            service.add_product(self.actor, drug_id, ndc, manufacturer, descriptor, price,
                units_per_package=units, package_price=package_price,
                package_type=package_type or None,
                therapeutic_equivalence_code=te or None)

        def register_barcode(self):
            ndc = self.ask("Barcode", "NDC of product")
            with service.sessions() as s:
                product = s.scalar(select(Product).where(Product.ndc == ndc))
                if not product:
                    raise ValueError("NDC not found; create a product first")
                pid = product.id
            service.register_barcode(self.actor, pid, self.ask("Barcode", "Barcode value"))

        def receive(self):
            service.receive(self.actor, self.ask("Receiving", "Barcode"),
                            self.ask("Receiving", "Lot"), self.ask("Receiving", "Expiry YYYY-MM-DD"),
                            self.ask("Receiving", "Quantity"))

        def hold_rx(self):
            lifecycle_service.hold(self.actor, self.selected_id(), self.ask("Hold Rx", "Reason"))

        def resume_rx(self):
            lifecycle_service.resume(self.actor, self.selected_id(), self.ask("Resume Rx", "Reason"))

        def cancel_rx(self):
            lifecycle_service.cancel(self.actor, self.selected_id(), self.ask("Cancel Rx", "Reason"))

        def record_pharmacist_intervention(self):
            rx_id = self.selected_id()
            note = self.ask("Pharmacist intervention",
                "Document clinical assessment, professional communication or intervention")
            result = clinical_records.record_intervention(self.actor, rx_id, note)
            QMessageBox.information(self, "Intervention recorded",
                f"Append-only clinical note {result['id']} recorded.\n"
                "This note does not resolve DUR or amend the prescription.")

        def review_rx_clinical_record(self):
            record = clinical_records.clinical_record(self.actor, self.selected_id())
            QMessageBox.information(self, "Prescription clinical record",
                json.dumps(record, indent=2)[:16000])

        def edit_unfilled_rx(self):
            """Audited pharmacist edit; never overwrites scanned original or previous fill."""
            rx_id = self.selected_id()
            with service.sessions() as s:
                service._authorized(s, self.actor, "clinical")
                rx = service._site(s, Prescription, rx_id, self.actor)
                expected = rx.version
            choices = [
                "sig", "quantity", "refills_allowed", "prescriber_id", "drug_id",
                "prescribed_product_id", "product_selection_directive",
                "written_date", "expiration_date", "do_not_fill_before",
            ]
            field = self.choose_item("Reviewed Rx edit", "Select original data-entry field",
                choices, lambda x: x)
            if field == "product_selection_directive":
                proposed = self.choose_item("Product directive", "Choose",
                    ["UNSPECIFIED", "SELECTION_PERMITTED", "DISPENSE_AS_WRITTEN"], lambda x: x)
            elif field == "prescriber_id":
                with service.sessions() as s:
                    options = s.scalars(select(Prescriber).where(
                        Prescriber.site_id == self.actor.site_id)).all()
                    proposed = self.choose_item("Prescriber", "Select corrected provider",
                        options, lambda p: f"{p.last_name}, {p.first_name}").id
            elif field == "drug_id":
                with service.sessions() as s:
                    options = s.scalars(select(Drug).where(Drug.active.is_(True))).all()
                    proposed = self.choose_item("Drug", "Select corrected medication",
                        options, lambda d: f"{d.name} {d.strength}").id
            elif field == "prescribed_product_id":
                with service.sessions() as s:
                    options = s.scalars(select(Product).where(
                        Product.drug_id == rx.drug_id, Product.active.is_(True))).all()
                    proposed = self.choose_item("Prescribed NDC", "Select corrected NDC",
                        options, lambda p: f"{p.ndc} | {p.description}").id
            else:
                value = self.ask("Pharmacist-reviewed Rx edit",
                    f"New {field} (blank clears optional date)", "")
                if field == "refills_allowed":
                    proposed = int(value)
                elif field in {"written_date", "expiration_date", "do_not_fill_before"}:
                    proposed = value or None
                else:
                    proposed = value
            note = self.ask("Pharmacist review", "Document the independently confirmed change")
            response = edit_service.update(self.actor, rx_id, {field: proposed},
                expected_version=expected, attestation_note=note)
            QMessageBox.information(self, "Prescription updated",
                f"Version {response['version']} saved. Any completed DUR review "
                "was reset to Data Entry when required.")

        def quarantine_stock(self):
            stock_id = self.selected_id()
            inventory_service.create_hold(self.actor, stock_id,
                    self.ask("Quarantine", "Quantity"), self.ask("Quarantine", "Reason"))

        def resolve_stock_hold(self):
            holds = [h for h in inventory_service.active_holds(self.actor) if h["status"] == "ACTIVE"]
            if not holds:
                raise ValueError("No active holds at this location")
            names = [f"{h['id'][:8]} - {h['quantity']} - {h['reason']}" for h in holds]
            selection, ok = QInputDialog.getItem(self, "Inventory holds", "Select active hold", names, 0, False)
            if not ok:
                raise ValueError("Selection cancelled")
            option, ok = QInputDialog.getItem(self, "Disposition", "Disposition", ["RELEASED", "DISPOSED"], 0, False)
            if not ok:
                raise ValueError("Selection cancelled")
            inventory_service.resolve_hold(self.actor, holds[names.index(selection)]["id"], option,
                    self.ask("Disposition", "Reason for resolution"))

        def adjust_stock(self):
            inventory_service.adjust(self.actor, self.selected_id(),
                    self.ask("Stock adjustment", "Signed change (+/- qty)"),
                    self.ask("Stock adjustment", "Reason"))

        def choose_inventory_location(self, title, *, nonquarantine=True):
            locations = inventory_locations.locations(self.actor)
            available = [item for item in locations if item["active"]
                         and (not nonquarantine or not item["is_quarantine"])]
            return self.choose_item(title, "Choose physical stock location", available,
                lambda row: f"{row['code']} | {row['name']} [{row['type']}]")

        def create_inventory_location(self):
            name = self.ask("New inventory location", "Location name")
            code = self.ask("New inventory location", "Location code")
            category = self.choose_item("Location type", "Choose physical type",
                ["SHELF", "BIN", "RECEIVING", "QUARANTINE", "REFRIGERATOR",
                 "FREEZER", "SAFE", "RETURN_TO_VENDOR", "WILL_CALL", "OTHER"], lambda x: x)
            is_quarantine = category == "QUARANTINE"
            receiving = not is_quarantine and (
                QMessageBox.question(self, "Default receiving",
                    "Make this the site's default RECEIVING location?")
                == QMessageBox.StandardButton.Yes)
            dispensing = not is_quarantine and (
                QMessageBox.question(self, "Default dispensing",
                    "Make this the site's default DISPENSING location?")
                == QMessageBox.StandardButton.Yes)
            barcode = self.ask("Location", "Location barcode (optional)", "")
            inventory_locations.create(self.actor, code, name, category,
                barcode=barcode or None, is_default_receiving=receiving,
                is_default_dispensing=dispensing, is_quarantine=is_quarantine)

        def show_inventory_locations(self):
            QMessageBox.information(self, "Synthetic physical locations",
                json.dumps(inventory_locations.locations(self.actor), indent=2)[:12000])

        def reconcile_inventory_location(self):
            stock_id = self.choose_stock()
            location = self.choose_inventory_location("Initial physical stock location")
            note = self.ask("Physical reconciliation",
                "Document confirmed on-hand count and initial physical location")
            inventory_locations.activate_stock(self.actor, stock_id, location["id"], note)
            QMessageBox.information(self, "Location tracking activated",
                "Future stock movements are now reconciled against this physical lot "
                "position. This is a synthetic verified baseline, not a historical "
                "physical location reconstruction.")

        def show_inventory_positions(self):
            stock_id = self.choose_stock()
            data = inventory_locations.positions(self.actor, stock_id)
            QMessageBox.information(self, "Physical stock positions",
                json.dumps(data, indent=2)[:12000])

        def move_inventory_location(self):
            stock_id = self.choose_stock()
            original = self.choose_inventory_location("Source location")
            destination = self.choose_inventory_location("Destination location")
            quantity = self.ask("Physical inventory move", "Available quantity to relocate")
            reason = self.ask("Physical inventory move", "Reason for physical custody change")
            inventory_locations.move(self.actor, stock_id, original["id"], destination["id"],
                                     quantity, reason)

        def view_receiving_discrepancies(self):
            rows = receiving_discrepancies.list(self.actor)
            QMessageBox.information(self, "Receiving discrepancy register",
                (json.dumps(rows, indent=2) if rows else "No discrepancies recorded")[:16000]
                + "\n\nClosing a discrepancy never changes stock on its own.")

        def report_receiving_discrepancy(self):
            category = self.choose_item("Receiving discrepancy", "Select problem category",
                sorted(DISCREPANCY_TYPES), lambda x: x.replace("_", " "))
            po_id = self.ask("Receiving discrepancy", "Purchase order ID (optional)", "")
            line_id = self.ask("Receiving discrepancy", "PO line ID (optional)", "")
            receipt_id = self.ask("Receiving discrepancy", "Receipt ID (optional)", "")
            expected = self.ask("Receiving discrepancy", "Expected units (optional)", "")
            observed = self.ask("Receiving discrepancy", "Observed units (optional)", "")
            note = self.ask("Receiving discrepancy", "Document observed issue and evidence")
            new_id = receiving_discrepancies.open(self.actor, category, note=note,
                purchase_order_id=po_id or None, purchase_order_line_id=line_id or None,
                receipt_id=receipt_id or None, expected_quantity=expected or None,
                observed_quantity=observed or None)
            QMessageBox.information(self, "Discrepancy recorded", new_id)

        def resolve_receiving_discrepancy(self):
            open_rows = [row for row in receiving_discrepancies.list(self.actor)
                         if row["status"] == "OPEN"]
            row = self.choose_item("Receiving discrepancy", "Choose open discrepancy",
                open_rows, lambda x: f"{x['type']} | {x['id'][:8]} | {x['note'][:65]}")
            reason = self.ask("Pharmacist discrepancy resolution",
                "Document investigation, corrective action and disposition")
            movement_id = self.ask("Stock correction evidence",
                "Existing MANUAL_ADJUST movement ID (optional; receipt linkage required)", "")
            receiving_discrepancies.resolve(self.actor, row["id"], reason,
                adjustment_movement_id=movement_id or None)

        def view_receiving_discrepancy_history(self):
            rows = receiving_discrepancies.list(self.actor)
            selected = self.choose_item("Receiving discrepancy history", "Choose record",
                rows, lambda x: f"{x['status']} | {x['type']} | {x['id'][:8]}")
            QMessageBox.information(self, "Append-only discrepancy events",
                json.dumps(receiving_discrepancies.history(self.actor, selected["id"]),
                           indent=2)[:16000])

        def view_inventory_exceptions(self):
            rows = stock_exceptions.list(self.actor)
            QMessageBox.information(self, "Persistent stock exception register",
                (json.dumps(rows, indent=2) if rows else "No saved inventory alerts")[:16000]
                + "\n\nAdvisory only; explicit refresh required.")

        def refresh_inventory_exceptions(self):
            result = stock_exceptions.refresh(self.actor)
            QMessageBox.information(self, "Inventory exceptions refreshed",
                json.dumps(result, indent=2))

        def choose_stock_exception(self, statuses=None):
            rows = [x for x in stock_exceptions.list(self.actor)
                    if statuses is None or x["status"] in statuses]
            return self.choose_item("Inventory exception", "Choose an alert", rows,
                lambda x: f"{x['severity']} | {x['status']} | {x['title'][:50]}")

        def acknowledge_inventory_exception(self):
            row = self.choose_stock_exception({"OPEN"})
            note = self.ask("Exception acknowledgement", "Document your review")
            stock_exceptions.acknowledge(self.actor, row["id"], note)

        def resolve_inventory_exception(self):
            row = self.choose_stock_exception({"OPEN", "ACKNOWLEDGED"})
            note = self.ask("Pharmacist exception resolution", "Document corrective action and outcome")
            stock_exceptions.resolve(self.actor, row["id"], note)

        def inventory_exception_history(self):
            row = self.choose_stock_exception()
            QMessageBox.information(self, "Append-only inventory exception events",
                json.dumps(stock_exceptions.history(self.actor, row["id"]),
                           indent=2)[:16000])

        def inventory_asof_balance(self):
            stock_id = self.choose_stock()
            at = self.ask("Historical lot balance", "As-of ISO8601 timestamp with offset (blank = now)", "")
            result = inventory_history.as_of(self.actor, stock_id, at or None)
            QMessageBox.information(self, "Read-only historical stock projection",
                json.dumps(result, indent=2))

        def view_inventory_demands(self):
            rows = inventory_demands.list(self.actor)
            QMessageBox.information(self, "Inventory demand / backorder queue",
                (json.dumps(rows, indent=2) or "No open inventory demands")[:16000]
                + "\n\nREADY = forecast only, not reserved units.")

        def create_inventory_demand(self):
            with service.sessions() as s:
                drugs = s.scalars(select(Drug).order_by(Drug.name)).all()
                items = [(x.id, x.name, x.strength) for x in drugs]
            selected = self.choose_item("Drug demand", "Choose inventory drug", items,
                lambda d: f"{d[1]} {d[2]} [{d[0][:8]}]")
            source = self.choose_item("Demand source", "Choose synthetic demand",
                ["MANUAL", "REORDER"], lambda x: x)
            quantity = self.ask("Inventory demand", "Physical unit quantity needed")
            note = self.ask("Inventory demand", "Document why the stock is needed")
            due = self.ask("Inventory demand", "Needed-by date YYYY-MM-DD (optional)", "")
            row_id = inventory_demands.create_manual(self.actor, selected[0], quantity,
                source=source, needed_by=due or None, note=note)
            QMessageBox.information(self, "Demand created", f"Advisory demand {row_id} recorded.")

        def reconcile_inventory_demands(self):
            with service.sessions() as s:
                drugs = s.scalars(select(Drug).order_by(Drug.name)).all()
                items = [(x.id, x.name, x.strength) for x in drugs]
            selected = self.choose_item("Reconcile demand", "Choose drug", items,
                lambda x: f"{x[1]} {x[2]}")
            result = inventory_demands.reconcile(self.actor, selected[0])
            QMessageBox.information(self, "Advisory stock reconciliation",
                json.dumps(result, indent=2))

        def cancel_inventory_demand(self):
            rows = [d for d in inventory_demands.list(self.actor)
                    if d["source"] in ("MANUAL", "REORDER")
                    and d["status"] in ("OPEN", "READY")]
            chosen = self.choose_item("Demand queue", "Choose demand to cancel", rows,
                lambda x: f"{x['source']} | {x['required_quantity']} | {x['drug_id'][:8]}")
            reason = self.ask("Demand cancellation", "Document cancellation reason")
            inventory_demands.cancel(self.actor, chosen["id"], reason)

        def view_inventory_demand_history(self):
            rows = inventory_demands.list(self.actor)
            chosen = self.choose_item("Demand history", "Select demand", rows,
                lambda x: f"{x['source']} | {x['status']} | {x['drug_id'][:8]}")
            QMessageBox.information(self, "Immutable demand events",
                json.dumps(inventory_demands.history(self.actor, chosen["id"]),
                           indent=2)[:16000])

        def show_fill_allocations(self):
            fill_id = self.ask("Physical pick history", "Fill ID")
            events = inventory_allocations.for_fill(self.actor, fill_id)
            QMessageBox.information(self, "Fill / physical location allocation history",
                json.dumps(events, indent=2)[:12000]
                if events else "No tracked physical allocations for this fill.")

        def view_fefo_policies(self):
            policies = fefo_policies.list(self.actor)
            QMessageBox.information(self, "Site FEFO policy register",
                (json.dumps(policies, indent=2) if policies else
                 "No FEFO policies configured. Existing scans remain unregulated by FEFO.")[:12000])

        def configure_fefo_policy(self):
            with service.sessions() as session:
                products = session.scalars(select(Product).where(
                    Product.active.is_(True)).order_by(Product.ndc)).all()
                choices = [(product.id, product.ndc, product.description)
                           for product in products]
            selected = self.choose_item("FEFO configuration", "Choose NDC", choices,
                lambda x: f"{x[1]} – {x[2]}")
            mode = self.choose_item("FEFO mode", "Select behavior",
                ["ADVISORY", "ENFORCE"], lambda x: x)
            shelf_days = int(self.ask("FEFO shelf life", "Minimum whole days remaining", "0"))
            note = self.ask("FEFO policy", "Document pharmacy policy decision")
            policy_id = fefo_policies.configure(self.actor, selected[0], mode, shelf_days, note)
            QMessageBox.information(self, "Site FEFO policy", f"Policy saved: {policy_id}")

        def show_fefo_advisory(self):
            with service.sessions() as session:
                records = session.scalars(select(Product).order_by(Product.ndc)).all()
                items = [(p.id, p.ndc, p.description) for p in records]
            item = self.choose_item("FEFO advisory", "Choose NDC", items,
                lambda row: f"{row[1]} – {row[2]}")
            days = int(self.ask("FEFO advisory", "Minimum remaining shelf life, days", "0"))
            rows = inventory_locations.fefo_recommendations(self.actor, item[0],
                minimum_shelf_life_days=days)
            QMessageBox.information(self, "Read-only FEFO suggestions",
                json.dumps(rows, indent=2)[:12000] + "\n\nAdvisory only — not an allocated pick.")

        def stock_ledger(self):
            movements = inventory_service.ledger(self.actor, self.selected_id())
            details = "\n".join(f"{m['kind']}: on-hand {m['on_hand_delta']}, reserved {m['reserved_delta']}, held {m['quarantined_delta']}" for m in movements)
            QMessageBox.information(self, "Synthetic stock ledger", details or "No movements")

        def choose_item(self, title, prompt, rows, label):
            if not rows:
                raise ValueError(f"No {title.lower()} records available")
            names = [label(item) for item in rows]
            value, ok = QInputDialog.getItem(self, title, prompt, names, 0, False)
            if not ok:
                raise ValueError("Selection cancelled")
            return rows[names.index(value)]

        def choose_stock(self):
            with service.sessions() as session:
                stocks = session.scalars(select(Stock).where(Stock.site_id == self.actor.site_id)).all()
                options = [(st.id, session.get(Product, st.product_id).ndc,
                            st.lot, str(st.on_hand - st.reserved - st.quarantined)) for st in stocks]
            return self.choose_item("Stock", "Select lot", options,
                lambda x: f"{x[1]}  lot {x[2]}  available {x[3]}  [{x[0][:8]}]")[0]

        def manage_replenishment(self):
            """Advisory-only supply planning; no automatic purchase orders."""
            action = self.choose_item("Replenishment", "Action",
                ["Review recommendations", "Configure NDC threshold", "Disable NDC threshold"],
                lambda x: x)
            if action == "Review recommendations":
                rows = planning_service.recommendations(self.actor, include_all=True)
                lines = [
                    f"{x['ndc']} | {x['status']} | available {x['available']} | "
                    f"PO {x['open_orders']} | incoming {x['incoming_transfers']} | "
                    f"projected {x['projected']} | suggested {x['suggested_quantity']}"
                    for x in rows
                ]
                QMessageBox.information(self, "Synthetic replenishment review",
                    "\n".join(lines) if lines else "No reorder thresholds configured for this pharmacy.")
                return
            ndc = self.ask("Replenishment", "NDC / product identifier")
            with service.sessions() as session:
                product = session.scalar(select(Product).where(Product.ndc == ndc))
                if product is None:
                    raise ValueError("NDC not found")
                product_id = product.id
            if action == "Configure NDC threshold":
                planning_service.configure(
                    self.actor, product_id,
                    self.ask("Replenishment", "Reorder minimum (e.g. 10)"),
                    self.ask("Replenishment", "Target on-hand (e.g. 50)"),
                    self.ask("Replenishment", "Document reason"))
            else:
                planning_service.disable(
                    self.actor, product_id,
                    self.ask("Replenishment", "Document reason for disabling"))

        def manage_po(self):
            op = self.choose_item("Purchase Orders", "Action", ['Create', 'Receive', 'Cancel'], lambda x: x)
            if op == 'Create':
                ndc = self.ask('New PO', 'NDC')
                with service.sessions() as session:
                    product = session.scalar(select(Product).where(Product.ndc == ndc))
                    if product is None:
                        raise ValueError('NDC not found')
                    pid = product.id
                advanced_service.create_purchase_order(self.actor,
                    self.ask('New PO', 'Vendor'), self.ask('New PO', 'PO number/reference'),
                    [{'product_id': pid, 'quantity': self.ask('New PO', 'Quantity ordered')}])
            elif op == 'Receive':
                lines = [line for po in advanced_service.purchase_orders(self.actor)
                         if po['status'] in ('OPEN','PARTIAL') for line in po['lines']
                         if Decimal(line['received']) < Decimal(line['ordered'])]
                line = self.choose_item('PO receipt', 'Unreceived order line', lines,
                    lambda x: f"{x['id'][:8]}  {x['product_id'][:8]}  {x['received']}/{x['ordered']}")
                advanced_service.receive_purchase_order(self.actor, line['id'],
                    self.ask('Receive PO', 'Lot number'), self.ask('Receive PO', 'Expiration YYYY-MM-DD'),
                    self.ask('Receive PO', 'Received quantity'), self.ask('Receive PO', 'Invoice reference'))
            else:
                orders = [p for p in advanced_service.purchase_orders(self.actor)
                          if p['status'] in ('OPEN','PARTIAL')]
                order = self.choose_item('Cancel PO', 'Order', orders,
                    lambda x: f"{x['reference']} - {x['vendor']}")
                advanced_service.cancel_purchase_order(self.actor, order['id'],
                    self.ask('Cancel PO', 'Reason'))

        def manage_transfer(self):
            action = self.choose_item('Transfers', 'Action', ['Ship', 'Receive', 'Cancel'], lambda x: x)
            if action == 'Ship':
                from .models import Site
                with service.sessions() as session:
                    options = [(x.id, x.name) for x in session.scalars(select(Site)).all()
                               if x.id != self.actor.site_id]
                dest = self.choose_item('Destination', 'Pharmacy location', options, lambda x: x[1])
                advanced_service.ship_transfer(self.actor, self.choose_stock(), dest[0],
                    self.ask('Transfer', 'Quantity'), self.ask('Transfer', 'Reason'))
            else:
                options = [x for x in advanced_service.transfers(self.actor)
                           if x['status'] == 'IN_TRANSIT' and
                           (x['to_site_id'] if action == 'Receive' else x['from_site_id']) == self.actor.site_id]
                transfer = self.choose_item('Transfers', 'In-transit shipment', options,
                    lambda x: f"{x['id'][:8]} - {x['quantity']}")
                if action == 'Receive':
                    advanced_service.receive_transfer(self.actor, transfer['id'])
                else:
                    advanced_service.cancel_transfer(self.actor, transfer['id'],
                        self.ask('Cancel transfer', 'Reason'))

        def manage_count(self):
            action = self.choose_item('Cycle Counts', 'Action',
                ['Create', 'Record quantity', 'Submit', 'Review'], lambda x: x)
            if action == 'Create':
                advanced_service.create_cycle_count(self.actor)
                return
            allowed = ('OPEN',) if action in ('Record quantity','Submit') else ('SUBMITTED',)
            sessions = [x for x in advanced_service.cycle_counts(self.actor)
                        if x['status'] in allowed]
            count = self.choose_item('Cycle Counts', 'Session', sessions,
                lambda x: f"{x['id'][:8]} - {x['status']} - {len(x['lines'])} lines")
            if action == 'Record quantity':
                advanced_service.record_count(self.actor, count['id'], self.choose_stock(),
                    self.ask('Cycle Count', 'Physically counted on-hand quantity'))
            elif action == 'Submit':
                advanced_service.submit_cycle_count(self.actor, count['id'])
            else:
                choice = self.choose_item('Cycle Count Review', 'Disposition',
                    ['Approve', 'Reject'], lambda x: x)
                advanced_service.review_cycle_count(self.actor, count['id'],
                    choice == 'Approve', self.ask('Review Count', 'Reason'))

        def manage_recall(self):
            action = self.choose_item('Recalls', 'Action', ['Open', 'Close'], lambda x: x)
            if action == 'Open':
                ndc = self.ask('Open Recall', 'Affected NDC')
                with service.sessions() as session:
                    product = session.scalar(select(Product).where(Product.ndc == ndc))
                    if product is None:
                        raise ValueError('NDC not found')
                    pid = product.id
                scope = self.choose_item('Recall scope', 'Scope', ['Entire NDC', 'Specific lot'], lambda x: x)
                lot = self.ask('Recall', 'Lot') if scope == 'Specific lot' else None
                advanced_service.open_recall(self.actor, pid, self.ask('Recall', 'Recall reference'),
                    self.ask('Recall', 'Reason'), lot)
            else:
                recalls = [r for r in advanced_service.recalls(self.actor) if r['status'] == 'ACTIVE']
                recall = self.choose_item('Close Recall', 'Recall', recalls,
                    lambda x: f"{x['reference']} - {x['lot'] or 'all lots'}")
                advanced_service.close_recall(self.actor, recall['id'],
                    self.ask('Close Recall', 'Closure documentation'))

        def document_window(self):
            rx_id = self.selected_id()
            # Real Qt dialog and graphics canvas; no browser, JavaScript or API proxy.
            class SourceCanvas(QGraphicsView):
                def __init__(self):
                    super().__init__()
                    self.setScene(QGraphicsScene(self))
                    self.rectangle = None
                    self._start = None
                    self._bounds = QRectF()
                    self._preview = None

                def load_source(self, data, mime):
                    self.scene().clear()
                    self.rectangle = None
                    self._start = None
                    image = QImage.fromData(data)
                    if image.isNull() and mime == "image/svg+xml":
                        try:
                            from PySide6.QtSvg import QSvgRenderer
                            from PySide6.QtCore import QByteArray
                            renderer = QSvgRenderer(QByteArray(data))
                            if renderer.isValid():
                                image = QImage(900, 900, QImage.Format.Format_ARGB32)
                                image.fill(Qt.GlobalColor.white)
                                painter = QPainter(image)
                                renderer.render(painter)
                                painter.end()
                        except ImportError:
                            pass
                    if image.isNull():
                        self._bounds = QRectF()
                        self.scene().addText("Preview unavailable for this document format. Source is preserved in the vault.")
                        return
                    pixmap = QPixmap.fromImage(image)
                    self.scene().addPixmap(pixmap)
                    self._bounds = QRectF(pixmap.rect())
                    self.setSceneRect(self._bounds)
                    self.fitInView(self._bounds, Qt.AspectRatioMode.KeepAspectRatio)

                def mousePressEvent(self, event):
                    if event.button() == Qt.MouseButton.LeftButton and not self._bounds.isEmpty():
                        self._start = self.mapToScene(event.position().toPoint())
                    super().mousePressEvent(event)

                def mouseReleaseEvent(self, event):
                    if self._start is not None and not self._bounds.isEmpty():
                        end = self.mapToScene(event.position().toPoint())
                        rectangle = QRectF(self._start, end).normalized().intersected(self._bounds)
                        if self._preview is not None:
                            self.scene().removeItem(self._preview)
                            self._preview = None
                        if rectangle.width() > 0 and rectangle.height() > 0:
                            self.rectangle = (str(rectangle.left() / self._bounds.width()),
                                str(rectangle.top() / self._bounds.height()),
                                str(rectangle.width() / self._bounds.width()),
                                str(rectangle.height() / self._bounds.height()))
                            self._preview = self.scene().addRect(rectangle, QPen(QColor("#245f96")), QBrush(QColor("#ffffff")))
                        self._start = None
                    super().mouseReleaseEvent(event)

            dialog = QDialog(self)
            dialog.setWindowTitle("Prescription source & change provenance — SYNTHETIC")
            dialog.resize(920, 700)
            layout = QVBoxLayout(dialog)
            sources = QComboBox()
            canvas = SourceCanvas()
            layout.addWidget(QLabel("Choose source, then drag a rectangle over the original to add a visual note."))
            layout.addWidget(sources)
            layout.addWidget(canvas, 1)
            actions = QHBoxLayout()
            upload_btn = QPushButton("Upload immutable original")
            render_btn = QPushButton("Generate synthetic eRx visual")
            annotate_btn = QPushButton("Save text box + provenance")
            history_btn = QPushButton("Show version history")
            apply_btn = QPushButton("Pharmacist: apply documented change")
            actions.addWidget(upload_btn); actions.addWidget(render_btn)
            actions.addWidget(annotate_btn); actions.addWidget(history_btn)
            actions.addWidget(apply_btn)
            layout.addLayout(actions)
            def populate():
                sources.clear()
                for entry in document_service.list_sources(self.actor, rx_id):
                    sources.addItem(f"{entry['source_type']} — {entry['original_filename'] or entry['id'][:8]}", entry["id"])
            def show_source():
                ident = sources.currentData()
                if ident:
                    data, mime = document_service.read_source(self.actor, ident)
                    canvas.load_source(data, mime)
            def upload():
                name, _ = QFileDialog.getOpenFileName(dialog, "Select synthetic source file", "",
                            "Prescription files (*.png *.jpg *.jpeg *.webp *.tif *.tiff *.pdf)")
                if not name:
                    return
                ext = Path(name).suffix.lower()
                mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                        ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff", ".pdf": "application/pdf"}[ext]
                document_service.create_source(self.actor, rx_id, Path(name).read_bytes(), mime,
                                               "UPLOAD", Path(name).name)
                populate()
            def render():
                document_service.render_erx(self.actor, rx_id, self.ask("Synthetic eRx", "Message reference"))
                populate()
            def annotate():
                if not sources.currentData() or canvas.rectangle is None:
                    raise ValueError("Choose a previewable source and drag an annotation rectangle first")
                text = self.ask("Visual annotation", "Visible text for opaque box")
                kind, ok = QInputDialog.getItem(dialog, "Change type", "Type",
                         ["OTHER", "SIG", "QUANTITY", "REFILLS", "DRUG", "STRENGTH", "DOSAGE_FORM", "DAW", "PRESCRIBER", "WRITTEN_DATE"], 0, False)
                if not ok:
                    return
                what = self.ask("Provenance", "What changed? (separate from visible text)")
                why = self.ask("Provenance", "Why was the change made?")
                communication, ok = QInputDialog.getItem(dialog, "Communication", "Method",
                                ["PHONE", "FAX", "ELECTRONIC", "IN_PERSON", "OTHER"], 0, False)
                if not ok:
                    return
                contact = self.ask("Provenance", "Who was contacted?", "Synthetic office")
                authorizer = self.ask("Provenance", "Authorizing prescriber", "Synthetic prescriber")
                change = dict(change_type=kind, what_changed=what, reason=why,
                              communication_method=communication, contacted_party=contact,
                              authorizing_prescriber=authorizer)
                document_service.annotate(self.actor, sources.currentData(), text, *canvas.rectangle, change)
                QMessageBox.information(dialog, "Saved", "Opaque visual box and separate provenance saved. Source unchanged.")
                show_source()
            def history():
                if not sources.currentData():
                    return
                rows = document_service.list_annotations(self.actor, sources.currentData())
                lines = [f"{a['status']} {a['id'][:8]}: {a['text']} — {a['change']['what_changed']} — {a['change']['reason']}" for a in rows]
                QMessageBox.information(dialog, "Annotation provenance history", "\n".join(lines) or "None")
            def apply_change():
                with service.sessions() as session:
                    rx = service._site(session, Prescription, rx_id, self.actor)
                    version = rx.version
                    candidates = session.scalars(select(DocumentChange).where(
                        DocumentChange.site_id == self.actor.site_id,
                        DocumentChange.prescription_id == rx_id,
                        DocumentChange.status == "ACTIVE")).all()
                    applied = {x["change_record_id"] for x in structured_changes.history(self.actor, rx_id)}
                    candidates = [x for x in candidates
                                  if x.change_type in StructuredChangeService.FIELDS and x.id not in applied]
                    labels = [f"{x.change_type} — {x.what_changed[:55]} ({x.id[:8]})"
                              for x in candidates]
                if not labels:
                    raise ValueError("No unapplied, active, supported structured changes on this prescription")
                label, ok = QInputDialog.getItem(dialog, "Documented change", "Select provenance record",
                                                labels, 0, False)
                if not ok:
                    return
                record = candidates[labels.index(label)]
                entered_value = self.ask("Structured Rx change", f"New {record.change_type} value (IDs for drug/prescriber)")
                if record.change_type == "REFILLS":
                    entered_value = int(entered_value)
                note = self.ask("Pharmacist approval", "Describe authorization you independently verified")
                confirmation = QMessageBox.question(dialog, "Apply synthetic change",
                    f"Apply {record.change_type} change to structured Rx version {version}? "
                    "This is NOT a verified prescriber signature.")
                if confirmation != QMessageBox.StandardButton.Yes:
                    return
                result = structured_changes.apply(self.actor, record.id, entered_value,
                                                  note, expected_version=version)
                QMessageBox.information(dialog, "Structured change recorded",
                                        json.dumps(result, indent=2))
            def guard(fn):
                def call(*_):
                    try:
                        fn()
                    except Exception as exc:
                        QMessageBox.warning(dialog, "Document action blocked", str(exc))
                return call
            sources.currentIndexChanged.connect(guard(show_source))
            upload_btn.clicked.connect(guard(upload))
            render_btn.clicked.connect(guard(render))
            annotate_btn.clicked.connect(guard(annotate))
            history_btn.clicked.connect(guard(history))
            apply_btn.clicked.connect(guard(apply_change))
            populate()
            dialog.exec()

        def new_rx(self):
            with service.sessions() as s:
                patients = s.scalars(select(Patient).where(Patient.site_id == self.actor.site_id)).all()
                providers = s.scalars(select(Prescriber).where(Prescriber.site_id == self.actor.site_id)).all()
                drugs = s.scalars(select(Drug)).all()
                if not patients or not providers or not drugs:
                    raise ValueError("Register at least one patient, provider and drug first")
                def choose(title, items, labeler):
                    labels = [labeler(x) for x in items]
                    selection, ok = QInputDialog.getItem(self, title, title, labels, 0, False)
                    if not ok:
                        raise ValueError("Cancelled")
                    return items[labels.index(selection)].id
                pid = choose("Patient", patients, lambda p: f"{p.last_name}, {p.first_name} ({p.id[:8]})")
                did = choose("Provider", providers, lambda p: f"{p.last_name}, {p.first_name} ({p.id[:8]})")
                drug = choose("Drug", drugs, lambda p: f"{p.name} {p.strength} ({p.id[:8]})")
            source = self.choose_item("Prescription source", "Select documented source", [
                "MANUAL", "PAPER", "FAX", "ELECTRONIC", "VERBAL", "TRANSFER"
            ], lambda x: x)
            directive = self.choose_item("Product selection", "Choose prescribed product rule", [
                "UNSPECIFIED", "SELECTION_PERMITTED", "DISPENSE_AS_WRITTEN"
            ], lambda x: x)
            selected_product = None
            if directive == "DISPENSE_AS_WRITTEN":
                with service.sessions() as s:
                    options = s.scalars(select(Product).where(
                        Product.drug_id == drug, Product.active.is_(True)
                    ).order_by(Product.ndc)).all()
                    selected_product = self.choose_item("Dispense as written", "Select exact prescribed NDC",
                        options, lambda p: f"{p.ndc} | {p.description}") .id
            written = self.ask("Prescription source", "Written date YYYY-MM-DD (optional)", "")
            erx_id = (self.ask("Synthetic electronic source", "Message reference (optional)", "")
                      if source == "ELECTRONIC" else "")
            service.add_prescription(self.actor, pid, did, drug, self.ask("Rx", "Rx number"),
                                     self.ask("Rx", "SIG"), self.ask("Rx", "Quantity"),
                                     int(self.ask("Rx", "Refills", "0")),
                                     source_type=source, written_date=written or None,
                                     electronic_message_id=erx_id or None,
                                     product_selection_directive=directive,
                                     prescribed_product_id=selected_product)

    window = Window()
    window.show()
    app.exec()


if __name__ == "__main__":
    main()
