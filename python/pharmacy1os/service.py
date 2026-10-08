"""Synthetic dispensing domain, independent of HTTP or desktop widgets.

All business operations are transactional; role/site boundaries are rechecked in
this layer. This is NOT a clinically or regulatorily validated dispensing engine.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import create_engine, event, select, text
from sqlalchemy.pool import StaticPool
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from .models import (
    Audit, Barcode, Base, Claim, Drug, DUR, Fill, FillSource, Label,
    Patient, Prescriber, Prescription, Product, Sale, Site, Staff, Stock, WillCall,
)


class WorkflowError(ValueError):
    pass


class AccessDenied(PermissionError):
    pass


PERMISSIONS = {
    "ADMIN": {"entry", "process", "verify", "sell", "inventory", "correct", "clinical", "read"},
    "PHARMACIST": {"entry", "process", "verify", "sell", "inventory", "correct", "clinical", "read"},
    "TECHNICIAN": {"entry", "process", "sell", "inventory", "read"},
    "INTERN": {"entry", "process", "read"},
    "CASHIER": {"sell", "read"},
    "AUDITOR": {"read"},
}

TRANSITIONS: dict[str, set[str]] = {
    "RECEIVED": {"DATA_ENTRY", "ON_HOLD", "CANCELLED", "TRANSFERRED"},
    "DATA_ENTRY": {"DUR_REVIEW", "ON_HOLD", "CANCELLED", "TRANSFERRED"},
    "DUR_REVIEW": {"ON_HOLD", "CANCELLED", "TRANSFERRED"},
    "PRODUCT_FILL": {"PHARMACIST_REVIEW", "ON_HOLD", "CANCELLED"},
    "PHARMACIST_REVIEW": {"READY", "PRODUCT_FILL", "ON_HOLD", "CANCELLED"},
    "READY": {"SOLD", "ON_HOLD", "CANCELLED"},
    "SOLD": {"DUR_REVIEW", "ON_HOLD", "CANCELLED", "TRANSFERRED"},
    "CANCELLED": set(), "TRANSFERRED": set(),
}


def positive(value: str | int | Decimal) -> Decimal:
    try:
        v = Decimal(str(value))
    except (InvalidOperation, TypeError) as exc:
        raise WorkflowError("Quantity must be a valid decimal") from exc
    if not v.is_finite() or v <= 0 or v.as_tuple().exponent < -3:
        raise WorkflowError("Quantity must be positive with at most three decimals")
    return v


@dataclass(frozen=True)
class Actor:
    id: str
    site_id: str
    role: str


class PharmacyService:
    def __init__(self, database_url: str = "sqlite+pysqlite:///:memory:"):
        options = ({"connect_args": {"check_same_thread": False}, "poolclass": StaticPool}
                   if database_url.endswith(":memory:") else {})
        self.engine = create_engine(database_url, future=True, **options)
        if database_url.startswith("sqlite"):
            @event.listens_for(self.engine, "connect")
            def enable_sqlite_constraints(connection, _record):
                cursor = connection.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)

    def create_schema(self) -> None:
        """Create isolated synthetic tables; upgrade one known SQLite demo column.

        This is NOT a migration of the legacy Prisma/PostgreSQL schema. The
        production design must use reviewed Alembic migrations instead.
        """
        from . import scheduling_models, billing_models, willcall  # noqa: F401 -- register extension tables
        Base.metadata.create_all(self.engine)
        if self.engine.dialect.name == "sqlite":
            with self.engine.begin() as conn:
                columns = {row[1] for row in conn.exec_driver_sql(
                    "PRAGMA table_info('py_inventory_holds')").all()}
                if "recall_id" not in columns:
                    conn.exec_driver_sql("ALTER TABLE py_inventory_holds "
                        "ADD COLUMN recall_id VARCHAR(36) REFERENCES py_recall_cases(id)")
                    conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS "
                        "ix_py_inventory_holds_recall_id ON py_inventory_holds (recall_id)")

    def bootstrap_demo(self) -> dict[str, Any]:
        """Create a synthetic pharmacy and demo actors; never production identities."""
        with self.sessions.begin() as s:
            site = Site(name="Synthetic Development Pharmacy")
            s.add(site)
            s.flush()
            actors: dict[str, Actor] = {}
            for role in ("PHARMACIST", "TECHNICIAN", "INTERN", "CASHIER", "AUDITOR"):
                user = Staff(site_id=site.id, name=f"Demo {role.title()}", role=role)
                s.add(user)
                s.flush()
                actors[role] = Actor(user.id, site.id, role)
            return {"site_id": site.id, "actors": actors}

    @staticmethod
    def _authorized(s: Session, actor: Actor, permission: str) -> Staff:
        staff = s.get(Staff, actor.id)
        if (staff is None or not staff.active or staff.site_id != actor.site_id
                or staff.role != actor.role or permission not in PERMISSIONS.get(staff.role, set())):
            raise AccessDenied("Permission denied or synthetic identity invalid")
        return staff

    @staticmethod
    def _site(s: Session, model: type, id: str, actor: Actor):
        obj = s.get(model, id)
        if obj is None or obj.site_id != actor.site_id:
            raise WorkflowError("Record not found at actor's pharmacy site")
        return obj

    @staticmethod
    def _audit(s: Session, actor: Actor, kind: str, subject: str, detail: dict[str, Any]):
        s.add(Audit(site_id=actor.site_id, actor_id=actor.id, kind=kind,
                    subject_id=subject, detail=json.dumps(detail, sort_keys=True, default=str)))

    def add_patient(self, actor: Actor, first: str, last: str, dob: str | None = None,
                    phone: str | None = None) -> str:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "entry")
            p = Patient(site_id=actor.site_id, first_name=first.strip(), last_name=last.strip(),
                        date_of_birth=dob, phone=phone)
            if not p.first_name or not p.last_name:
                raise WorkflowError("Patient first and last names are required")
            s.add(p); s.flush()
            self._audit(s, actor, "PATIENT_CREATED", p.id, {})
            return p.id

    def add_prescriber(self, actor: Actor, first: str, last: str, level: str, npi: str | None = None) -> str:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "entry")
            if not all((first.strip(), last.strip(), level.strip())):
                raise WorkflowError("Prescriber name and practice level required")
            p = Prescriber(site_id=actor.site_id, first_name=first.strip(), last_name=last.strip(),
                           practice_level=level.strip(), npi=npi)
            s.add(p); s.flush()
            self._audit(s, actor, "PRESCRIBER_CREATED", p.id, {})
            return p.id

    def add_drug(self, actor: Actor, name: str, strength: str, dosage_form: str,
                 controlled: bool = False) -> str:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "correct")
            if not all((name.strip(), strength.strip(), dosage_form.strip())):
                raise WorkflowError("Drug name, strength, and form required")
            d = Drug(name=name.strip(), strength=strength.strip(), dosage_form=dosage_form.strip(),
                     controlled=controlled)
            s.add(d); s.flush()
            self._audit(s, actor, "DRUG_CREATED", d.id, {"controlled": controlled})
            return d.id

    def add_product(self, actor: Actor, drug_id: str, ndc: str, manufacturer: str,
                    description: str, price: str = "0") -> str:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "correct")
            if not s.get(Drug, drug_id):
                raise WorkflowError("Drug not found")
            if not ndc or not manufacturer or not description:
                raise WorkflowError("Product NDC, manufacturer and description required")
            p = Product(drug_id=drug_id, ndc=ndc, manufacturer=manufacturer,
                        description=description, unit_price=Decimal(price))
            s.add(p); s.flush()
            self._audit(s, actor, "PRODUCT_CREATED", p.id, {"ndc": ndc})
            return p.id

    def register_barcode(self, actor: Actor, product_id: str, barcode: str) -> str:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "inventory")
            if not s.get(Product, product_id) or not barcode.strip():
                raise WorkflowError("Product and barcode are required")
            b = Barcode(product_id=product_id, value=barcode.strip())
            s.add(b); s.flush()
            self._audit(s, actor, "BARCODE_REGISTERED", b.id, {"product_id": product_id})
            return b.id

    def correct_barcode(self, actor: Actor, barcode: str, corrected_product_id: str, reason: str) -> None:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "correct")
            b = s.scalar(select(Barcode).where(Barcode.value == barcode))
            if not b or not s.get(Product, corrected_product_id) or not reason.strip():
                raise WorkflowError("Barcode, corrected product and reason are required")
            previous = b.product_id
            b.product_id = corrected_product_id
            self._audit(s, actor, "BARCODE_CORRECTED", b.id,
                        {"old_product_id": previous, "new_product_id": corrected_product_id, "reason": reason})

    def receive(self, actor: Actor, barcode: str, lot: str, expires: str, quantity: str) -> str:
        qty = positive(quantity)
        with self.sessions.begin() as s:
            self._authorized(s, actor, "inventory")
            b = s.scalar(select(Barcode).where(Barcode.value == barcode))
            if not b:
                raise WorkflowError("Unknown barcode: register product first")
            if not lot.strip() or date.fromisoformat(expires) <= date.today():
                raise WorkflowError("Lot required; expired stock cannot be received as usable")
            stock = s.scalar(select(Stock).where(Stock.site_id == actor.site_id,
                Stock.product_id == b.product_id, Stock.lot == lot, Stock.expires == expires))
            if stock is None:
                stock = Stock(site_id=actor.site_id, product_id=b.product_id,
                              lot=lot, expires=expires, on_hand=Decimal("0"),
                              reserved=Decimal("0"), quarantined=Decimal("0"))
                s.add(stock)
            s.flush()
            from .inventory_ops import record_movement
            record_movement(s, actor, stock, "RECEIVE", on_hand=qty)
            from .inventory_advanced import quarantine_recalled_receipt
            quarantine_recalled_receipt(s, actor, stock, qty)
            self._audit(s, actor, "INVENTORY_RECEIVE", stock.id, {"quantity": str(qty)})
            return stock.id

    def add_prescription(self, actor: Actor, patient_id: str, prescriber_id: str, drug_id: str,
                         rx_number: str, sig: str, quantity: str, refills: int = 0,
                         expiration_date: str | None = None, do_not_fill_before: str | None = None) -> str:
        qty = positive(quantity)
        with self.sessions.begin() as s:
            self._authorized(s, actor, "entry")
            self._site(s, Patient, patient_id, actor)
            self._site(s, Prescriber, prescriber_id, actor)
            d = s.get(Drug, drug_id)
            if not d or not sig.strip() or not rx_number.strip() or refills < 0:
                raise WorkflowError("Drug, Rx number, SIG and valid refills required")
            if d.controlled:
                raise WorkflowError("Controlled substances are blocked until independently validated")
            rx = Prescription(site_id=actor.site_id, patient_id=patient_id,
                prescriber_id=prescriber_id, drug_id=drug_id, rx_number=rx_number,
                sig=sig, quantity=qty, refills_allowed=refills, status="DATA_ENTRY",
                expiration_date=expiration_date, do_not_fill_before=do_not_fill_before)
            s.add(rx); s.flush()
            self._audit(s, actor, "RX_CREATED", rx.id, {"rx_number": rx_number})
            return rx.id

    def advance_to_dur(self, actor: Actor, rx_id: str) -> None:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "process")
            rx = self._site(s, Prescription, rx_id, actor)
            if rx.status != "DATA_ENTRY":
                raise WorkflowError("Prescription must be at Data Entry")
            rx.status = "DUR_REVIEW"
            self._audit(s, actor, "RX_DUR_REVIEW", rx.id, {})

    def add_dur_issue(self, actor: Actor, rx_id: str, severity: str, code: str) -> str:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "clinical")
            self._site(s, Prescription, rx_id, actor)
            if severity not in {"HIGH", "MEDIUM", "LOW"} or not code:
                raise WorkflowError("DUR issue severity and code required")
            issue = DUR(prescription_id=rx_id, severity=severity, code=code)
            s.add(issue); s.flush()
            self._audit(s, actor, "DUR_ISSUE_ADDED", issue.id, {"rx_id": rx_id, "severity": severity})
            return issue.id

    def resolve_dur(self, actor: Actor, issue_id: str, note: str) -> None:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "clinical")
            issue = s.get(DUR, issue_id)
            if not issue or not note.strip():
                raise WorkflowError("Issue and meaningful resolution note required")
            self._site(s, Prescription, issue.prescription_id, actor)
            issue.resolved = True; issue.resolution = note.strip()
            self._audit(s, actor, "DUR_RESOLVED", issue.id, {"resolution": note.strip()})

    def _start_fill_tx(self, s: Session, actor: Actor, rx: Prescription,
                       dispense_quantity: str | None = None, *, effective_date: date | None = None,
                       scheduled_id: str | None = None) -> str:
        """Start a fill inside the caller's existing transaction (including scheduled starts)."""
        if rx.status != "DUR_REVIEW":
            raise WorkflowError("Prescription must pass Data Entry/DUR stage")
        today = (effective_date or date.today()).isoformat()
        if rx.expiration_date and rx.expiration_date < today:
            raise WorkflowError("Prescription expired")
        if rx.do_not_fill_before and rx.do_not_fill_before > today:
            raise WorkflowError("Do-not-fill-before date not reached")
        if s.scalar(select(DUR.id).where(DUR.prescription_id == rx.id,
                    DUR.severity == "HIGH", DUR.resolved.is_(False))):
            raise WorkflowError("Unresolved high-severity DUR issue")
        from .scheduling_models import ScheduledFill
        pending = s.scalar(select(ScheduledFill.id).where(
            ScheduledFill.prescription_id == rx.id, ScheduledFill.status == "PENDING"))
        if pending and pending != scheduled_id:
            raise WorkflowError("A pending future fill must be started through its scheduled action")
        active = s.scalars(select(Fill).where(Fill.prescription_id == rx.id)).all()
        if any(f.status in {"PRODUCT_FILL", "PHARMACIST_REVIEW", "READY"} for f in active):
            raise WorkflowError("A fill is already active")
        returned = next((f for f in sorted(active, key=lambda f: (f.fill_number, f.attempt), reverse=True)
                         if f.status == "RETURNED"), None)
        fillnum = returned.fill_number if returned else (max((f.fill_number for f in active), default=-1) + 1)
        if fillnum > rx.refills_allowed:
            raise WorkflowError("No refills remaining")
        attempt = returned.attempt + 1 if returned else 1
        qty = positive(dispense_quantity or rx.quantity)
        if qty > rx.quantity:
            raise WorkflowError("Cannot dispense more than authorized quantity")
        f = Fill(prescription_id=rx.id, fill_number=fillnum, attempt=attempt,
                 quantity=qty, billed_quantity=rx.quantity, status="PRODUCT_FILL")
        s.add(f)
        rx.status = "PRODUCT_FILL"
        s.flush()
        self._audit(s, actor, "FILL_STARTED", f.id,
                    {"fill_number": f.fill_number, "dispense_qty": str(qty),
                     "bill_qty": str(rx.quantity)})
        return f.id

    def start_fill(self, actor: Actor, rx_id: str, dispense_quantity: str | None = None) -> str:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "process")
            rx = self._site(s, Prescription, rx_id, actor)
            return self._start_fill_tx(s, actor, rx, dispense_quantity)

    def scan_source(self, actor: Actor, fill_id: str, barcode: str, lot: str,
                    expires: str, quantity: str) -> None:
        qty = positive(quantity)
        with self.sessions.begin() as s:
            self._authorized(s, actor, "process")
            f = s.get(Fill, fill_id)
            if not f:
                raise WorkflowError("Fill not found")
            rx = self._site(s, Prescription, f.prescription_id, actor)
            if f.status != "PRODUCT_FILL" or rx.status != "PRODUCT_FILL":
                raise WorkflowError("Fill is not at Product Fill")
            b = s.scalar(select(Barcode).where(Barcode.value == barcode))
            if not b:
                raise WorkflowError("Unregistered barcode")
            product = s.get(Product, b.product_id)
            if product is None or product.drug_id != rx.drug_id:
                raise WorkflowError("Scanned NDC does not belong to Data Entry drug")
            stock = s.scalar(select(Stock).where(Stock.site_id == actor.site_id,
                Stock.product_id == product.id, Stock.lot == lot, Stock.expires == expires))
            if not stock or stock.expires <= date.today().isoformat():
                raise WorkflowError("Lot/expiration mismatch or expired stock")
            from .inventory_advanced import assert_not_recalled
            assert_not_recalled(s, stock)
            sources = s.scalars(select(FillSource).where(FillSource.fill_id == f.id)).all()
            if len(sources) >= 4 or any(source.stock_id == stock.id for source in sources):
                raise WorkflowError("Maximum four distinct sources; duplicates rejected")
            if sum((source.quantity for source in sources), Decimal("0")) + qty > f.quantity:
                raise WorkflowError("Scanned quantity exceeds actual fill quantity")
            if stock.on_hand - stock.reserved - stock.quarantined < qty:
                raise WorkflowError("Insufficient available stock")
            from .inventory_ops import record_movement
            record_movement(s, actor, stock, "FILL_RESERVE", reserved=qty)
            s.add(FillSource(fill_id=f.id, stock_id=stock.id, quantity=qty))
            self._audit(s, actor, "PRODUCT_SOURCE_VERIFIED", f.id,
                        {"stock_id": stock.id, "quantity": str(qty), "ndc": product.ndc})

    def prepare_for_review(self, actor: Actor, fill_id: str, payer_names: list[str] | None = None) -> list[str]:
        """Sandbox claims and separate bottle-label records; no real payer transport."""
        with self.sessions.begin() as s:
            self._authorized(s, actor, "process")
            f = s.get(Fill, fill_id)
            if not f:
                raise WorkflowError("Fill not found")
            rx = self._site(s, Prescription, f.prescription_id, actor)
            if f.status != "PRODUCT_FILL":
                raise WorkflowError("Wrong fill state")
            sources = s.scalars(select(FillSource).where(FillSource.fill_id == f.id)).all()
            if not sources or sum((x.quantity for x in sources), Decimal("0")) != f.quantity:
                raise WorkflowError("Physical source quantities must match dispensed quantity")
            payers = payer_names or []
            if len(payers) > 4 or any(not name.strip() for name in payers):
                raise WorkflowError("Maximum four named COB payers")
            # Label ordering: largest physical source first.
            sorted_sources = sorted(sources, key=lambda x: (-x.quantity, x.stock_id))
            labels = []
            for index, src in enumerate(sorted_sources, start=1):
                stock = s.get(Stock, src.stock_id)
                prod = s.get(Product, stock.product_id)
                label = Label(fill_id=f.id, bottle_number=index,
                              bottle_count=len(sorted_sources), ndc=prod.ndc,
                              quantity=src.quantity, total=f.quantity,
                              description=prod.description)
                s.add(label)
                labels.append(f"{prod.ndc} {src.quantity}/{f.quantity} — Bottle {index} of {len(sorted_sources)}")
            for seq, payer in enumerate(payers, start=1):
                claim = Claim(fill_id=f.id, payer=payer, sequence=seq,
                              status="PAID_SYNTHETIC", billed_quantity=f.billed_quantity)
                s.add(claim)
                s.flush()
                from .billing import record_paid
                record_paid(s, actor, claim, sources)
            f.status = "PHARMACIST_REVIEW"; rx.status = "PHARMACIST_REVIEW"
            self._audit(s, actor, "FILL_PREPARED", f.id,
                        {"bottles": len(labels), "payers": payers, "mode": "SYNTHETIC_SANDBOX"})
            return labels

    def verify(self, actor: Actor, fill_id: str) -> None:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "verify")
            f = s.get(Fill, fill_id)
            if not f:
                raise WorkflowError("Fill not found")
            rx = self._site(s, Prescription, f.prescription_id, actor)
            if f.status != "PHARMACIST_REVIEW":
                raise WorkflowError("Fill not awaiting pharmacist review")
            if s.scalar(select(DUR.id).where(DUR.prescription_id == rx.id,
                        DUR.severity == "HIGH", DUR.resolved.is_(False))):
                raise WorkflowError("Unresolved high-severity DUR issue")
            sources = s.scalars(select(FillSource).where(FillSource.fill_id == f.id)).all()
            if not sources or sum((x.quantity for x in sources), Decimal("0")) != f.quantity:
                raise WorkflowError("Physical sources incomplete")
            for src in sources:
                stock = s.get(Stock, src.stock_id)
                if stock.expires <= date.today().isoformat() or stock.reserved < src.quantity:
                    raise WorkflowError("Source expired or reservation invalid")
                from .inventory_advanced import assert_not_recalled
                assert_not_recalled(s, stock)
                from .inventory_ops import record_movement
                record_movement(s, actor, stock, "FILL_DISPENSE",
                                on_hand=-src.quantity, reserved=-src.quantity)
            f.status = "READY"; rx.status = "READY"
            self._audit(s, actor, "PHARMACIST_VERIFIED", f.id, {"quantity": str(f.quantity)})

    def stage_will_call(self, actor: Actor, fill_id: str, bin_name: str, bag_barcode: str) -> None:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "process")
            f = s.get(Fill, fill_id)
            if not f:
                raise WorkflowError("Fill not found")
            self._site(s, Prescription, f.prescription_id, actor)
            if f.status != "READY" or not bin_name.strip() or not bag_barcode.strip():
                raise WorkflowError("Only a Ready fill can be staged with a bin and bag barcode")
            from .willcall import _barcode, _bin, record_stage
            normalized_barcode, normalized_bin = _barcode(bag_barcode), _bin(bin_name)
            if s.scalar(select(WillCall.id).where(WillCall.fill_id == f.id)):
                raise WorkflowError("Fill already has a Will Call package")
            record_stage(s, actor, f, normalized_barcode, normalized_bin)
            s.add(WillCall(fill_id=f.id, bag_barcode=normalized_barcode,
                           bin_name=normalized_bin, status="STAGED"))
            self._audit(s, actor, "WILL_CALL_STAGED", f.id,
                        {"bin": bin_name, "bag": bag_barcode})

    def sell(self, actor: Actor, fill_id: str, identity_verified: bool, signed: bool,
             amount: str, tender: str, scanned_bag: str | None = None) -> None:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "sell")
            f = s.get(Fill, fill_id)
            if not f:
                raise WorkflowError("Fill not found")
            rx = self._site(s, Prescription, f.prescription_id, actor)
            if f.status != "READY" or not identity_verified or not signed:
                raise WorkflowError("Ready fill, identity verification and signature required")
            from .inventory_advanced import assert_not_recalled
            for src in s.scalars(select(FillSource).where(FillSource.fill_id == f.id)).all():
                stock = s.get(Stock, src.stock_id)
                if stock is None or stock.site_id != actor.site_id or stock.expires <= date.today().isoformat():
                    raise WorkflowError("Ready fill stock was lost or expired")
                assert_not_recalled(s, stock)
            bag = s.scalar(select(WillCall).where(WillCall.fill_id == f.id))
            if bag and (bag.status != "STAGED" or scanned_bag != bag.bag_barcode):
                raise WorkflowError("Staged fill requires the correct bag barcode")
            try:
                money = Decimal(amount)
            except (InvalidOperation, TypeError) as exc:
                raise WorkflowError("Invalid patient amount") from exc
            if (not tender.strip() or not money.is_finite() or money < 0
                    or money.as_tuple().exponent < -2):
                raise WorkflowError("Tender and nonnegative amount in cents required")
            s.add(Sale(fill_id=f.id, verified_identity=True, signature_attested=True,
                       tender=tender, amount=Decimal(amount)))
            if bag:
                from .willcall import record_closed
                record_closed(s, actor, f, "SOLD", "Pickup completed with verified identity and signature")
                bag.status = "SOLD"
            f.status = "SOLD"; rx.status = "SOLD"
            if f.fill_number > 0:
                rx.refills_used = max(rx.refills_used, f.fill_number)
            self._audit(s, actor, "POS_SOLD", f.id, {"tender": tender, "amount": amount})

    def return_to_stock(self, actor: Actor, fill_id: str, reason: str) -> None:
        with self.sessions.begin() as s:
            self._authorized(s, actor, "correct")
            f = s.get(Fill, fill_id)
            if not f:
                raise WorkflowError("Fill not found")
            rx = self._site(s, Prescription, f.prescription_id, actor)
            if f.status != "READY" or not reason.strip():
                raise WorkflowError("Only unsold Ready fills can be returned, with a reason")
            for claim in s.scalars(select(Claim).where(Claim.fill_id == f.id)).all():
                if claim.status != "PAID_SYNTHETIC":
                    raise WorkflowError("Claim reversal precondition failed")
                from .billing import record_reversal
                record_reversal(s, actor, claim, reason)
                claim.status = "REVERSED_SYNTHETIC"
            for src in s.scalars(select(FillSource).where(FillSource.fill_id == f.id)).all():
                stock = s.get(Stock, src.stock_id)
                from .inventory_ops import record_movement
                record_movement(s, actor, stock, "RETURN_TO_STOCK", on_hand=src.quantity,
                                reason=reason.strip())
                from .inventory_advanced import quarantine_recalled_receipt
                quarantine_recalled_receipt(s, actor, stock, src.quantity)
            bag = s.scalar(select(WillCall).where(WillCall.fill_id == f.id))
            if bag:
                from .willcall import record_closed
                record_closed(s, actor, f, "RETURNED", reason)
                bag.status = "RETURNED"
            f.status = "RETURNED"; rx.status = "DUR_REVIEW"
            self._audit(s, actor, "FILL_RETURNED_TO_STOCK", f.id, {"reason": reason})

    def queue(self, actor: Actor, term: str = "") -> list[dict[str, Any]]:
        with self.sessions() as s:
            self._authorized(s, actor, "read")
            rows = s.scalars(select(Prescription).where(Prescription.site_id == actor.site_id)
                             .order_by(Prescription.rx_number)).all()
            results = []
            for rx in rows:
                p = s.get(Patient, rx.patient_id)
                d = s.get(Drug, rx.drug_id)
                name = f"{p.last_name}, {p.first_name}"
                if term.casefold() not in f"{rx.rx_number} {name} {d.name}".casefold():
                    continue
                results.append({"id": rx.id, "rx_number": rx.rx_number, "patient": name,
                                "drug": f"{d.name} {d.strength}", "status": rx.status})
            return results

    def audit_log(self, actor: Actor) -> list[dict[str, Any]]:
        with self.sessions() as s:
            self._authorized(s, actor, "read")
            return [{"kind": x.kind, "subject": x.subject_id, "detail": x.detail}
                    for x in s.scalars(select(Audit).where(Audit.site_id == actor.site_id)
                                       .order_by(Audit.created_at, Audit.id)).all()]
