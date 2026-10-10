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

## Tests

```bash
cd python
python -m pytest -q
python -m compileall -q pharmacy1os
```

The F11 Supply Chain pane adds purchase orders, intersite transfers, cycle counting, and recall controls. It is not a replacement for the full existing inventory workflows or validated pharmacy device integrations. See `../docs/PYTHON_MIGRATION.md` for scope, unported workflows, limitations and release gates.
