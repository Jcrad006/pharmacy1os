# Python GS1 and scanner domain conversion

**Status: synthetic-only, additive port.** The original TypeScript `apps/api/src/barcode.ts`
remains the reference. The Python port is implemented in
`python/pharmacy1os/barcode.py` and a coordinating service in
`python/pharmacy1os/scanner.py`. Neither file introduces a browser dependency.

## Implemented

- UPC-A (12 digits), EAN-13 (13 digits), GTIN-14 (14 digits), with GS1 mod-10 check digits.
- Raw GS1 element strings (including the ASCII Group Separator FNC1), `]d2`/`]C1` scanner prefixes,
  and parenthesized application identifiers `(01)` GTIN, `(10)` lot, `(17)` expiration,
  and `(21)` serial.
- Expiration date decoding from `YYMMDD`, including day `00` as the final day of the month;
  calendar-invalid dates are refused.
- Rejection of duplicated/malformed/unknown application identifiers rather than inferring an NDC.
- A `ScannerService` in-process adapter that resolves the registered product identifier,
  rejects disagreements between GS1 and manually entered lot/expiration, and delegates
  to the existing `PharmacyService.receive` and `PharmacyService.scan_source` transactions.
- Separate pure parsing and transactional tests, including invalid checksums, conflicting
  lot/expiration, unknown GTINs, successful synthetic receiving and product fill.

## Usage

```python
from pharmacy1os.scanner import ScannerService

scanner = ScannerService(pharmacy_service)
# Requires the product's base GTIN to have been registered as a barcode first.
stock_id = scanner.receive(demo_technician, raw_scanner_payload, "20")
scanner.scan_source(demo_technician, fill_id, raw_scanner_payload, "20")
```

The original non-GS1 APIs remain available; these methods are an additive core adapter,
not automatically installed API/UI replacements. The scanner driver and native Qt scan
entry will need to invoke the adapter in a later integration release. A source barcode's
serial number is parsed but **not currently linked to a serialized inventory unit or
DSCSA trace record**. This is not GS1-128/DataMatrix certification, package authentication,
regulated traceability, a drug-substitution policy, or a safe-live-dispensing certification.

Production follow-up must cover practical scanner symbologies, rejected nonstandard AIs,
barcode registry normalization, hardware device adapters, regression comparison against
legacy parsing, DSCSA storage and provenance, and authoritative inventory/label linkage.
