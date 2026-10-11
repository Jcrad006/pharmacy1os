"""Real PostgreSQL reviewed-Rx receipt replay across competing sessions.

Only synthetic disposable PostgreSQL CI, never real pharmacy information.
"""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import select

from pharmacy1os.db_cli import revision_at_head
from pharmacy1os.models import Prescription
from pharmacy1os.prescription_edit import (
    PrescriptionEdit, PrescriptionEditRequest, PrescriptionEditService,
)
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def scenario():
    url = os.getenv("PHARMACY1OS_PG_CI_URL")
    if not url:
        pytest.skip("requires disposable PostgreSQL CI database")
    if not url.startswith("postgresql+psycopg://"):
        pytest.fail("PostgreSQL concurrency tests require psycopg")
    svc = PharmacyService(url)
    try:
        assert revision_at_head(svc.engine)
        actors = svc.bootstrap_demo()["actors"]
        tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
        person = svc.add_patient(tech, "Synthetic", "ConcurrentReview")
        provider = svc.add_prescriber(tech, "Synthetic", "Provider", "MD")
        drug = svc.add_drug(pharmacist, "IDEMPOTENCY-RX", "5mg", "tablet")
        rx = svc.add_prescription(tech, person, provider, drug,
                                  "SYNTHETIC-RECEIPT-PG", "Mock daily", "30")
        svc.advance_to_dur(tech, rx)
        yield svc, actors, rx
    finally:
        svc.engine.dispose()


def test_parallel_identical_uuid_returns_single_committed_rx_edit(scenario):
    svc, actors, rx = scenario
    pharmacist = actors["PHARMACIST"]
    editor = PrescriptionEditService(svc)
    key = str(uuid4())
    barrier = Barrier(2)
    note = "Two synthetic sessions intentionally send the same request key"

    def send():
        barrier.wait(timeout=15)
        return editor.update(pharmacist, rx,
            {"sig": "Updated mock sig", "quantity": "45"},
            expected_version=0, expected_status="DUR_REVIEW",
            attestation_note=note, request_id=key)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: send(), (1, 2)))
    assert responses[0] == responses[1]
    assert responses[0]["request_id"] == key
    assert responses[0]["version"] == 1
    with svc.sessions() as s:
        assert len(s.scalars(select(PrescriptionEdit).where(
            PrescriptionEdit.prescription_id == rx)).all()) == 1
        assert len(s.scalars(select(PrescriptionEditRequest).where(
            PrescriptionEditRequest.prescription_id == rx)).all()) == 1
        assert s.get(Prescription, rx).version == 1
    assert editor.request_status(pharmacist, rx, key)["state"] == "RECORDED"


def test_parallel_mismatched_uuid_reuse_rejected_without_second_edit(scenario):
    svc, actors, rx = scenario
    pharmacist = actors["PHARMACIST"]
    editor = PrescriptionEditService(svc)
    key = str(uuid4())
    gate = Barrier(2)

    def send(sig):
        gate.wait(timeout=15)
        try:
            return editor.update(pharmacist, rx,
                {"sig": sig}, expected_version=0, expected_status="DUR_REVIEW",
                attestation_note="Synthetic documented prescriber review",
                request_id=key)
        except WorkflowError as exc:
            return str(exc)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(send, ("Mock sig A", "Mock sig B")))
    saved = [x for x in outcomes if isinstance(x, dict)]
    blocked = [x for x in outcomes if isinstance(x, str)]
    assert len(saved) == 1 and len(blocked) == 1
    assert "reused with different content" in blocked[0]
    with svc.sessions() as s:
        assert len(s.scalars(select(PrescriptionEdit).where(
            PrescriptionEdit.prescription_id == rx)).all()) == 1
        assert len(s.scalars(select(PrescriptionEditRequest).where(
            PrescriptionEditRequest.prescription_id == rx)).all()) == 1
    assert editor.request_status(pharmacist, rx, key)["result"] == saved[0]


def test_parallel_status_hold_vs_cancel_obeys_row_lock_and_stale_version(scenario):
    """One concurrent terminal wins; no duplicate status side effects."""
    from pharmacy1os.lifecycle import LifecycleService
    from pharmacy1os.models import Audit

    svc, actors, rx = scenario
    lifecycle = LifecycleService(svc)
    with svc.sessions() as session:
        initial = session.get(Prescription, rx)
        before_status = initial.status
        before_version = initial.version
    assert before_status == "DUR_REVIEW"
    barrier = Barrier(2)

    def run(target):
        barrier.wait(timeout=15)
        try:
            if target == "ON_HOLD":
                lifecycle.hold(actors["TECHNICIAN"], rx,
                    "Synthetic documented hold after clinical request",
                    expected_version=before_version,
                    expected_status=before_status)
            else:
                lifecycle.cancel(actors["PHARMACIST"], rx,
                    "Synthetic documented cancellation before product fill",
                    expected_version=before_version,
                    expected_status=before_status)
            return "COMMITTED"
        except WorkflowError as exc:
            return str(exc)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(run, ("ON_HOLD", "CANCELLED")))
    assert outcomes.count("COMMITTED") == 1
    assert sum("changed on another workstation" in value for value in outcomes) == 1
    with svc.sessions() as session:
        current = session.get(Prescription, rx)
        assert current.version == before_version + 1
        assert current.status in ("ON_HOLD", "CANCELLED")
        history = session.scalars(select(Audit).where(
            Audit.subject_id == rx,
            Audit.kind.in_(("RX_HELD", "RX_CANCELLED")))).all()
        assert len(history) == 1
