# Stage 3M.2 — Site staff administration and access lifecycle

**Implementation branch:** `stage-3m-identity-foundation` (draft PR #42). Stage 3M is **still incomplete**.

This increment adds an **OIDC-only**, server-enforced staff management interface. It is deliberately unavailable when `AUTH_MODE=development`. The synthetic development user's `x-dev-user` header cannot access it.

## Implemented

- Distinct **Pharmacist in Charge** (`PHARMACIST_IN_CHARGE`) and **Inventory Manager** (`INVENTORY_MANAGER`) site-role values with explicit permission sets. No existing users receive these roles automatically.
- Site-scoped `GET /api/staff`: available only to `user:manage` actors (administrator or PIC). Returns staff name, site role, active account status, site access, provisioning status and optimistic-concurrency timestamp. Excludes OIDC subject and any session secrets.
- Site-scoped `POST /api/staff`: manually bind a **test** staff identity to the exact OIDC subject from a configured test identity provider. Requires unique subject and valid name. An ordinary manager may create **technician, intern, cashier, auditor, or inventory manager** only. **No pharmacist, PIC or admin enrollment** is available by this route.
- `PATCH /api/staff/:id/role`: site-local role change between permitted routine roles. Rejects self-role changes, protected roles, inactive grants, and cross-site targets. Requires a matching `expectedUpdatedAt` to prevent silent overwrites. Revokes existing sessions for the user at the affected pharmacy.
- `PATCH /api/staff/:id/site-access`: suspend/restore a **routine** site's access. Staff member's sessions at that site are revoked atomically. Re-enabling does not revive prior sessions or reactivate globally disabled accounts. Self-suspension or protected-role changes are denied.
- `POST /api/staff/:id/sessions/revoke`: revoke a staff member's sessions at the selected site without touching active sessions in other pharmacy sites, with audit record.
- Workstation's **Staff Administration** screen (OIDC mode only): provision synthetic staff, review site assignments, change routine roles, suspend/restore access, and revoke sessions. No decorative buttons.
- Security tests: dev-user spoofing, lack of staff-manager permission, cross-site isolation, restricted-role escalation, concurrent timestamp conflicts, revocation on role changes, site access suspension, and per-site session boundaries.
- Writes and structured audit events occur in one database transaction. Authentication and site-role checks are repeated server-side on each API request.

## Important boundaries

**An administrator cannot promote themselves or grant pharmacist/PIC/administrator status through this module.** Those actions require a separate independently reviewed elevation flow, identity and credential verification, and documented approval. The current API does **not** implement that approval flow. Existing synthetic seed administrators are still for demo/testing; they are not legitimate production operators.

Disabling routine site access **does not globally disable** a user who also belongs to other sites. To invalidate access at every site, revoke every site grant or use an eventual organization-level account suspension workflow. Password/MFA enrollment happens exclusively at the configured identity provider; Pharmacy1OS never stores staff passwords.

The UI does not validate clinical licenses, statutory PIC designation, state intern/technician registration, or identity provider attestation. Those are separate production gates.

## Still required in Stage 3M

- Independent second-person authorization for privileged role assignments, temporary elevation, and sensitive high-risk actions.
- Controlled bootstrap of first production admin and PIC, segregation of admin vs licensed pharmacist duties, and documented global suspension/deprovisioning workflow.
- Reauthentication policy for risky changes, token refresh/revocation integration with the IdP, security events for denied requests, anomaly/rate-limit controls, audit integrity/retention policies.
- UI/automated browser testing of OIDC sign-in and staff lifecycle against a configured test IdP, plus accessibility and usability review.
- TLS/reverse-proxy threat model, secrets lifecycle/rotation, independent penetration/security review and formal readiness evidence.

**Production startup stays blocked by `assertRuntimeSafetyConfiguration()`.** This stage and all future stages are limited to synthetic data until the full compliance and release gates have been passed.
