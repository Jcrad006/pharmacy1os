# Stage 3K — Will Call / Pickup / POS hardening

Stage 3K replaces the prototype's direct `READY → SOLD` state toggle with a controlled pickup transaction. The goal is to keep the prescription, physical package, claim state, patient amount, tender, and pickup evidence tied together instead of allowing those facts to drift independently.

> This is development architecture only. It does not perform live insurance adjudication, charge cards, validate government identification, or capture a hardware signature.

## Operational sequence

```text
Pharmacist verifies fill
        ↓
READY + committed inventory + active label
        ↓
        ├── patient waiting → IMMEDIATE pickup (no bag/bin staging)
        │
        └── patient not waiting → Stage physical prescription
                                  ↓
                            WillCallPackage
                              - unique bag barcode
                              - active WILL_CALL location/bin
                              - optional scanned location barcode
        ↓
Pickup quote
  - insured: final active paid COB patient responsibility
  - cash: exact physical source quantities × snapshotted unit price
  - completion already billed: $0 additional due
        ↓
Pickup controls
  - scan the staged bag
  - identify recipient / relationship
  - verify identity method
  - capture signature attestation
  - capture required tender
        ↓
Atomic POS completion
  - immutable sale transaction + lines + tenders
  - WillCallPackage → PICKED_UP
  - fill → SOLD
  - prescription → SOLD
```

## Physical Will Call model

Each pharmacy site receives a default `WILL_CALL` inventory location during migration/bootstrap. Additional Will Call bins can be configured in the inventory architecture workspace. Locations may have a unique site-scoped barcode.

A Ready fill that enters physical Will Call must be staged into exactly one `WillCallPackage`. That package owns a unique bag barcode and points to the physical Will Call location. A normal `WILL_CALL` pickup refuses to quote an unstaged fill and refuses checkout when the scanned bag does not match the selected fill.

A separate `IMMEDIATE` fulfillment mode is available when the patient is physically waiting at the pharmacy at the time the pharmacist verifies the fill. Immediate pickup requires the fill to be `READY`, to have an active label, and to have **no** Will Call package. It skips bag/bin staging but does not skip the controlled POS boundary: patient amount, identity verification, signature, tender, claim linkage, sale-state transitions, and audit events are still required. If the fill has already been staged, staff must use the normal Will Call checkout rather than bypassing the package scan.

The package lifecycle is intentionally simple:

```text
STAGED → PICKED_UP
   └──→ RETURNED_TO_STOCK
```

A sold package cannot be restaged through the normal staging endpoint.

## Patient amount due

### Third-party / COB

If the patient has active coverage, pickup requires an active unreversed paid claim. Stage 3K snapshots the patient responsibility from the final active paid transaction in the COB sequence and links the sale line to that claim transaction.

### Partial-fill completion

A completion part linked to a primary billing anchor does not collect a second copay when the primary logical fill was already successfully adjudicated. Its sale line records `COMPLETION_ALREADY_BILLED` and an amount due of zero.

### Cash

When no active coverage exists, the quote is calculated from the physical product sources actually used:

```text
cash amount = Σ (physical source quantity × current product unit price)
```

The sale line snapshots product ID, NDC, source quantity, unit price, and extended amount so later price-master edits do not rewrite historical sale economics.

## Tender controls

A nonzero balance requires one or more tenders. Supported development tender types are cash, card, check, and other.

- Non-cash tender cannot exceed the amount due.
- Total tender must cover the amount due.
- Overpayment is permitted only when a cash tender is present, because only then can the transaction represent change due.
- A zero-dollar completion transaction must not contain a tender.

Stage 3K records tender metadata only. It does not authorize or settle a real card transaction.

## Pickup verification

Every checkout records the pickup recipient, relationship when supplied, identity-verification method, verification timestamp, signature method, and signature name/reference.

DOB verification is implemented server-side: the entered date is compared with the patient record and is not persisted as a second DOB value. Other identity methods are currently staff attestations only.

The workstation supplies a typed electronic-signature path. The API also reserves explicit methods for paper and external-device signatures by reference so a future signature-pad integration does not require redesigning the sale record.

## Abandoned prescriptions / return to stock

A Ready insured fill cannot simply restore inventory while leaving a paid claim outstanding. The return-to-stock sequence is:

1. reverse all active paid synthetic claim transactions for the fill;
2. verify no active paid claim remains;
3. return the committed inventory through the inventory ledger;
4. mark the fill `RETURNED_TO_STOCK`;
5. mark the staged Will Call package `RETURNED_TO_STOCK`;
6. return the prescription to `DUR_REVIEW`.

If claim reversal fails, the stock-return transaction is not allowed to continue.

## Sale/claim integrity

After a successful checkout, the active claim referenced by the sold fill cannot be independently reversed while the POS transaction remains completed. A future post-pickup return/refund workflow must coordinate the POS void/refund, claim reversal/rebill, and inventory disposition as one controlled operation.

The older generic prescription-status endpoint blocks direct `READY → SOLD` transitions by default with `POS_CHECKOUT_REQUIRED`. `ALLOW_LEGACY_DIRECT_SALE=true` is only a regression-test compatibility escape hatch and is not part of the production workflow.

## Audit and idempotency

Each checkout has a unique idempotency key and unique receipt number. Retrying the same idempotency key replays the prior POS result instead of creating a second sale. The POS transaction also persists whether pickup occurred through `WILL_CALL` or `IMMEDIATE` fulfillment so reporting and audit history preserve the physical workflow used.

Audit events record the transaction, fill, price basis, claim link, Will Call package/location, patient amount, tender methods, and pickup-verification method. Sensitive verification input that does not need to be retained, such as the DOB value entered at pickup, is not copied into the audit metadata.

## Deferred from Stage 3K

The following remain later integration/hardening work:

- live clearinghouse/NCPDP claim transport;
- production payment processor and card-terminal integration;
- receipt-printer integration;
- signature-pad/device integration;
- validated government-ID or address verification;
- coordinated post-pickup refund/return, POS void, claim reversal/rebill, and inventory disposition;
- production authentication, security, privacy, regulatory, and formal validation work.
