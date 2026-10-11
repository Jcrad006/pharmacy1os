"""Safe synthetic scanner adapter for in-process Python domain services.

The same parsed identity is passed to receiving and Product Fill. GS1 lot and
expiration must agree with any manually entered metadata; raw scanner strings
cannot silently override a technician's explicit selection.
"""
from __future__ import annotations

from datetime import date
from sqlalchemy import select

from .barcode import ParsedBarcode, parse_barcode
from .models import Barcode
from .service import Actor, PharmacyService, WorkflowError


class ScannerService:
    def __init__(self, pharmacy: PharmacyService):
        self.pharmacy = pharmacy

    def _resolve(self, actor: Actor, raw: str, lot: str | None,
                 expires: str | None) -> tuple[ParsedBarcode, str, str]:
        barcode = parse_barcode(raw)
        if barcode is None:
            raise WorkflowError('Invalid or unsupported GS1/product barcode')
        with self.pharmacy.sessions() as s:
            self.pharmacy._authorized(s, actor, 'read')
            registered = s.scalar(select(Barcode).where(Barcode.value == barcode.identifier))
            if registered is None:
                raise WorkflowError('Product identifier not registered: resolve receiving barcode assignment')
        scanned_lot = barcode.lot_number
        scanned_date = barcode.expiration_date.isoformat() if barcode.expiration_date else None
        if scanned_lot and lot and scanned_lot != lot.strip():
            raise WorkflowError('GS1 lot does not match the selected physical source')
        if scanned_date and expires and scanned_date != expires.strip():
            raise WorkflowError('GS1 expiration does not match the selected physical source')
        final_lot = (lot or scanned_lot or '').strip()
        final_exp = (expires or scanned_date or '').strip()
        if not final_lot or not final_exp:
            raise WorkflowError('Lot and expiration are required; barcode did not supply both')
        try:
            date.fromisoformat(final_exp)
        except ValueError as exc:
            raise WorkflowError('Expiration must use YYYY-MM-DD') from exc
        return barcode, final_lot, final_exp

    def receive(self, actor: Actor, raw: str, quantity: str,
                lot: str | None = None, expires: str | None = None) -> str:
        b, lot, expires = self._resolve(actor, raw, lot, expires)
        return self.pharmacy.receive(actor, b.identifier, lot, expires, quantity)

    def scan_source(self, actor: Actor, fill_id: str, raw: str, quantity: str,
                    lot: str | None = None, expires: str | None = None) -> None:
        b, lot, expires = self._resolve(actor, raw, lot, expires)
        self.pharmacy.scan_source(actor, fill_id, b.identifier, lot, expires, quantity)
