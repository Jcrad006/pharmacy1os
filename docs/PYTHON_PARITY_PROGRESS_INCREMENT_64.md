# Python parity Increment 64 — reviewed multi-field native workstation

**Development date:** October 10, 2026. Follows [Increment 63](PYTHON_PARITY_PROGRESS_INCREMENT_63.md) and the [October 10 audit](PYTHON_PARITY_AUDIT_2026-10-10.md). Synthetic development only, draft PR #43.

## Delivered

1. The separate-process PySide6 workstation now allows a pharmacist or administrator to review **SIG, quantity and refills authorized** together. Only changed values are submitted; a source quantity of 30.000 and a proposed 30 are treated as equal. Every review requires an attestation of 12–2000 characters, a fresh version/status preflight and a confirmation dialog.
2. The HTTP client still accepts exactly one controlled mutation endpoint (`PATCH /api/prescriptions/{rx_id}`). Every request must include an edit version, original review status and review attestation; the payload contains only an allowlisted subset of `sig`, `quantity`, `refills_allowed`. The separate `remote_review_fields.py` validator rejects unknown fields, booleans where whole refill numbers are expected, negative/zero/scientific quantity forms, >3 fractional decimal places and empty directions. The caller cannot use this transport to modify source/eRx, selected drugs/products, prescribers, stock, insurance, claims or dispensing.
3. The existing server-side `PrescriptionEditService.update` remains authoritative. A single DB transaction checks site-scoped pharmacist permissions, current version **and** workflow status under the prescription row lock, absence of physical fill history, absence of pending schedule/transfer, and clinical value rules before writing all changes and one audit event. It resets DUR Review appropriately. The desktop does not open the database.
4. The client checks the server response for a precisely incremented version and exactly the acknowledged edited fields. An unknown or lost response is **never retried automatically**. The separate read-only `inspect_uncertain_edit` displays current version, status and redacted audit actions, explicitly marked `MANUAL_REVIEW_REQUIRED_NOT_PROOF_OF_COMMIT`. The snapshot does not claim the operator's request succeeded.
5. New regression tests drive the actual loopback API through two separately authenticated workstation sessions: multi-field changes saved together, stale second-window refusal and a single versioned edit record; invalid and disallowed fields fail before HTTP; unauthorized staff and cross-site changes fail at the server; a deliberately lost response after server commit requires readback and rejects stale replay.

## Still missing

The multi-field preview is not the complete original TypeScript editor or a production multi-workstation deployment. It stays on 127.0.0.1 with synthetic staff credentials and fictional records. Further work includes persistently idempotent server-side request IDs; crash/reconnect and PostgreSQL cross-process races; all original 116-route and 58-model contract/crosswalk checks; remaining field and GUI parity; printer and barcode hardware; verified real network/TLS; regulatory security and actual claim/eRx adapters.

**Do not use this build with patient information or for actual dispensing.**
