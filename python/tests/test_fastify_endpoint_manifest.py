"""Differential TypeScript/FastAPI route registration tests.

Structural matching is deliberately *not* declared behavioral/clinical parity.
The immutable 116-route Fastify source snapshot is checked on every CI run.
"""
from pharmacy1os.api import create_app
from pharmacy1os.parity_inventory import (
    inventory_original, inventory_python, signature, structural_report,
)
from pharmacy1os.service import PharmacyService


def test_original_main_contains_all_116_expected_fastify_routes():
    frozen, routes = inventory_original()
    assert frozen["route_count"] == 116
    assert len(routes) == 116
    assert len({(r["method"], r["path"]) for r in routes}) == 116
    assert len({r["source"] for r in routes}) == 16
    assert frozen["baseline_ref"] == "1c7ae6e2e21288f1d95c69d53de99674180bd594"


def test_route_parameter_matching_is_only_structural():
    assert signature("GET", "/prescriptions/:id/audit") == (
        signature("GET", "/api/prescriptions/{rx_id}/audit", python=True))
    assert signature("POST", "/receiving/scan") == (
        signature("POST", "/api/receiving/scan", python=True))
    assert signature("GET", "/prescriptions/:id") != signature(
        "PATCH", "/api/prescriptions/{rx_id}", python=True)


def test_python_inventory_identifies_matched_and_unmatched_original_signatures():
    svc = PharmacyService()
    try:
        app = create_app(svc, synthetic_enabled=False)
        report = structural_report(app)
        assert report["typescript_routes"] == 116
        assert report["scope"] == "STRUCTURAL_ONLY_NOT_BEHAVIORAL_OR_PRODUCTION_PARITY"
        assert report["unmatched_original_routes"] + report["path_method_matches"] == 116
        statuses = {(row["method"], row["path"]): row["status"]
                    for row in report["routes"]}
        for known in (
            ("GET", "/health"),
            ("GET", "/patients"),
            ("POST", "/patients"),
            ("GET", "/prescribers"),
            ("POST", "/prescribers"),
            ("GET", "/prescriptions/queue"),
            ("GET", "/prescriptions/:id"),
            ("GET", "/prescriptions/:id/audit"),
        ):
            assert statuses[known] == "PATH_AND_METHOD_ONLY", known
        # These original platform administration endpoints have no validated
        # original-compatible Python HTTP counterpart yet. Future updates
        # should change this status only with matching registration and tests.
        assert statuses[("GET", "/system/backups")] == "NO_SAME_PATH_METHOD"
        assert statuses[("POST", "/system/document-vault/integrity-scan")] == (
            "NO_SAME_PATH_METHOD")
        assert report["path_method_matches"] > 10
        assert report["unmatched_original_routes"] > 0
        assert len(inventory_python(app)) == report["python_routes"]
    finally:
        svc.engine.dispose()
