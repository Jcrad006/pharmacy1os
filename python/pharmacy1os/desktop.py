"""Native Qt workstation. Runs Python services in-process; no browser/Chromium.

Install the optional 'desktop' dependency and opt in to synthetic demo mode.
The GUI is an early rewrite workbench, not feature-parity with React yet.
"""
from __future__ import annotations

import os
import json
from pathlib import Path
from decimal import Decimal

from .documents import DocumentService
from .inventory_ops import InventoryService
from .inventory_advanced import AdvancedInventoryService
from .lifecycle import LifecycleService
from .provider_directory import ProviderDirectory
from .scheduling import SchedulingService
from .billing import BillingService
from .willcall import WillCallService
from .pos import PosService
from .patient_directory import PatientDirectory
from .exceptions import ExceptionService
from .communications import CommunicationService
from .date_rules import DateRulesService

from sqlalchemy import select

from .models import Claim, Drug, DUR, Fill, Patient, Prescriber, Prescription, Product, Staff, Stock, WillCall
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
    service = PharmacyService(f"sqlite+pysqlite:///{base / 'pharmacy1os.sqlite3'}")
    service.create_schema()
    document_service = DocumentService.from_demo_env(service)
    inventory_service = InventoryService(service)
    advanced_service = AdvancedInventoryService(service)
    lifecycle_service = LifecycleService(service)
    directory_service = ProviderDirectory(service)
    scheduling_service = SchedulingService(service)
    billing_service = BillingService(service)
    will_call_service = WillCallService(service)
    pos_service = PosService(service)
    patient_directory = PatientDirectory(service)
    exception_service = ExceptionService(service)
    communication_service = CommunicationService(service, document_service)
    date_rules_service = DateRulesService(service)
    with service.sessions() as session:
        users = session.scalars(select(Staff).order_by(Staff.name)).all()
    if not users:
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
            menu.addWidget(QLabel("Development identity (NOT authentication)"))
            self.actor_box = QComboBox()
            self.actors = {}
            with service.sessions() as s:
                for staff in s.scalars(select(Staff).order_by(Staff.role, Staff.name)).all():
                    self.actors[staff.id] = Actor(staff.id, staff.site_id, staff.role)
                    self.actor_box.addItem(f"{staff.name} — {staff.role}", staff.id)
            menu.addWidget(self.actor_box)
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
            return self.actors[self.actor_box.currentData()]

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
                self.action("Scan Product Source", self.scan)
                self.action("Prepare Labels / Sandbox COB", self.prepare)
                self.action("Pharmacist Verify", self.verify)
                self.action("Stage Will Call", self.stage)
                self.action("Sell / Pickup", self.sell)
                self.action("Return To Stock", self.return_stock)
                self.action("Hold Rx", self.hold_rx)
                self.action("Resume Rx", self.resume_rx)
                self.action("Cancel Rx", self.cancel_rx)
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
                self.action("Add Product / NDC", self.add_product)
                self.action("Register Barcode", self.register_barcode)
            elif page == 7:
                self.action("Receive Scanned Product", self.receive)
            elif page == 8:
                self.action("Quarantine", self.quarantine_stock)
                self.action("Resolve Hold", self.resolve_stock_hold)
                self.action("Adjust Stock", self.adjust_stock)
                self.action("Stock Ledger", self.stock_ledger)
            elif page == 9:
                self.action("New Payer Rule Version", self.configure_payer)
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

        def scan(self):
            fid = self.fill_for_rx(self.selected_id())
            barcode = self.ask("Product Fill", "Scan/enter registered barcode")
            lot = self.ask("Product Fill", "Lot number")
            exp = self.ask("Product Fill", "Expiration YYYY-MM-DD")
            qty = self.ask("Product Fill", "Quantity from this physical bottle")
            service.scan_source(self.actor, fid, barcode, lot, exp, qty)

        def prepare(self):
            fid = self.fill_for_rx(self.selected_id())
            payers = self.ask("Billing", "Comma-separated sandbox payers, or CASH", "CASH")
            names = [] if payers.upper() == "CASH" else [p.strip() for p in payers.split(",")]
            labels = service.prepare_for_review(self.actor, fid, names)
            QMessageBox.information(self, "Synthetic bottle labels", "\n".join(labels))

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
            actions.addWidget(upload_btn); actions.addWidget(render_btn)
            actions.addWidget(annotate_btn); actions.addWidget(history_btn)
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
            service.add_prescription(self.actor, pid, did, drug, self.ask("Rx", "Rx number"),
                                     self.ask("Rx", "SIG"), self.ask("Rx", "Quantity"),
                                     int(self.ask("Rx", "Refills", "0")))

    window = Window()
    window.show()
    app.exec()


if __name__ == "__main__":
    main()
