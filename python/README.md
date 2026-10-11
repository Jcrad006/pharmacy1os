# Pharmacy1OS — native Python migration preview

**Synthetic development prototype only. Never enter real patient information, use live credentials or dispense drugs with this build.** The original TypeScript application remains the authoritative reference until parity, security and data migration validation are complete.

This Python package uses SQLAlchemy and FastAPI with an optional **native PySide6/Qt desktop interface**, with no Chromium/browser dependency for workstation navigation.

## Start

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[desktop,test]'
PHARMACY1OS_SYNTHETIC_DEMO=1 pharmacy1os-desktop
```

The desktop creates an isolated synthetic SQLite database in `~/.pharmacy1os/synthetic/pharmacy1os.sqlite3`. The API is a separate opt-in developer preview:

```bash
PHARMACY1OS_SYNTHETIC_DEMO=1 pharmacy1os-api
```

It listens only on `127.0.0.1:8008`; synthetic actor headers are **not authentication**.

## Separate-process synthetic loopback workstation (limited reviewed edits)

The opt-in network-boundary pilot uses `pharmacy1os-loopback-server` (localhost session API) and `pharmacy1os-loopback-desktop` (native Qt over authenticated HTTP; **no desktop DB access**). Both processes must run on the **same machine**. Increment 64 extends the pharmacist-reviewed, version-checked interface to **SIG, quantity and authorized refills in one audited edit**. It does not support general prescription mutation, dispensing or billing. The client refuses remote hosts; do not use with real patients. Requires an Alembic-migrated disposable synthetic database and an offline-enrolled synthetic account. See [Increment 62 walkthrough](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_62.md), [Increment 63](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_63.md), [Increment 64](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_64.md), and [Increment 65 request-id recovery](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_65.md) and [Increment 66 protected workstation journal](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_66.md), and [Increment 67 nonblocking receipt recovery](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_67.md). Reviewed edits now receive a persistent server receipt keyed by a synthetic UUIDv4; a local encrypted, metadata-only journal preserves unconfirmed request IDs across Linux/macOS workstation restarts. The desktop checks server receipts on a Qt worker without blocking the native UI or automatically retrying edits. Increment 68 also runs native prescription queue, detail, audit, edit-context and reviewed-edit PATCH operations on a separate Qt network worker, keeping the GUI responsive during synthetic service delays. Startup sign-in and exit logout were moved to Qt workers in Increment 69. See [Increment 68](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_68.md). [Increment 69](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_69.md) moves the synthetic sign-in dialog and workstation-exit logout to Qt workers and blanks displayed Rx records when the session expires. The journal requires a private 0700 directory (including its ~/.pharmacy1os/synthetic parents) and never accepts real pharmacy data.

## TypeScript-to-Python endpoint parity inventory (Increment 70)

The original Fastify baseline is frozen at 116 method/path registrations from 16 modules in `parity/fastify_routes_baseline.json`. Generate a crosswalk from the **actual registered** Python API routes (structural method/path comparison only):

```bash
cd python
python -m pharmacy1os.parity_inventory > original_python_route_crosswalk.json
python -m pytest -q tests/test_fastify_endpoint_manifest.py tests/test_original_health_contract.py
```

Matching paths do **not** establish identical request bodies, roles, responses or workflow semantics. [Increment 71](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_71.md) adds a deliberately restricted, documented/versioned subset of the original Rx status-transition PATCH (hold, cancellation, exact resume only); other transitions continue to require dedicated, safer workflows. Increment 70 also corrected `GET /health` to return HTTP 503 for database failure or an unresolved synthetic document recovery marker. See [Increment 70 technical report](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_70.md).

## Tests

```bash
cd python
python -m pytest -q
python -m compileall -q pharmacy1os
```

The F11 Supply Chain pane adds purchase orders, intersite transfers, cycle counting, and recall controls. It is not a replacement for the full existing inventory workflows or validated pharmacy device integrations. See `../docs/PYTHON_MIGRATION.md` for scope, unported workflows, limitations and release gates.
