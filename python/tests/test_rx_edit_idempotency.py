"""Persistent reviewed-edit request identity and immutable-result replay.

No external pharmacy transactions or real patient data are involved.
"""
from uuid import uuid4

import pytest
from sqlalchemy import select

from pharmacy1os.models import Prescription
from pharmacy1os.prescription_edit import (
    PrescriptionEdit, PrescriptionEditRequest, PrescriptionEditService,
)
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def fixture(tmp_path):
    db = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'rx-receipts.sqlite3'}")
    db.create_schema()
    actors = db.bootstrap_demo()["actors"]
    tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = db.add_patient(tech, "Fictional", "Idempotent")
    prescriber = db.add_prescriber(tech, "Fictional", "Doctor", "MD")
    drug = db.add_drug(pharmacist, "SYNTHETIC-REVIEW", "10mg", "tablet")
    rx = db.add_prescription(tech, patient, prescriber, drug,
                             "RX-RECEIPT", "Original mock directions", "30")
    yield db, actors, rx, PrescriptionEditService(db)
    db.engine.dispose()


def test_same_idempotent_request_replays_original_response_after_status_change(fixture):
    db, actors, rx, editor = fixture
    key = str(uuid4())
    pharm = actors["PHARMACIST"]
    note = "Reviewed independent synthetic source and documented change"
    result = editor.update(pharm, rx,
        {"sig": "Revised synthetic instructions", "quantity": "45"},
        0, note, expected_status="DATA_ENTRY", request_id=key)
    assert result["request_id"] == key
    assert result["version"] == 1 and result["status"] == "DATA_ENTRY"
    # Advancing the workflow should not erase the receipt or change replay data.
    db.advance_to_dur(actors["TECHNICIAN"], rx)
    replay = editor.update(pharm, rx,
        {"sig": "Revised synthetic instructions", "quantity": "45"},
        0, note, expected_status="DATA_ENTRY", request_id=key)
    assert replay == result
    status = editor.request_status(pharm, rx, key)
    assert status == {"state": "RECORDED", "request_id": key, "result": result}
    with db.sessions() as s:
        assert s.query(PrescriptionEdit).filter_by(prescription_id=rx).count() == 1
        assert s.query(PrescriptionEditRequest).filter_by(prescription_id=rx).count() == 1
        assert s.get(Prescription, rx).version == 1


def test_idempotent_token_rejects_changed_payload_and_different_author(fixture):
    db, actors, rx, editor = fixture
    key = str(uuid4())
    pharm = actors["PHARMACIST"]
    note = "Verified fictitious review documentation at the site"
    result = editor.update(pharm, rx, {"sig": "Different mock directions"},
                           0, note, expected_status="DATA_ENTRY", request_id=key)
    with pytest.raises(WorkflowError, match="reused"):
        editor.update(pharm, rx, {"sig": "Modified retry payload"},
                      0, note, expected_status="DATA_ENTRY", request_id=key)
    with pytest.raises(WorkflowError, match="reused"):
        editor.update(actors["ADMIN"], rx, {"sig": "Different mock directions"},
                      0, note, expected_status="DATA_ENTRY", request_id=key)
    with pytest.raises(WorkflowError, match="not found"):
        editor.request_status(actors["ADMIN"], rx, key)
    with pytest.raises(WorkflowError, match="reused"):
        editor.update(pharm, rx, {"sig": "Different mock directions"},
                      0, note + " extra", expected_status="DATA_ENTRY", request_id=key)
    assert editor.request_status(pharm, rx, key)["result"] == result


def test_failed_review_never_creates_a_committed_request_receipt(fixture):
    db, actors, rx, editor = fixture
    key = str(uuid4())
    pharm = actors["PHARMACIST"]
    assert editor.request_status(pharm, rx, key) == {
        "state": "NOT_RECORDED", "request_id": key, "safe_to_retry": False,
    }
    with pytest.raises(WorkflowError, match="no changed values"):
        editor.update(pharm, rx, {"sig": "Original mock directions"}, 0,
            "Deliberately unchanged synthetic prescription edit",
            expected_status="DATA_ENTRY", request_id=key)
    with db.sessions() as s:
        assert s.scalar(select(PrescriptionEditRequest).where(
            PrescriptionEditRequest.request_id == key)) is None
        assert s.scalar(select(PrescriptionEdit).where(
            PrescriptionEdit.prescription_id == rx)) is None
    result = editor.update(pharm, rx, {"sig": "Validated review content"}, 0,
        "Now independently confirmed in fictional environment",
        expected_status="DATA_ENTRY", request_id=key)
    assert result["request_id"] == key
    assert editor.request_status(pharm, rx, key)["state"] == "RECORDED"


def test_receipt_checksum_integrity_and_wrong_key_are_fail_closed(fixture):
    db, actors, rx, editor = fixture
    key = str(uuid4())
    pharm = actors["PHARMACIST"]
    editor.update(pharm, rx, {"quantity": "60"}, 0,
        "Synthetic source confirmed for prescription quantity update",
        expected_status="DATA_ENTRY", request_id=key)
    with db.sessions.begin() as s:
        receipt = s.scalar(select(PrescriptionEditRequest).where(
            PrescriptionEditRequest.request_id == key))
        receipt.response_json = '{"version":999,"corrupted":true}'
    with pytest.raises(WorkflowError, match="integrity failure"):
        editor.request_status(pharm, rx, key)
    for bad in ("", "not-uuid", str(uuid4()).upper(), "00000000-0000-0000-0000-000000000000"):
        with pytest.raises(WorkflowError, match="UUIDv4"):
            editor.request_status(pharm, rx, bad)
