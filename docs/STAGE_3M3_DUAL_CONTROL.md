# Stage 3M.3 — Dual-control authorization and time-boxed permissions

**Status:** Implemented on the Stage 3M draft branch; subject to CI, independent security review and additional hardening. **Not production-ready.** Synthetic data and test identity-provider accounts only.

## Purpose

Prevent a single privileged staff actor from granting themselves clinical/admin power or approving their own expanded access. Persist a reviewable, site-specific authorization chain. Distinguish *roles* from a narrowly bounded, temporary *permission*.

## Implemented workflow

- `GET /api/privileged/requests`: list up to 100 recent approval records for the current pharmacy; management users can view site requests, other staff can view only their own requests or requests affecting them.
- `POST /api/privileged/requests`: authenticated OIDC user with **MFA within the last five minutes** creates a pending request. A test request expires 10 minutes after creation. The reason is mandatory.
- `POST /api/privileged/requests/:id/review`: **another human identity**, separately logged in with recent MFA, approves or denies with a mandatory note; database compare-and-set allows only one decision, and decisions are recorded in the same database transaction as any role/session modifications.
- `POST /api/privileged/requests/:id/cancel`: requester or beneficiary cancels pending request or stops an active temporary permission early. Cancellation is audited.
- `Access Approvals` workstation screen allows ordinary eligible staff to request temporary access and site leaders to view/review scoped approval requests.

### Temporary permissions

The *only* permission scopes accepted by this stage are `inventory:correct` and `thirdparty:override`. Requesters must already possess `inventory:write` or `thirdparty:write` respectively. These permissions **do not** provide pharmacist verification, clinical-document access, user management, emergency supply, or any controlled-substance authority.

A site leader (`ADMIN` or `PHARMACIST_IN_CHARGE`) must approve. Upon approval, a server-side permission exists for no longer than **15 minutes**. It only applies to the beneficiary's active site, within the same user's MFA-fresh session context. Permission resolution checks current site membership and account status on every authorized request. Role changes or site access suspension cancel previously approved temporary access.

### High-trust role requests — strictly synthetic

**Default-deny:** The site role-grant route is completely disabled unless `ENABLE_SYNTHETIC_ROLE_GRANTS=true` is explicitly set in a non-production development/test environment. The default `false` value is intentional. The server rejects both requesting and approving high-trust roles while disabled, and the workstation hides the request form. This flag **must never be used as a substitute** for independently verified professional credentials or an authorization process.


The high-trust role request path may modify an existing test-site grant on second-person approval, but **not** through the ordinary staff enrollment/role editor. Approved role changes revoke all existing sessions of the beneficiary at the affected site. No new user can self-provision as an administrator or pharmacist.

- `PHARMACIST` or `PHARMACIST_IN_CHARGE`: site `ADMIN` requests; *different* current site `PHARMACIST_IN_CHARGE` approves.
- `ADMIN`: existing site `PHARMACIST_IN_CHARGE` requests; *different* current site `ADMIN` approves.
- Requester and reviewer must be different; beneficiary cannot be the reviewer. The role request must reference the exact staff site-role revision, and authorization fails if the record has changed before approval. Only an active, OIDC-provisioned member of that pharmacy may be targeted.

**These approvals are not pharmacist licensure or credential verification.** Neither a role grant nor a demonstration of independent approval indicates that an individual is professionally authorized to verify prescriptions. For future production, a separate authoritative license/credential verification domain and independent human review must gate licensed roles; do not equate application role names with state-board professional authority. Existing synthetic seed privileged accounts are not a safe method of bootstrapping real administrators.

### Tests and invariants

- OIDC authentication and CSRF controls remain mandatory; `x-dev-user` cannot bypass any approval operation in `AUTH_MODE=oidc`.
- Database checks enforce the expected request shape and prohibit records showing the requester/beneficiary as reviewer.
- Denied/expired requests never become active capabilities; approval replay is rejected; cancellation immediately invalidates a temporary permission.
- Requests and reviewers must be at the same pharmacy site. The session's active site determines scope.
- Target site grant must still be active; snapshot revision prevents a stale role request from silently overwriting later modifications.
- Transactional audit records record the actor, target, type, decision, affected sessions, and request ID.

## Remaining Stage 3M release blockers

This system remains prototype code. Required next: independent pharmacist-license/credential verification, formal trust model for the first administrator/PIC, explicit workforce suspension and global offboarding, approval rate limits and anti-collusion governance, hardware-backed MFA/re-auth where appropriate, provider login/logout lifecycle and failure monitoring, formal policy signoff for elevation capabilities, tamper-resistant security event retention, provider-integrated browser E2E tests, penetration testing, threat modeling, and independent security assessment.

**Production API execution remains blocked by the Stage 3M startup gate.** Do not process patient PHI or dispense real prescriptions with this build.
