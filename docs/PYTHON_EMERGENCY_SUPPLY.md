# Python synthetic emergency-supply workflow (increment 18)

**Development-only. Not an authorization to perform real emergency dispensing or a state-law compliance determination.**

This Python port follows the original Stage 3I model conservatively: a pharmacist may authorize a synthetic emergency physical fill for a previously sold prescription when no authorized refills remain. No live payer request, controlled substance, or override of expiration/DUR/date restrictions is permitted.

## Clinical and workflow gates

- Authorization requires the pharmacist or administrator role. The service independently verifies pharmacy site and actor status.
- The source prescription must be SOLD with an earlier ordinary sold fill and no remaining authorized refills; no active fill, future schedule, outstanding physical partial, duplicate emergency authorization, expired Rx, unresolved high DUR, date block, or controlled drug is permitted.
- The physical quantity must be positive and no greater than the written quantity; a documented reason and explicit timezone-aware future follow-up deadline are mandatory.
- One synthetic emergency supply per prescription is permitted. The fill uses the latest ordinary fill number with a distinct attempt and does not consume a refill.
- Physical NDC/lot/expiration verification, stock reservation, pharmacist final review and pickup still apply. Synthetic payer billing for the emergency part is forbidden.
- Clinical follow-up requires a pharmacist and a documented note after pickup. The exceptions board flags open deadlines as WARNING or HIGH when overdue.
- Returning an unsold emergency part to stock preserves the earlier sold fill, marks the emergency authorization VOID_UNSOLD, and does not silently authorize another emergency.
- A prescription with emergency lineage cannot be cancelled in the generic Rx cancellation path without separate professional reconciliation.

## Interfaces

PySide6 Dashboard: Authorize Synthetic Emergency, Complete Emergency Follow-up.

API routes (synthetic mode only):
- POST /api/emergency-supplies/prescriptions/{prescription_id}/authorize with quantity, reason, follow_up_due_at ISO timestamp
- GET /api/emergency-supplies?include_closed=false
- POST /api/emergency-supplies/{fill_id}/follow-up/complete with documented note

Alembic revision c4e6bdf912a0 adds the separate py_emergency_supplies table, following b0e1d10f8a61. No Prisma/TypeScript legacy tables are changed.

## Deferred parity and release gates

No regulated emergency-dispensing legality determination, EPCS, controlled-substance exception, prescriber credential verification, verified insurer/NCPDP operation, claims transmission or reversal, pharmacy-specific emergency timelines, patient or prescriber outreach, hardware labeling, or full audit/restore/concurrency validation is claimed.

Hands-on Qt UI validation, concurrent PostgreSQL test scenarios, clinical review and operational compliance analysis remain required. Never use this prototype to dispense or store real patient information.


### Revalidation at every dispensing boundary

The service revalidates the emergency authorization at barcode scanning, physical preparation, pharmacist verification, single-fill pickup, and multi-fill POS checkout. If the catalog drug becomes controlled or is removed, if regular refills become available after authorization, or if the authorized physical quantity changes, the emergency fill is blocked for professional reassessment. The original approval does not override subsequent clinical state changes.
