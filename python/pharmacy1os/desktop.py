"""Native Qt workstation. Runs Python services in-process; no browser/Chromium.

Install the optional 'desktop' dependency and opt in to synthetic demo mode.
The GUI is an early rewrite workbench, not feature-parity with React yet.
"""
from __future__ import annotations

import os
from pathlib import Path
from decimal import Decimal

from .documents import DocumentService
from .inventory_ops import InventoryService
from .lifecycle import LifecycleService

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
    lifecycle_service = LifecycleService(service)
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
                self.action("Hold Rx", self.hold_rx)
                self.action("Resume Rx", self.resume_rx)
                self.action("Cancel Rx", self.cancel_rx)
                self.action("Rx Documents", self.document_window)
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
            elif page == 8:
                self.action("Quarantine", self.quarantine_stock)
                self.action("Resolve Hold", self.resolve_stock_hold)
                self.action("Adjust Stock", self.adjust_stock)
                self.action("Stock Ledger", self.stock_ledger)
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
