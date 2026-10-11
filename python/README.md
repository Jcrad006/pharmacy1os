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

The opt-in network-boundary pilot uses `pharmacy1os-loopback-server` (localhost session API) and `pharmacy1os-loopback-desktop` (native Qt over authenticated HTTP; **no desktop DB access**). Both processes must run on the **same machine**. Increment 64 extends the pharmacist-reviewed, version-checked interface to **SIG, quantity and authorized refills in one audited edit**. It does not support general prescription mutation, dispensing or billing. The client refuses remote hosts; do not use with real patients. Requires an Alembic-migrated disposable synthetic database and an offline-enrolled synthetic account. See [Increment 62 walkthrough](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_62.md) [Increment 63 scope](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_63.md), and [Increment 64 scope](../docs/PYTHON_PARITY_PROGRESS_INCREMENT_64.md).

## Tests

```bash
cd python
python -m pytest -q
python -m compileall -q pharmacy1os
```

The F11 Supply Chain pane adds purchase orders, intersite transfers, cycle counting, and recall controls. It is not a replacement for the full existing inventory workflows or validated pharmacy device integrations. See `../docs/PYTHON_MIGRATION.md` for scope, unported workflows, limitations and release gates.
