# Pharmacy1OS Architecture

Pharmacy1OS is a pharmacy operations application designed to run on Linux infrastructure and provide a browser-based workstation experience.

## Components

- **Web workstation:** React UI for pharmacy staff.
- **API:** Fastify boundary for business rules, authorization, auditing, and integrations.
- **Database:** PostgreSQL with Prisma for typed schema access.
- **Adapters:** future interfaces for eRx, claims, fax, PDMP, DUR/drug knowledge, barcode scanners, printers, signature capture, and point of sale.

## Design principles

1. Server-side authorization for every protected action.
2. Append-only audit history for clinically or legally meaningful operations.
3. Explicit prescription workflow states.
4. Separation of clinical data from vendor integration logic.
5. No secrets or production credentials in source control.
6. No real PHI in development fixtures.
7. Automated tests for workflow and authorization rules.
8. Reviewed database migrations.
9. Least-privilege access.
10. Fail-safe behavior when integrations are unavailable.

The current foundation is not a complete pharmacy management system.
