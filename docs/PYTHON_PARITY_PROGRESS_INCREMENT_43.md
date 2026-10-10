# Python parity increment 43 — Third Party workbench and concurrent rebill safety

Continues [Increment 42](PYTHON_PARITY_PROGRESS_INCREMENT_42.md) on `python-native-rewrite`.
This narrows baseline **BL06–BL10 / UI Third Party** but is **not** complete endpoint/schema or live transaction parity.

## Functional changes
- New `ThirdPartyWorkspace.snapshot` offers a **single site-scoped read-only** view akin to original `GET /third-party/workspace`: patient search (first/last/phone), up to four ordered masked coverage positions, active/inactive synthetic payer profiles, unresolved **injected test holds**, recent append-only synthetic claim event summaries, unused synthetic print queue, and pending replacement/rebill attempts.
- Endpoint: `GET /api/third-party/workspace?query=...` in the opt-in FastAPI adapter, plus Third Party native Qt workbench overview. Search limited to 100 characters; patient count to 100, payer count 200, claim events 300, print jobs 100.
- Privacy: the aggregate view does not expose patient birthdates, payer BIN/PCN, group/person codes, raw member identifiers or full claim request/response bodies. **Synthetic paid** and **manually injected test rejection** are labeled explicitly, not conflated with insurer adjudication.
- New integration tests check search, masking, site boundaries, reader role, rejection resolution, print queue after preparation, disappearance after reversal, new replacement fill, synthetic API disablement and authorization.
- Added migrated PostgreSQL concurrency regression: two competing pharmacist rebill restarts must yield one linked replacement, one stock release, and one reversal event per payer. No duplicate payer events or reissued labels.

## Limitations
- This is not the original React Third Party view or exact Fastify DTO, nor actual rejection adjudication or auto-retry. The 300 most recent operations can omit earlier reversal context; all summaries are **advisory** rather than financial proof. The Qt overview is read-only with capped lists, not a full editable grid. Testing uses synthetic identities/records only.
- Do not process PHI, send payer requests, or merge PR #43 as a production release. Check Python and PostgreSQL Actions against this increment's final commit.
