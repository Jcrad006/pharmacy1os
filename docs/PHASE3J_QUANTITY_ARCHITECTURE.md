# Phase 3J quantity and partial-fill architecture

This document defines the quantity semantics that Phase 3J claims, adjudication,
labels, and rejection handling must preserve.

## Core rule

A logical prescription fill and a physical dispensing event are not the same thing.

For a prescription fill intended for 90 tablets where only 3 tablets are physically dispensed today:

- logical/intended fill quantity = 90
- payer-intended quantity = 90
- physical quantity for part 1 = 3
- physical quantity actually dispensed at sale of part 1 = 3
- quantity remaining owed = 87
- physical quantity for the linked completion = 87
- the completion keeps the same prescription fill number and does not consume a new refill

The primary synthetic Phase 3J adjudication workflow therefore uses the full payer-intended quantity for the logical fill. A completion is not treated as a new normal refill or a second independent fill/month event.

Actual claim transactions will still store their own immutable submitted quantity. A future payer adapter may need payer-specific partial/completion transaction formatting, but it must not change the internal physical dispensing record or manufacture an extra refill.

## PrescriptionFill quantity fields

`quantity`: planned physical quantity for this specific dispense part. This remains the compatibility field used by inventory reservation and commitment.

`authorizedQuantity`: legacy total quantity field retained for compatibility.

`intendedQuantity`: full logical quantity intended for the authorized prescription fill.

`payerIntendedQuantity`: full quantity that the primary claim/adjudication workflow is intended to represent. For a 3-of-90 partial, this remains 90.

`physicalDispensedQuantity`: quantity actually handed to the patient for this part. It is recorded when the part reaches SOLD and never inferred from the payer quantity.

`remainingOwedQuantity`: quantity still owed on the logical fill. This is maintained on the primary billing-anchor fill and decreases as linked completion parts are physically sold.

## Billing lineage

`billingRole = PRIMARY_CLAIM`: the primary logical fill. A partial root remains the billing anchor even if only part of the intended quantity is physically dispensed initially.

`billingRole = COMPLETION_OF_PRIMARY`: a later physical completion of the same logical fill. It keeps the same fill number, receives a separate part number, does not consume another refill, and points to the primary fill through `billingAnchorFillId`.

`billingRole = EMERGENCY_SUPPLY`: a separately authorized emergency-supply dispensing event. Its future payer handling remains distinct from ordinary refill authorization.

## Product Fill interruption

A technician may convert an IN_PROGRESS Product Fill into a partial either before product scan or after a successful scan/reservation.

If the product was already scanned and reserved:

1. a structured interruption reason is required;
2. the original reservation is released;
3. the current part is converted to the physical partial quantity;
4. only that physical quantity is re-reserved against the same NDC/lot/expiration;
5. the full intended and payer-intended quantities are preserved;
6. a linked completion is created for the remaining physical quantity;
7. a dated inventory demand is created for that completion;
8. a reported physical shortage/stock discrepancy creates a high-severity inventory exception;
9. the technician report does not silently change on-hand inventory.

The inventory exception requires reconciliation. Pharmacist/admin resolution requires a documented note and is audited.

## Phase 3J scan/adjudication contract

When Phase 3J is implemented, `PRODUCT_BARCODE_VERIFIED` validates NDC/lot/expiration and reserves the physical part quantity. The same successful scan then triggers claim construction/adjudication.

For the default synthetic partial-fill strategy, claim construction takes the full `payerIntendedQuantity` from the billing anchor, not the physical part quantity.

A paid claim may therefore represent 90 while the first physical dispense and label represent 3. Inventory decrements only 3 when that part is pharmacist verified. The remaining 87 stays owed and is physically decremented only when the completion is verified.

If the physical shortage is discovered after adjudication, converting to a partial does not automatically rewrite the paid claim to the smaller physical quantity. The payer transaction remains an immutable record and any payer-specific adjustment/reversal behavior belongs to the claims adapter.

## Label contract

A dispensing label describes the medication physically supplied in that specific dispense part. It therefore uses the physical part quantity, not the payer-intended quantity.

The full payer quantity remains available in claim/audit context but must never cause the patient label or inventory ledger to falsely state that the full quantity was physically supplied.

## Non-negotiable separation

The following values must remain separately representable:

- prescription quantity written;
- logical fill quantity intended;
- payer-intended quantity;
- immutable claim submitted quantity;
- physical quantity planned for a dispense part;
- physical quantity actually dispensed;
- inventory quantity reserved/committed;
- quantity remaining owed.

No future claims or label implementation should collapse those concepts into a single generic quantity field.
