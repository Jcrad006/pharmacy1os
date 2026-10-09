# Python synthetic partial-fill and owed-completion lineage

**Development-only. Not validated for live pharmacy use, state law, NCPDP claim rules,
emergency dispensing, or controlled-substance procedures.**

This increment ports a limited form of the legacy Stage 3I/3J separation between
a *logical fill* and one or more *physical dispense parts*, keeping the existing
TypeScript implementation authoritative until cross-language contract testing.

## Operations

- Starting a normal Python fill with `dispense_quantity` below the prescription
  quantity creates an `OPEN` obligation for the original full quantity. This
  tracks the physical part and maintains the primary synthetic payer-intended
  quantity. No extra logical refill is consumed.
- A technician may choose **Stop / Convert To Partial** during `PRODUCT_FILL`
  only, before any claim has been generated. The procedure releases *all*
  existing physical source reservations and deletes their provisional source
  links in the same transaction. It reduces the physical part quantity and
  requires all physical sources to be scanned afresh. It does **not** silently
  assert an inventory discrepancy or change on-hand balance. The reason is audited.
- Once the primary physical part has been pharmacist-verified and **SOLD**,
  only the amount actually sold reduces the owed balance. A linked completion
  can be started for up to the remaining owed amount, with fresh scan, labels
  and pharmacist verification. A subsequent partial completion is possible
  after each earlier completion is sold.
- A completion inherits the **same prescription fill number** and full
  payer-intended quantity. It uses a separate attempt/part number and physical
  quantity. It **does not** create a new synthetic payer claim; providing
  payer names at completion preparation is rejected.
- Completion parts must pass expiration, do-not-fill-before, high-severity DUR,
  scan, lot, recall, inventory, pharmacist review and pickup verification gates.
  The **new-refill** minimum days-between-fills policy is not applied to the
  remainder of the same logical fill.
- Returning an unsold primary partial to stock records `VOID_UNSOLD`; this
  allows the logical fill to be retried without erasing history. Returning an
  unsold completion leaves the original owed balance unchanged.
- The program blocks starting or scheduling a new logical refill while an
  `OPEN` obligation exists. Cancellation of a prescription with a previously
  sold unresolved physical partial fails closed pending professional reconciliation.

A `FULFILLED` obligation means the full intended physical amount has actually
been **sold**, not merely pharmacist verified, billed or placed in Will Call.
Billed quantity and physically sold quantity remain distinct.

## API and Qt

When explicitly enabled in the **synthetic-only** API, use:

- `POST /api/fills/{fill_id}/interrupt-as-partial`
  with `{"quantity":"12","reason":"Documented stock shortage"}`
- `GET /api/fills/{anchor_fill_id}/owed-balance`
- `POST /api/fills/{anchor_fill_id}/begin-completion`
  with `{"quantity":"78"}` or `{}` for all remaining owed

The native PySide6 Dashboard has **Stop / Convert To Partial**,
**Supply Owed Completion**, and **View Physical Balance** actions.

Alembic revision `b0e1d10f8a61` (after `e2a9401f67c3`) adds
`py_fill_obligations` and `py_fill_completions` only.
No legacy Prisma data has been imported or altered.

## Deliberately deferred

- A **real** payer must not be billed according to this synthetic assumption
  without payor-specific transaction requirements, claim updates and reversal
  acknowledgement; no e-claims are transmitted here.
- No emergency dispensing protocol, controlled-substance partial limitations,
  legal deadlines, patient consent, shortage reconciliation dashboard, or
  reconciliation after a sold partial has yet been developed.
- Physical shortage reports do not automatically create ledger adjustments or
  high-severity discrepancy cases. An independent inventory count/exception
  workstream and documented pharmacist disposition remain required.
- No Python implementation of legacy refill rescue, cross-site transfer of
  prescriptions, inventory demand scheduling of owed completions, hardware
  label output, or live fax/eRx interoperability is asserted.
- The environment still relies on synthetic identity, isolated tables,
  development databases and tests rather than clinical validation.
