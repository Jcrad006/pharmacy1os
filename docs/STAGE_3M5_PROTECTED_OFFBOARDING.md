# Stage 3M.5 — Protected-account offboarding and authorization lifecycle

**Status:** Development prototype on draft PR #42; no production permission. All tests use synthetic data. No external pharmacist credentials, PHI, or regulated operations.

## Protected-account global offboarding

The routine organization-wide suspension endpoint introduced in Stage 3M.4 **continues to reject staff with any active or historical protected ADMIN, PHARMACIST or PHARMACIST_IN_CHARGE site grant**. It cannot silently switch to a dangerous one-person authorization path.

New routes:

| Route | Permission and effect |
| --- | --- |
| `GET /api/protected-offboarding` | View recent site-scoped approval requests as ADMIN/PIC |
| `POST /api/protected-offboarding` | Site ADMIN initiates a global protected-account suspension with recent MFA and a 10–500-character documented reason |
| `POST /api/protected-offboarding/:id/review` | **Different** current site PIC reviews with recent MFA and a mandatory review note, then DENIES or APPROVES |
| `POST /api/protected-offboarding/:id/cancel` | Original requester cancels their still-pending request |

The requested target must currently have a protected role at one or more sites and an active OIDC-provisioned account. Request and review are scoped to the selected pharmacy, and the request expires **10 minutes** after creation.

On **every review**, the system re-checks that the requester still has `ADMIN` grants at **all sites** where the target currently has active staff access, and that the independently authenticated reviewer still has `PHARMACIST_IN_CHARGE` grants at those same sites. The requester and reviewer must not be the same identity, and neither may be the beneficiary. Approval is impossible if disabling the target would leave any affected pharmacy with no other active administrator or PIC.

An approved decision and the following changes are executed in one **PostgreSQL SERIALIZABLE transaction**. Concurrent incompatible changes return HTTP 409 (not partial success): `User.active=false`, all active `SiteRoleAssignment` records disabled, every `AuthSession` revoked across the organization, pending privilege approvals and active temporary delegation by/for/from the departing person cancelled, other outstanding protected suspension requests invalidated, plus an audit event identifying the requester, reviewer, sites and number of sessions affected. Denials and cancellations have separate recorded audit events. Old sessions never return on a subsequent page load.

The existing site-specific access APIs and ordinary staff administration screens do not bypass this process. The **Workforce Security** workstation provides request, independent approve/deny, and cancellation controls.

## Other Stage 3M.5 hardening

- The Stage 3M.3 privileged role-review endpoint rechecks the original requester's current account status and role before approving a pending high-trust change. A stale request from a demoted or suspended manager cannot promote someone later.
- Routine global offboarding now invalidates outstanding privileged requests that were created or reviewed by the departed employee.
- Negative-path tests cover self-approval, cross-site rights, MFA freshness, replay, expiration, denial, cancellation, and suspension of two independently scoped site sessions.

## Important limits and unfinished security gates

- **No integrated authoritative licensure verification:** Staff credential records are `TEST_ATTESTED` only, not evidence of licensure status. The synthetic pharmacist/PIC role grant demonstration remains **disabled by default**.
- Test workstation entry uses real OIDC-style roles but has not been proven against an external production IdP and certified provider integration.
- Protected-account reinstatement is deliberately **not implemented**. A formal controlled restoration/appeal process is required.
- Production needs testable continuity-of-operations procedures for sole-admin/sole-PIC departures (an independent operator must be onboarded before disabling the last person). There is no unsafe 'last person' bypass.
- Formal threats from collusion, compromised IdP, stale identity assertions, database administrator override, denial-of-service, and failover still require independent assessment.
- Durable tamper-resistant security event storage, deployment-aware atomic rate limiting, authoritative license validation, policy review and external penetration testing remain open.

**The runtime production safety gate is unchanged.** No real patient data, paid claims, EPCS, or live pharmacy dispensing.
