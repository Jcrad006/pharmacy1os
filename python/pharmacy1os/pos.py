"""Multi-fill *synthetic-only* POS, keeping physical dispensing separate from money.

- No real payments, claim adjudication, charge authorization, or pricing engine.
- No automatic inventory/Rx correction on refund/void: this requires clinical review.
- Database transaction + unique constraints protect against routine duplicate calls.
  SQLite is not a test of concurrent real-workstation correctness.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from .models import Claim, Fill, FillSource, Label, Patient, Prescription, Sale, Stock, WillCall
from .pos_models import PosFinancialEvent, PosLine, PosTender, PosTransaction
from .service import Actor, PharmacyService, WorkflowError

PAYMENTS = {"CASH", "CARD", "CHECK", "OTHER"}
IDENTITIES = {"DATE_OF_BIRTH", "ADDRESS", "GOVERNMENT_ID", "KNOWN_PATIENT", "OTHER"}
SIGNATURES = {"ELECTRONIC_TYPED", "EXTERNAL_DEVICE", "PAPER"}
MODES = {"WILL_CALL", "IMMEDIATE"}


def money(value: Any) -> Decimal:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError) as ex:
        raise WorkflowError("Invalid monetary amount") from ex
    if not amount.is_finite() or amount < 0 or amount.as_tuple().exponent < -2 or amount > Decimal("9999999999.99"):
        raise WorkflowError("Amount must be finite, nonnegative, and have at most 2 decimals")
    return amount.quantize(Decimal("0.01"))


def nonblank(value: str, label: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise WorkflowError(f"{label} is required and must not exceed {limit} characters")
    return value.strip()


def _financial_total(s, tx_id: str) -> Decimal:
    events = s.scalars(select(PosFinancialEvent).where(
        PosFinancialEvent.transaction_id == tx_id,
        PosFinancialEvent.kind == "REFUND_SIMULATED")).all()
    return sum((e.amount for e in events), Decimal("0.00"))


def _summary(s, tx: PosTransaction) -> dict[str, Any]:
    lines = s.scalars(select(PosLine).where(PosLine.transaction_id == tx.id).order_by(PosLine.fill_id)).all()
    tenders = s.scalars(select(PosTender).where(PosTender.transaction_id == tx.id).order_by(PosTender.sequence)).all()
    refunded = _financial_total(s, tx.id)
    return {"id": tx.id, "site_id": tx.site_id, "patient_id": tx.patient_id,
            "status": tx.status, "mode": tx.mode, "total": str(tx.subtotal),
            "refunded": str(refunded), "remaining": str(tx.subtotal - refunded),
            "lines": [{"fill_id": line.fill_id, "amount": str(line.amount),
                       "bag_barcode": line.scanned_bag} for line in lines],
            "tenders": [{"method": row.method, "amount": str(row.amount),
                         "reference": row.reference} for row in tenders],
            "recipient_name": tx.recipient_name, "identity_method": tx.identity_method,
            "signature_method": tx.signature_method,
            "warning": "SYNTHETIC_DEVELOPMENT_ONLY_NO_PAYMENT_PROCESSING"}


class PosService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def _qualified(self, s, actor: Actor, fill_id: str, mode: str, scanned_bags: dict[str, str]):
        # Lock parent rows on databases supporting row-level locks.
        f = s.scalar(select(Fill).where(Fill.id == fill_id).with_for_update())
        if f is None:
            raise WorkflowError("Fill not found")
        rx = self.service._site(s, Prescription, f.prescription_id, actor)
        if f.status != "READY" or rx.status != "READY":
            raise WorkflowError("Only pharmacist-verified Ready fills may be checked out")
        if s.scalar(select(Sale.id).where(Sale.fill_id == f.id)) or s.scalar(
                select(PosLine.id).where(PosLine.fill_id == f.id)):
            raise WorkflowError("Fill already sold in a previous checkout")
        if not s.scalar(select(Label.id).where(Label.fill_id == f.id)):
            raise WorkflowError("Dispensing labels must exist before checkout")
        sources = s.scalars(select(FillSource).where(FillSource.fill_id == f.id)).all()
        if not sources or sum((x.quantity for x in sources), Decimal("0")) != f.quantity:
            raise WorkflowError("Physical fill source quantities do not match")
        from .inventory_advanced import assert_not_recalled
        for src in sources:
            stock = s.get(Stock, src.stock_id)
            if stock is None or stock.site_id != actor.site_id or stock.expires <= date.today().isoformat():
                raise WorkflowError("Physical source expired, missing, or outside site")
            assert_not_recalled(s, stock)
        bag = s.scalar(select(WillCall).where(WillCall.fill_id == f.id).with_for_update())
        if mode == "WILL_CALL":
            if bag is None or bag.status != "STAGED" or scanned_bags.get(f.id) != bag.bag_barcode:
                raise WorkflowError("Staged Will Call requires a matching active bag scan")
            from .willcall import WillCallBarcodeRecord
            record = s.scalar(select(WillCallBarcodeRecord).where(
                WillCallBarcodeRecord.barcode == bag.bag_barcode))
            if record is None or record.status != "ACTIVE" or record.fill_id != f.id:
                raise WorkflowError("Will Call bag is retired or custody history is inconsistent")
        elif bag is not None:
            raise WorkflowError("Immediate pickup cannot bypass an existing Will Call bag")
        return f, rx, bag

    @staticmethod
    def _parse_lines(line_amounts: list[dict[str, str]]) -> list[tuple[str, Decimal]]:
        if not isinstance(line_amounts, list) or not 1 <= len(line_amounts) <= 20:
            raise WorkflowError("Checkout requires 1 to 20 fills")
        lines = []
        for row in line_amounts:
            if not isinstance(row, dict):
                raise WorkflowError("Invalid checkout line")
            fid = nonblank(row.get("fill_id"), "Fill ID", 36)
            lines.append((fid, money(row.get("amount"))))
        if len({row[0] for row in lines}) != len(lines):
            raise WorkflowError("Duplicate fill in checkout")
        return sorted(lines)

    @staticmethod
    def _parse_tenders(tenders: list[dict[str, str]]) -> list[tuple[str, Decimal, str]]:
        if not isinstance(tenders, list) or len(tenders) > 8:
            raise WorkflowError("Checkout accepts at most 8 synthetic tenders")
        results = []
        for tender in tenders:
            if not isinstance(tender, dict):
                raise WorkflowError("Invalid tender")
            method = str(tender.get("method", "")).upper()
            if method not in PAYMENTS:
                raise WorkflowError("Unsupported tender method")
            value = money(tender.get("amount"))
            if value <= 0:
                raise WorkflowError("Tender must be positive")
            ref = str(tender.get("reference") or "").strip()
            if len(ref) > 120:
                raise WorkflowError("Tender reference too long")
            results.append((method, value, ref))
        return results

    def checkout(self, actor: Actor, *, lines: list[dict[str, str]],
                 tenders: list[dict[str, str]], scanned_bags: dict[str, str],
                 recipient_name: str, identity_method: str, signature_method: str,
                 signature_attested: bool, idempotency_key: str,
                 relationship: str = "", mode: str = "WILL_CALL") -> dict[str, Any]:
        """Atomic multi-fill synthetic POS with strict single-patient checkout."""
        clean_lines = self._parse_lines(lines)
        clean_tenders = self._parse_tenders(tenders)
        idempotency_key = nonblank(idempotency_key, "Checkout request key", 120)
        recipient_name = nonblank(recipient_name, "Recipient name", 150)
        if not isinstance(relationship, str) or len(relationship) > 80:
            raise WorkflowError("Recipient relationship too long")
        if identity_method not in IDENTITIES or signature_method not in SIGNATURES or signature_attested is not True:
            raise WorkflowError("Valid identity method and signature attestation are required")
        if mode not in MODES:
            raise WorkflowError("Checkout mode invalid")
        bag_values = {fid: (str(scanned_bags.get(fid, "")).strip() if isinstance(scanned_bags, dict) else "")
                      for fid, _ in clean_lines}
        total = sum((value for _, value in clean_lines), Decimal("0.00"))
        tender_sum = sum((value for _, value, _ in clean_tenders), Decimal("0.00"))
        if tender_sum != total or (total > 0 and not clean_tenders) or (total == 0 and clean_tenders):
            raise WorkflowError("Tender amounts must exactly match checkout total (zero-cost checkout has no tenders)")
        fingerprint = {"lines": [(fid, str(amt)) for fid, amt in clean_lines],
                       "tenders": [(method, str(amt), ref) for method, amt, ref in clean_tenders],
                       "bags": bag_values, "recipient": recipient_name, "identity_method": identity_method,
                       "signature_method": signature_method, "signature_attested": True,
                       "relationship": relationship.strip(), "mode": mode}
        signature = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "sell")
            old = s.scalar(select(PosTransaction).where(PosTransaction.site_id == actor.site_id,
                           PosTransaction.idempotency_key == idempotency_key).with_for_update())
            if old:
                if old.request_hash != signature:
                    raise WorkflowError("Idempotency key reused for a different checkout")
                return _summary(s, old)
            selected = [(fid, amt, *self._qualified(s, actor, fid, mode, bag_values))
                        for fid, amt in clean_lines]
            patient_ids = {rx.patient_id for _, _, _f, rx, _bag in selected}
            if len(patient_ids) != 1:
                raise WorkflowError("A checkout cannot contain prescriptions for multiple patients")
            tx = PosTransaction(site_id=actor.site_id, patient_id=next(iter(patient_ids)),
                                actor_id=actor.id, idempotency_key=idempotency_key,
                                request_hash=signature, mode=mode,
                                recipient_name=recipient_name, relationship=relationship.strip(),
                                identity_method=identity_method, signature_method=signature_method,
                                signature_attested=True, subtotal=total, status="POSTED")
            s.add(tx); s.flush()
            from .date_rules import require_date_eligible, record_sale_time
            for fid, price, fill, rx, bag in selected:
                from .fill_completion import require_fill_date_eligible
                require_fill_date_eligible(s, rx, fill)
                s.add(PosLine(transaction_id=tx.id, fill_id=fid, amount=price,
                              scanned_bag=bag_values[fid] or None))
                s.add(Sale(fill_id=fid, verified_identity=True, signature_attested=True,
                           tender="SPLIT_SYNTHETIC", amount=price))
                record_sale_time(s, actor, fill)
                from .fill_completion import record_physical_sale
                record_physical_sale(s, actor, fill)
                fill.status = "SOLD"; rx.status = "SOLD"
                if fill.fill_number > 0:
                    rx.refills_used = max(rx.refills_used, fill.fill_number)
                if bag:
                    from .willcall import record_closed
                    record_closed(s, actor, fill, "SOLD", "Synthetic checkout completed")
                    bag.status = "SOLD"
            for i, (method, value, ref) in enumerate(clean_tenders, start=1):
                s.add(PosTender(transaction_id=tx.id, sequence=i,
                                method=method, amount=value, reference=ref))
            s.add(PosFinancialEvent(site_id=actor.site_id, transaction_id=tx.id,
                                     kind="CAPTURE_SIMULATED", amount=total,
                                     method="SPLIT_SYNTHETIC", request_key="SALE:"+tx.id,
                                     reason="Development-only synthetic tender capture", actor_id=actor.id))
            self.service._audit(s, actor, "POS_TRANSACTION_POSTED_SYNTHETIC", tx.id,
                                {"fills": [fid for fid, _ in clean_lines], "amount": str(total),
                                 "tender_count": len(clean_tenders), "idempotency_key": idempotency_key})
            s.flush()
            return _summary(s, tx)

    def get(self, actor: Actor, transaction_id: str) -> dict[str, Any]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            tx = self.service._site(s, PosTransaction, transaction_id, actor)
            return _summary(s, tx)

    def list(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            txs = s.scalars(select(PosTransaction).where(PosTransaction.site_id == actor.site_id)
                            .order_by(PosTransaction.created_at.desc(), PosTransaction.id)).all()
            return [_summary(s, tx) for tx in txs]

    def refund(self, actor: Actor, transaction_id: str, amount: str,
               method: str, reason: str, request_key: str) -> dict[str, Any]:
        quantity = money(amount)
        if quantity <= 0:
            raise WorkflowError("Refund amount must be positive")
        if method not in PAYMENTS:
            raise WorkflowError("Unsupported synthetic refund tender")
        reason = nonblank(reason, "Refund justification", 2000)
        request_key = nonblank(request_key, "Refund request key", 120)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            tx = self.service._site(s, PosTransaction, transaction_id, actor)
            # Idempotency across financial events is site-scoped, not only transaction scoped.
            prior = s.scalar(select(PosFinancialEvent).where(PosFinancialEvent.site_id == actor.site_id,
                             PosFinancialEvent.request_key == request_key).with_for_update())
            if prior:
                if (prior.transaction_id != tx.id or prior.kind != "REFUND_SIMULATED"
                        or prior.amount != quantity or prior.method != method or prior.reason != reason):
                    raise WorkflowError("Refund idempotency key reused with different request")
                return _summary(s, tx)
            if tx.status in ("VOIDED", "REFUNDED"):
                raise WorkflowError("Checkout cannot be refunded again")
            remaining = tx.subtotal - _financial_total(s, tx.id)
            if quantity > remaining:
                raise WorkflowError("Refund exceeds unrefunded transaction balance")
            s.add(PosFinancialEvent(site_id=actor.site_id, transaction_id=tx.id,
                                    kind="REFUND_SIMULATED", amount=quantity,
                                    method=method, request_key=request_key,
                                    reason=reason, actor_id=actor.id))
            tx.status = "REFUNDED" if quantity == remaining else "PARTIAL_REFUND"
            self.service._audit(s, actor, "POS_REFUNDED_SYNTHETIC", tx.id,
                                {"amount": str(quantity), "reason": reason, "method": method})
            s.flush()
            return _summary(s, tx)

    def void(self, actor: Actor, transaction_id: str, reason: str, request_key: str) -> dict[str, Any]:
        reason = nonblank(reason, "Void justification", 2000)
        request_key = nonblank(request_key, "Void request key", 120)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            tx = self.service._site(s, PosTransaction, transaction_id, actor)
            prior = s.scalar(select(PosFinancialEvent).where(PosFinancialEvent.site_id == actor.site_id,
                             PosFinancialEvent.request_key == request_key).with_for_update())
            if prior:
                if prior.transaction_id != tx.id or prior.kind != "VOID_SIMULATED" or prior.reason != reason:
                    raise WorkflowError("Void request reference reused for different operation")
                return _summary(s, tx)
            if tx.status != "POSTED":
                raise WorkflowError("Cannot void a partially refunded or previously closed transaction")
            s.add(PosFinancialEvent(site_id=actor.site_id, transaction_id=tx.id,
                                    kind="VOID_SIMULATED", amount=tx.subtotal,
                                    method="OTHER", request_key=request_key,
                                    reason=reason, actor_id=actor.id))
            tx.status = "VOIDED"
            self.service._audit(s, actor, "POS_VOIDED_SYNTHETIC", tx.id,
                                {"total": str(tx.subtotal), "reason": reason,
                                 "clinical_followup_required": True})
            s.flush()
            return _summary(s, tx)

    def ledger(self, actor: Actor, transaction_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            tx = self.service._site(s, PosTransaction, transaction_id, actor)
            entries = s.scalars(select(PosFinancialEvent).where(
                PosFinancialEvent.transaction_id == tx.id).order_by(
                PosFinancialEvent.created_at, PosFinancialEvent.id)).all()
            return [{"id": e.id, "kind": e.kind, "amount": str(e.amount),
                     "method": e.method, "reason": e.reason, "actor_id": e.actor_id,
                     "request_key": e.request_key} for e in entries]

    def receipt(self, actor: Actor, transaction_id: str) -> str:
        receipt = self.get(actor, transaction_id)
        sections = ["Pharmacy1OS SYNTHETIC TRANSACTION -- NOT PROOF OF PAYMENT",
                    f"Transaction {receipt['id']}", f"Status {receipt['status']}"]
        for line in receipt["lines"]:
            sections.append(f"Fill {line['fill_id']}: ${line['amount']}")
        sections.append(f"Total: ${receipt['total']}")
        sections.append(f"Refunded: ${receipt['refunded']}")
        for tender in receipt["tenders"]:
            sections.append(f"Synthetic tender {tender['method']}: ${tender['amount']}")
        sections.append("NO REAL BANK/PAYER PROCESSING; NO PERSONAL HEALTH INFORMATION ON RECEIPT")
        return "\n".join(sections)
