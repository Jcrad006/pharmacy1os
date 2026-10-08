"""Pure-Python GS1/UPC/EAN parsing port of the legacy barcode module.

Only *valid* check-digit GTINs are accepted as GS1 product identifiers.
This decoder does not, by itself, establish DSCSA verification or an authentic
serialized trace record.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from calendar import monthrange
import re

GS = '\x1d'


@dataclass(frozen=True)
class ParsedBarcode:
    raw: str
    type: str
    identifier: str
    identifier_search: str
    gtin: str | None
    lot_number: str | None
    expiration_date: date | None
    serial_number: str | None
    format: str


def valid_check_digit(value: str) -> bool:
    if len(value) < 2 or not value.isascii() or not value.isdigit():
        return False
    digits = [int(char) for char in value]
    total = sum(d * (3 if i % 2 == 0 else 1)
                for i, d in enumerate(reversed(digits[:-1])))
    return (10 - (total % 10)) % 10 == digits[-1]


def gs1_date(value: str) -> date | None:
    if not re.fullmatch(r'[0-9]{6}', value):
        return None
    year, month, day = 2000 + int(value[:2]), int(value[2:4]), int(value[4:])
    if not 1 <= month <= 12:
        return None
    if day == 0:
        day = monthrange(year, month)[1]
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _build(raw: str, kind: str, identifier: str, *, format: str = 'PLAIN',
           lot: str | None = None, expiration: date | None = None,
           serial: str | None = None) -> ParsedBarcode:
    identifier = ''.join(identifier.split())
    return ParsedBarcode(raw=raw, type=kind, identifier=identifier,
        identifier_search=re.sub(r'[^A-Za-z0-9]', '', identifier).upper(),
        gtin=identifier if kind == 'GTIN_14' else None,
        lot_number=(lot.strip() or None) if lot is not None else None,
        expiration_date=expiration,
        serial_number=(serial.strip() or None) if serial is not None else None,
        format=format)


def _parenthesized(raw: str, value: str) -> ParsedBarcode | None:
    matches = list(re.finditer(r'\(([0-9]{2,4})\)', value))
    if not matches or matches[0].start() != 0:
        return None
    fields: dict[str, str] = {}
    for i, match in enumerate(matches):
        name = match.group(1)
        end = matches[i+1].start() if i + 1 < len(matches) else len(value)
        if name in fields:
            return None  # Duplicate AI must never silently overwrite evidence.
        fields[name] = value[match.end():end].replace(GS, '').strip()
    gtin = fields.get('01')
    if not gtin or not re.fullmatch(r'[0-9]{14}', gtin) or not valid_check_digit(gtin):
        return None
    if any(key not in {'01','10','17','21'} for key in fields):
        return None  # Unknown AIs require a versioned parser, not guesswork.
    if '17' in fields and gs1_date(fields['17']) is None:
        return None
    if '10' in fields and (not 1 <= len(fields['10']) <= 20):
        return None
    if '21' in fields and (not 1 <= len(fields['21']) <= 20):
        return None
    return _build(raw, 'GTIN_14', gtin, format='GS1',
                  lot=fields.get('10'),
                  expiration=gs1_date(fields['17']) if '17' in fields else None,
                  serial=fields.get('21'))


def _elements(raw: str, value: str) -> ParsedBarcode | None:
    cursor = 0
    fields: dict[str, str] = {}
    while cursor < len(value):
        if value[cursor] == GS:
            cursor += 1
            continue
        ai = value[cursor:cursor+2]
        if ai == '01':
            candidate = value[cursor+2:cursor+16]
            if len(candidate) != 14 or not candidate.isascii() or not candidate.isdigit() or not valid_check_digit(candidate):
                return None
            if ai in fields:
                return None
            fields[ai] = candidate
            cursor += 16
        elif ai == '17':
            candidate = value[cursor+2:cursor+8]
            if gs1_date(candidate) is None or ai in fields:
                return None
            fields[ai] = candidate
            cursor += 8
        elif ai in {'10', '21'}:
            if ai in fields:
                return None
            start = cursor + 2
            end = value.find(GS, start)
            if end < 0:
                end = len(value)
            candidate = value[start:end].strip()
            if not 1 <= len(candidate) <= 20:
                return None
            fields[ai] = candidate
            cursor = end
        else:
            return None
    if '01' not in fields:
        return None
    return _build(raw, 'GTIN_14', fields['01'], format='GS1',
                  lot=fields.get('10'),
                  expiration=gs1_date(fields['17']) if '17' in fields else None,
                  serial=fields.get('21'))


def parse_barcode(raw_input: str) -> ParsedBarcode | None:
    """Return None for invalid GTIN or malformed GS1; never fall back to OTHER."""
    raw = raw_input.strip()
    if not raw:
        return None
    value = re.sub(r'^\](?:d2|C1)', '', raw, flags=re.IGNORECASE)
    value = value.rstrip('\r\n')
    if value.startswith('('):
        return _parenthesized(raw, value)
    if value.startswith('01') and len(value) >= 16:
        return _elements(raw, value)
    for length, kind in ((14, 'GTIN_14'), (13, 'EAN_13'), (12, 'UPC_A')):
        if re.fullmatch(fr'[0-9]{{{length}}}', value):
            return _build(raw, kind, value) if valid_check_digit(value) else None
    if GS in value or any(ord(char) < 32 for char in value):
        return None
    return _build(raw, 'OTHER', value)
