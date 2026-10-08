"""Native Qt workstation. Runs Python services in-process; no browser/Chromium.

Install the optional 'desktop' dependency and opt in to synthetic demo mode.
The GUI is an early rewrite workbench, not feature-parity with React yet.
"""
from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import select

from .models import Claim, Drug, DUR, Fill, Patient, Prescriber, Product, Staff, Stock, WillCall
from .service import Actor, PharmacyService


VIEWS = [
    "Dashboard", "Exceptions", "Will Call", "New Prescription", "Patients",
    "Providers", "Drug / Product", "Receiving", "Inventory", "Third Party",
]


def main() -> None:
    if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise SystemExit("Native workstation disabled by default. Set PHARMACY1OS_SYNTHETIC_DEMO=1 for synthetic data.")
    try:
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QKeySequence, QShortcut
        from PySide6.QtWidgets import (
            QApplication, QComboBox, QFormLayout, QHBoxLayout, QInputDialog,
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
            self.search.setVisible(page == 0)
            if page == 0:
                self.action("Advance → DUR", self.advance)
                self.action("Start Fill", self.start_fill)
                self.action("Scan Product Source", self.scan)
                self.action("Prepare Labels / Sandbox COB", self.prepare)
                self.action("Pharmacist Verify", self.verify)
                self.action("Stage Will Call", self.stage)
                self.action("Sell / Pickup", self.sell)
                self.action("Return To Stock", self.return_stock)
            elif page == 3:
                self.action("Enter New Prescription", self.new_rx)
            elif page == 4:
                self.action("Register Patient", self.add_patient)
            elif page == 5:
                self.action("Register Provider", self.add_provider)
            elif page == 6:
                self.action("Add Drug", self.add_drug)
                self.action("Add Product / NDC", self.add_product)
                self.action("Register Barcode", self.register_barcode)
            elif page == 7:
                self.action("Receive Scanned Product", self.receive)
            self.action("Refresh", self.refresh)
            self.refresh()

        def refresh(self):
            self.rows = []
            page = self.selected_view
            if page == 0:
                headers = ["Rx", "Patient", "Drug", "Workflow"]
                self.rows = [(x["id"], x["rx_number"], x["patient"], x["drug"], x["status"])
                             for x in service.queue(self.actor, self.search.text())]
            else:
                with service.sessions() as s:
                    if page == 1:
                        headers = ["Severity", "Code", "Resolved"]
                        self.rows = [(x.id, x.severity, x.code, str(x.resolved))
                                     for x in s.scalars(select(DUR)).all()]
                    elif page == 2:
                        headers = ["Bag", "Bin", "Status"]
                        self.rows = [(x.id, x.bag_barcode, x.bin_name, x.status)
                                     for x in s.scalars(select(WillCall)).all()]
                    elif page == 3:
                        headers = ["Rx number", "Patient", "Status"]
                        self.rows = [(x["id"], x["rx_number"], x["patient"], x["status"])
                                     for x in service.queue(self.actor)]
                    elif page == 4:
                        headers = ["Last", "First", "DOB", "Phone"]
                        self.rows = [(x.id, x.last_name, x.first_name, x.date_of_birth or "", x.phone or "")
                                     for x in s.scalars(select(Patient).where(Patient.site_id == self.actor.site_id)).all()]
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
                                     for x in s.scalars(select(Claim)).all()]
            self.table.setColumnCount(len(headers))
            self.table.setHorizontalHeaderLabels(headers)
            self.table.setRowCount(len(self.rows))
            for i, row in enumerate(self.rows):
                for j, value in enumerate(row[1:]):
                    self.table.setItem(i, j, QTableWidgetItem(str(value)))
            self.table.resizeColumnsToContents()
            self.message.setText(f"{len(self.rows)} records · {self.actor.role} · development")

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
