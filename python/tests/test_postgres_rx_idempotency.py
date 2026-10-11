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
