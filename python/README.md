# Pharmacy1OS Python-native rewrite — first migration slice

This source is the beginning of a **Python reimplementation**, not a completed full rewrite.

- `python/pharmacy1os/` — SQLAlchemy model, transactional synthetic pharmacy service, FastAPI adapter and native PySide6 desktop.
- `python/tests/` — synthetic dispensing and safety test cases.
- `docs/PYTHON_MIGRATION.md` — architecture, run instructions, module coverage, critical gaps and release gates.

**Safety:** synthetic development data only. Do not use in a pharmacy, with PHI, or for live insurance adjudication.

Run: `cd python && pip install -e '.[desktop,test]' && PHARMACY1OS_SYNTHETIC_DEMO=1 pharmacy1os-desktop`. Tests: `pytest -q`.