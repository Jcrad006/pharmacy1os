# Stage 3M.4 — Staff offboarding, test credential review and security monitoring

**Status:** Implemented in the Stage 3M draft pull request, subject to CI. **Production startup remains prohibited.** Only synthetic users and test OIDC identities are appropriate.

## Global offboarding

A new `POST /api/staff/:id/global-suspend` endpoint, also offered through Staff Administration, atomically:

- sets `User.active=false`;
- disables all active site grants across all pharmacies;
- revokes every active server session, not just the currently selected site;
- cancels pending privileged role requests and active temporary elevation requests;
- creates an audit record containing the actor, a required reason, number of sites affected, sessions revoked and pending access cancelled.

**Separation of authority:** The initiating actor must have the `ADMIN` site role, a recent (at most five minutes old) MFA-backed session, and an active `ADMIN` grant at *every affected site*. They cannot suspend themselves. The routine path explicitly **rejects any account having an ADMIN, PHARMACIST or PHARMACIST_IN_CHARGE grant at any site**; high-trust offboarding will require separate independent review. This prototype exposes no account-global reactivation route. Tests cover cross-site permission denial, session revocation on two sites, audit history and repeated suspension.

## Professional credential evidence — NOT licensing verification

A `StaffCredentialReview` model records a reviewer-supplied evidence source, an opaque internal reference, a rationale, intended pharmacist/PIC role and a short expiration date (at most 90 days for **synthetic** tests). A distinct site administrator submits, and a distinct current site pharmacist-in-charge may mark the submission `TEST_ATTESTED` or `REJECTED` with a required note, within their own site and with recent MFA.

**Critical limitation:** No connection to state boards of pharmacy, licensure authorities or authoritative employer credential sources has been implemented. The result is an independently attested *test record*, not verified licensure, statutory authority, professional eligibility, or a legal PIC designation. The API response reports `automaticAuthorityVerification: false` and never returns the raw evidence reference. No unrestricted role promotion is permitted.

For the existing `ENABLE_SYNTHETIC_ROLE_GRANTS=true` test path, granting `PHARMACIST` or `PHARMACIST_IN_CHARGE` additionally requires a `TEST_ATTESTED` record for the exact staff/site/role, still unexpired, reviewed by a currently active site PIC. The feature is disabled by default, even in OIDC development. Neither this check nor the role itself permits live clinical operation.

Available endpoints:

| Method and route | Purpose |
| --- | --- |
| `GET /api/credentials/reviews` | Site-manager review ledger, without raw evidence IDs |
| `POST /api/credentials/reviews` | Submit synthetic evidence (ADMIN; recent MFA) |
| `POST /api/credentials/reviews/:id/decision` | Independent test attestation/rejection (PIC; recent MFA) |
| `POST /api/staff/:id/global-suspend` | Organization-wide suspension, subject to admin authority at every site |

The Workforce Security workstation screen provides review submission, independent approval/rejection, and recent denied-request diagnostics.

## Security diagnostics and login attempt limits

A `SecurityEvent` ledger stores structured denials (HTTP 401/403) and rate-limited attempts (HTTP 429) via the API response hook. Only route *templates* are logged—no query parameters, prescription identifiers embedded in route parameters, session tokens, raw IP addresses or PHI. A daily HMAC of the directly observed remote IP is stored for short-lived correlation. `GET /api/security/events` requires the current site's `ADMIN` permission, returns the last 100 attributed denial events within 24 hours, and includes counts of unattributed login denials without disclosing network fingerprints.

Test OIDC login starts are conservatively limited to 10 counted starts per observed network fingerprint over a rolling five-minute window. This is **only a prototype abuse signal**, not an atomic distributed rate limiter. Do not trust arbitrary `X-Forwarded-For` headers; production needs an explicit reverse-proxy trust boundary and provider-side account-based throttling. Security event persistence currently remains best effort and **is not a tamper-evident, durable or independently monitored security audit system**.

## Open gates

- Independently connected and certified licensure-status verification, expiry/revocation synchronization, training and PIC designation.
- Two-person offboarding for protected clinical/administrator accounts, controlled global reactivation, organization administrative model.
- Concurrent multi-node atomic rate limiting, threat detection and alerting, failed MFA/provider audit integration, login enumeration defense.
- Immutable/retention-protected security event storage, high-availability monitoring and security incident response controls.
- Real OIDC provider browser E2E and session-expiry exercises, security/privacy assessment and penetration test.
- Formal production threat model and review of patient data/regulated claims/EPCS interfaces.

**DO NOT enable production or process real patient information based on these improvements.** The Stage 3M production startup gate remains unconditional.
