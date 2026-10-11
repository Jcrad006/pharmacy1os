"""Original PATCH /prescriptions/:id/status: guarded synthetic subset only.

This does not provide Fastify's complete transition graph. It proves that
unsafe lifecycle shortcuts cannot bypass existing fill, verification and POS.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.models import Audit, Prescription
from pharmacy1os.service import PharmacyService


@pytest.fixture
def env(tmp_path):
    service = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'status-contract.sqlite3'}")
    service.create_schema()
    primary = service.bootstrap_demo()["actors"]
    secondary = service.bootstrap_demo()["actors"]
    tech, pharmacist = primary["TECHNICIAN"], primary["PHARMACIST"]
    patient = service.add_patient(tech, "Synthetic", "StatusPatient")
    prescriber = service.add_prescriber(tech, "Synthetic", "Prescriber", "MD")
    medication = service.add_drug(pharmacist, "Synthetic Noncontrolled", "10mg", "tablet")
    rx_id = service.add_prescription(
        tech, patient, prescriber, medication, "SYNTHETIC-TRANSITION-71",
        "Fake directions", "30")
    client = TestClient(create_app(service, synthetic_enabled=True))
    yield service, primary, secondary, rx_id, client
    service.engine.dispose()


def headers(actor):
    return {"x-demo-staff-id": actor.id}


def patch(client, rx_id, actor, target, expected, version, reason="Fictional documented transition request"):
    return client.patch(
        f"/api/prescriptions/{rx_id}/status",
        headers=headers(actor),
        json={"status": target, "expected_status": expected,
              "expected_version": version, "reason": reason})


def persisted(service, rx_id):
    with service.sessions() as s:
        rx = s.get(Prescription, rx_id)
        return (rx.status, rx.held_from, rx.version)


def transition_events(service, rx_id):
    with service.sessions() as s:
        return s.scalars(select(Audit).where(
            Audit.subject_id == rx_id,
            Audit.kind.in_(("RX_HELD", "RX_RESUMED", "RX_CANCELLED")))).all()


def test_versioned_hold_exact_resume_and_cancel_are_atomic_and_audited(env):
    service, actors, other, rx, client = env
    tech = actors["TECHNICIAN"]
    assert persisted(service, rx) == ("DATA_ENTRY", None, 0)

    on_hold = patch(client, rx, tech, "ON_HOLD", "DATA_ENTRY", 0)
    assert on_hold.status_code == 200, on_hold.text
    payload = on_hold.json()["prescription"]
    assert payload["status"] == "ON_HOLD"
    assert payload["heldFromStatus"] == "DATA_ENTRY"
    assert payload["allowedTransitions"] == [
        "DATA_ENTRY", "CANCELLED", "TRANSFERRED",
    ]
    # This is a UI advisory, not permission to use the generic PATCH to
    # transfer the prescription or bypass its dedicated transfer workflow.
    assert payload["version"] == 1
    assert persisted(service, rx) == ("ON_HOLD", "DATA_ENTRY", 1)

    # An old browser should not overwrite the newer transaction.
    stale = patch(client, rx, tech, "CANCELLED", "DATA_ENTRY", 0)
    assert stale.status_code == 409
    assert persisted(service, rx) == ("ON_HOLD", "DATA_ENTRY", 1)

    bad_resume = patch(client, rx, tech, "DUR_REVIEW", "ON_HOLD", 1)
    assert bad_resume.status_code == 409
    assert persisted(service, rx) == ("ON_HOLD", "DATA_ENTRY", 1)

    resumed = patch(client, rx, tech, "DATA_ENTRY", "ON_HOLD", 1)
    assert resumed.status_code == 200
    assert resumed.json()["prescription"]["heldFromStatus"] is None
    assert persisted(service, rx) == ("DATA_ENTRY", None, 2)

    cancelled = patch(client, rx, tech, "CANCELLED", "DATA_ENTRY", 2)
    assert cancelled.status_code == 200
    assert persisted(service, rx) == ("CANCELLED", None, 3)
    assert patch(client, rx, tech, "CANCELLED", "CANCELLED", 3).status_code == 409
    assert len(transition_events(service, rx)) == 3


def test_unsafe_generic_status_transitions_are_never_directly_exposed(env):
    service, actors, _, rx, client = env
    pharmacist = actors["PHARMACIST"]
    for target in ("DUR_REVIEW", "PRODUCT_FILL", "PHARMACIST_REVIEW",
                   "READY", "SOLD", "TRANSFERRED", "RECEIVED", "DATA_ENTRY"):
        response = patch(client, rx, pharmacist, target, "DATA_ENTRY", 0)
        assert response.status_code == 409, (target, response.text)
        assert persisted(service, rx) == ("DATA_ENTRY", None, 0)
    assert not transition_events(service, rx)


def test_unsupported_or_undocumented_payloads_fail_before_any_write(env):
    service, actors, _, rx, client = env
    tech = actors["TECHNICIAN"]
    path = f"/api/prescriptions/{rx}/status"
    invalid_payloads = [
        {"status": "ON_HOLD"},
        {"status": "ON_HOLD", "expected_status": "DATA_ENTRY",
         "expected_version": 0},
        {"status": "ON_HOLD", "expected_status": "DATA_ENTRY",
         "expected_version": True, "reason": "Fictional review is documented"},
        {"status": "ON_HOLD", "expected_status": "DATA_ENTRY",
         "expected_version": -1, "reason": "Fictional review is documented"},
        {"status": "ON_HOLD", "expected_status": "DATA_ENTRY",
         "expected_version": 0, "reason": "too short"},
        {"status": "ON_HOLD", "expected_status": "DATA_ENTRY",
         "expected_version": 0, "reason": "Fictional review is documented",
         "force_complete": True},
    ]
    for payload in invalid_payloads:
        response = client.patch(path, json=payload, headers=headers(tech))
        assert response.status_code == 422, (payload, response.text)
    assert persisted(service, rx) == ("DATA_ENTRY", None, 0)


def test_site_and_role_permissions_are_checked_before_state_mutation(env):
    service, actors, other, rx, client = env
    assert patch(client, rx, actors["AUDITOR"],
                 "ON_HOLD", "DATA_ENTRY", 0).status_code == 403
    # Nonmember site must not mutate or obtain Rx details via compatibility API.
    assert patch(client, rx, other["PHARMACIST"],
                 "ON_HOLD", "DATA_ENTRY", 0).status_code == 409
    no_identity = client.patch(f"/api/prescriptions/{rx}/status", json={
        "status": "ON_HOLD", "reason": "Fictional reviewer note submitted",
        "expected_status": "DATA_ENTRY", "expected_version": 0})
    assert no_identity.status_code == 403
    assert persisted(service, rx) == ("DATA_ENTRY", None, 0)


def test_stale_status_rejected_even_when_version_matches(env):
    service, actors, _, rx, client = env
    wrong = patch(client, rx, actors["TECHNICIAN"],
                  "ON_HOLD", "DUR_REVIEW", 0)
    assert wrong.status_code == 409
    assert persisted(service, rx) == ("DATA_ENTRY", None, 0)


def test_original_fastify_status_route_is_explicitly_partial(env):
    # The original accepts a status-only body and more transitions. This
    # defensive Python variant REQUIRES note/stale guards and rejects shortcuts.
    service, actors, _, rx, client = env
    assert client.patch(f"/api/prescriptions/{rx}/status",
                        headers=headers(actors["TECHNICIAN"]),
                        json={"status": "ON_HOLD"}).status_code == 422
    assert persisted(service, rx) == ("DATA_ENTRY", None, 0)


def test_camel_case_preconditions_supported_without_plain_status_shortcut(env):
    svc, actors, _, rx, client = env
    response = client.patch(
        f"/api/prescriptions/{rx}/status",
        headers=headers(actors["TECHNICIAN"]),
        json={
            "status": "ON_HOLD",
            "reason": "Synthetic verified clinical hold reason",
            "expectedStatus": "DATA_ENTRY",
            "expectedVersion": 0,
        })
    assert response.status_code == 200, response.text
    assert response.json()["prescription"]["version"] == 1
    assert persisted(svc, rx) == ("ON_HOLD", "DATA_ENTRY", 1)


def test_ready_to_sold_and_review_to_ready_cannot_bypass_dedicated_workflows(env):
    svc, actors, _, rx, client = env
    for current, target in (
        ("READY", "SOLD"),
        ("PHARMACIST_REVIEW", "READY"),
        ("PRODUCT_FILL", "PHARMACIST_REVIEW"),
    ):
        # Synthetic setup deliberately simulates a stale/unverified database
        # status without constructing a completed bill, claim, or physical fill.
        with svc.sessions.begin() as session:
            record = session.get(Prescription, rx)
            record.status = current
            record.version += 1
            version = record.version
        denied = patch(client, rx, actors["PHARMACIST"],
                       target, current, version)
        assert denied.status_code == 409, (current, target, denied.text)
        assert persisted(svc, rx) == (current, None, version)
    assert not transition_events(svc, rx)
