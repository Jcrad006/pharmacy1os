"""Executable structural inventory of original Fastify and Python API routes.

This is *only* HTTP verb/path registration parity. A route counted as mapped
may still have incompatible bodies, authorization, side effects and clinical
rules. Never equate structural matches with functional readiness.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

from fastapi.routing import APIRoute

ORIGINAL_METHODS = ("get", "post", "put", "patch", "delete")
FASTIFY_ROUTE_RE = re.compile(
    r"""\bapp\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']""")
BRACED_PARAMETER_RE = re.compile(r"\{[^}]+\}")
COLON_PARAMETER_RE = re.compile(r":[A-Za-z][A-Za-z0-9_]*")
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
INVENTORY_PATH = REPOSITORY_ROOT / "python" / "parity" / "fastify_routes_baseline.json"
ORIGINAL_ROUTES = REPOSITORY_ROOT / "apps" / "api" / "src" / "routes"


def signature(method: str, path: str, *, python: bool = False) -> str:
    """Convert different placeholder spellings into structural endpoints."""
    if python and path.startswith("/api/"):
        path = path[4:]
    elif python and path == "/api":
        path = "/"
    path = BRACED_PARAMETER_RE.sub("{}", path)
    path = COLON_PARAMETER_RE.sub("{}", path)
    return f"{method.upper()} {path}"


def inventory_original() -> tuple[dict, list[dict]]:
    frozen = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
    if frozen.get("schema") != 1 or frozen.get("route_count") != 116:
        raise ValueError("Original Fastify manifest has an unexpected version or size")
    snapshots = frozen.get("routes")
    if not isinstance(snapshots, list) or len(snapshots) != 116:
        raise ValueError("Original route snapshot is missing endpoints")
    source_names = sorted({x["source"] for x in snapshots})
    if len(source_names) != 16:
        raise ValueError("Original route file inventory changed")
    registrations = []
    for name in source_names:
        filename = ORIGINAL_ROUTES / name
        if not filename.is_file():
            raise ValueError(f"Missing reference route source: {name}")
        source = filename.read_text(encoding="utf-8")
        for match in FASTIFY_ROUTE_RE.finditer(source):
            registrations.append({
                "method": match.group(1).upper(),
                "path": match.group(2),
                "source": name,
            })
    keys = [(x["method"], x["path"]) for x in registrations]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate TypeScript route signatures in baseline")
    sort_key = lambda x: (x["source"], x["method"], x["path"])
    if sorted(registrations, key=sort_key) != sorted(snapshots, key=sort_key):
        raise ValueError("Original TypeScript registrations diverge from frozen endpoint baseline")
    return frozen, registrations


def inventory_python(app) -> list[dict]:
    results = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(route.methods or ()):
            if method in ("HEAD", "OPTIONS"):
                continue
            results.append({"method": method, "path": route.path})
    return results


def structural_report(app) -> dict:
    frozen, original = inventory_original()
    python_routes = inventory_python(app)
    python_signatures = {signature(x["method"], x["path"], python=True)
                         for x in python_routes}
    original_signatures = {signature(x["method"], x["path"]) for x in original}
    compared = []
    for entry in original:
        sig = signature(entry["method"], entry["path"])
        compared.append({
            **entry,
            "structural_signature": sig,
            "status": "PATH_AND_METHOD_ONLY" if sig in python_signatures
                      else "NO_SAME_PATH_METHOD",
        })
    return {
        "reference_sha": frozen["baseline_ref"],
        "typescript_routes": len(original),
        "python_routes": len(python_routes),
        "path_method_matches": sum(x["status"] == "PATH_AND_METHOD_ONLY"
                                   for x in compared),
        "unmatched_original_routes": sum(x["status"] == "NO_SAME_PATH_METHOD"
                                         for x in compared),
        "python_only_signatures": sorted(python_signatures - original_signatures),
        "routes": compared,
        "scope": "STRUCTURAL_ONLY_NOT_BEHAVIORAL_OR_PRODUCTION_PARITY",
    }


def main() -> None:
    from .api import create_app
    from .service import PharmacyService
    service = PharmacyService()
    try:
        report = structural_report(create_app(service, synthetic_enabled=False))
        print(json.dumps(report, sort_keys=True, indent=2))
    finally:
        service.engine.dispose()


if __name__ == "__main__":
    main()
