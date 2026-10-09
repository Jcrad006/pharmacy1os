"""Bottle-specific immutable print snapshots and native print-request audit tests."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.label_printing import LabelPrintEvent, LabelPrintJob, LabelPrintService, SYNTHETIC_MARK
from pharmacy1os.lifecycle import LifecycleService
from pharmacy1os.models import Fill, Label, Prescription
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    outsider = svc.bootstrap_demo()["actors"]
    tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Test", "Printer")
    doc = svc.add_prescriber(tech, "Test", "Prescriber", "MD")
    drug = svc.add_drug(pharmacist, "Demo tablet", "10mg", "tablet")
    exp = (date.today()+timedelta(days=200)).isoformat()
    sources = []
    for n in (1, 2):
        ndc = f"00000-777{n}-11"
        product = svc.add_product(pharmacist, drug, ndc, f"DemoMfg{n}", f"Shape {n}")
        barcode = f"TEST-PRINT-{n}"
        svc.register_barcode(tech, product, barcode)
        svc.receive(tech, barcode, f"PRINT-LOT-{n}", exp, "100")
        sources.append((barcode, f"PRINT-LOT-{n}", ndc))
    rx = svc.add_prescription(tech, patient, doc, drug, "RX-PRINT-01",
                              "Once daily", "90", refills=0)
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx)
    return svc, a, outsider, rx, fill, sources, exp, LabelPrintService(svc)


def _prepared(env):
    svc, a, other, rx, fill, sources, exp, printer = env
    svc.scan_source(a["TECHNICIAN"], fill, sources[0][0], sources[0][1], exp, "60")
    svc.scan_source(a["TECHNICIAN"], fill, sources[1][0], sources[1][1], exp, "30")
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Synthetic"])
    return env


def test_each_bottle_has_immutable_distinct_job_and_correct_physical_label(env):
    svc, a, _, rx, fill, sources, exp, printer = _prepared(env)
    jobs = printer.list(a["TECHNICIAN"], fill)
    assert len(jobs) == 2
    assert [x["bottle_number"] for x in jobs] == [1, 2]
    assert all(j["status"] == "QUEUED" for j in jobs)
    first = printer.preview(a["TECHNICIAN"], jobs[0]["id"])
    second = printer.preview(a["TECHNICIAN"], jobs[1]["id"])
    assert SYNTHETIC_MARK in first and SYNTHETIC_MARK in second
    assert f"NDC: {sources[0][2]}" in first
    assert "QUANTITY: 60.000 / 90.000" in first
    assert "BOTTLE 1 OF 2" in first
    assert f"NDC: {sources[1][2]}" in second
    assert "QUANTITY: 30.000 / 90.000" in second
    assert "BOTTLE 2 OF 2" in second
    assert "Demo tablet 10mg" in first
    assert "RX-PRINT-01" in first
    with svc.sessions() as s:
        assert len(s.scalars(select(LabelPrintJob)).all()) == 2
        assert len(s.scalars(select(Label)).all()) == 2


def test_reprint_permission_idempotence_and_audit_are_separate_from_hardware(env):
    svc, a, _, rx, fill, sources, exp, printer = _prepared(env)
    job = printer.list(a["TECHNICIAN"], fill)[0]["id"]
    with pytest.raises(AccessDenied):
        printer.record_output_attempt(a["TECHNICIAN"], job, "R-1", "Printer jam")
    attempt = printer.record_output_attempt(a["PHARMACIST"], job, "R-1",
                                          "Printer jam", dialog_accepted=False)
    assert attempt
    assert printer.record_output_attempt(a["PHARMACIST"], job, "R-1",
                                          "Printer jam", dialog_accepted=False) == attempt
    with pytest.raises(WorkflowError, match="reused"):
        printer.record_output_attempt(a["PHARMACIST"], job, "R-1",
                                      "Different reason")
    native = printer.record_output_attempt(a["PHARMACIST"], job, "NATIVE-1",
                                           "Demo spool", dialog_accepted=True)
    with svc.sessions() as s:
        events = s.scalars(select(LabelPrintEvent)).all()
        assert len(events) == 2
        assert {e.event_kind for e in events} == {
            "TEST_REPRINT_REQUESTED", "NATIVE_DIALOG_ACCEPTED"
        }
        assert s.get(LabelPrintJob, job).status == "QUEUED"


def test_cannot_preview_foreign_or_voided_label_and_snapshot_integrity(env):
    svc, a, outsider, rx, fill, sources, exp, printer = _prepared(env)
    job = printer.list(a["TECHNICIAN"], fill)[0]["id"]
    with pytest.raises(WorkflowError, match="pharmacy site"):
        printer.preview(outsider["PHARMACIST"], job)
    with svc.sessions.begin() as s:
        s.get(LabelPrintJob, job).snapshot_json = '{"bad":"TAMPERED"}'
    with pytest.raises(WorkflowError, match="checksum mismatch"):
        printer.preview(a["TECHNICIAN"], job)


def test_returned_unsold_fill_voids_all_print_jobs_but_preserves_history(env):
    svc, a, outsider, rx, fill, sources, exp, printer = _prepared(env)
    jobs = printer.list(a["TECHNICIAN"], fill)
    svc.verify(a["PHARMACIST"], fill)
    svc.return_to_stock(a["PHARMACIST"], fill, "Patient rejected test fill")
    assert [j["status"] for j in printer.list(a["TECHNICIAN"], fill)] == ["VOIDED", "VOIDED"]
    with pytest.raises(WorkflowError, match="Voided"):
        printer.preview(a["TECHNICIAN"], jobs[0]["id"])
    with pytest.raises(WorkflowError, match="Active print job"):
        printer.record_output_attempt(a["PHARMACIST"], jobs[0]["id"], "R-1",
                                      "Try to reprint returned label")
    with svc.sessions() as s:
        assert len(s.scalars(select(LabelPrintJob)).all()) == 2
        assert s.get(Fill, fill).status == "RETURNED"


def test_cancelled_fill_invalidates_job_queue_and_no_auto_print(env):
    svc, a, outsider, rx, fill, sources, exp, printer = _prepared(env)
    LifecycleService(svc).cancel(a["TECHNICIAN"], rx, "Cancel synthetic prescription")
    assert all(x["status"] == "VOIDED" for x in printer.list(a["PHARMACIST"], fill))
    with svc.sessions() as s:
        assert len(s.scalars(select(LabelPrintEvent)).all()) == 0
        assert s.get(Prescription, rx).status == "CANCELLED"


def test_synthetic_preview_api_guard_and_reprint_authorization(env):
    svc, a, outsider, rx, fill, sources, exp, printer = _prepared(env)
    list_endpoint = f"/api/label-print-jobs/fills/{fill}"
    headers = {"x-demo-staff-id": a["TECHNICIAN"].id}
    closed = TestClient(create_app(svc, synthetic_enabled=False))
    assert closed.get(list_endpoint, headers=headers).status_code == 503
    api = TestClient(create_app(svc, synthetic_enabled=True))
    assert api.get(list_endpoint).status_code == 403
    response = api.get(list_endpoint, headers=headers)
    assert response.status_code == 200
    job = response.json()["jobs"][0]["id"]
    assert SYNTHETIC_MARK in api.get(
        f"/api/label-print-jobs/{job}/preview", headers=headers).json()["label_text"]
    assert api.get(list_endpoint,
        headers={"x-demo-staff-id": outsider["TECHNICIAN"].id}).status_code == 409
    url = f"/api/label-print-jobs/{job}/test-reprint"
    payload = {"request_key": "R-API", "reason": "Test printer failure"}
    assert api.post(url, json=payload, headers=headers).status_code == 403
    pharmacist = {"x-demo-staff-id": a["PHARMACIST"].id}
    result = api.post(url, json=payload, headers=pharmacist)
    assert result.status_code == 200
    assert result.json()["physical_print_verified"] is False


def test_scanned_lot_and_manufacturer_expiration_are_bound_to_each_bottle(env):
    svc, a, outsider, rx, fill, sources, exp, printer = _prepared(env)
    jobs = printer.list(a["TECHNICIAN"], fill)
    first, second = (
        printer.preview(a["TECHNICIAN"], job["id"]) for job in jobs
    )
    assert "SCANNED LOT: PRINT-LOT-1" in first
    assert "SCANNED LOT: PRINT-LOT-2" not in first
    assert "SCANNED LOT: PRINT-LOT-2" in second
    assert f"MANUFACTURER EXP: {exp}" in first
    assert f"MANUFACTURER EXP: {exp}" in second
    assert "PACKAGING: REPACKAGED / PRESCRIPTION CONTAINER" in first
    assert "PATIENT DISCARD DATE: PENDING_PHARMACIST_VERIFICATION" in second
    with svc.sessions() as session:
        snaps = [session.get(LabelPrintJob, job["id"]).snapshot_json for job in jobs]
    import json
    assert json.loads(snaps[0])["scanned_stock_id"] != json.loads(snaps[1])["scanned_stock_id"]


def test_original_manufacturer_container_status_frozen_into_label_preview(env):
    svc, a, outsider, rx, fill, sources, exp, printer = env
    svc.set_fill_packaging(a["TECHNICIAN"], fill,
        dispensed_in_original_container=True,
        note="The prescription is prepared in its original closed container")
    _prepared(env)
    jobs = printer.list(a["TECHNICIAN"], fill)
    previews = [printer.preview(a["TECHNICIAN"], job["id"]) for job in jobs]
    assert all("PACKAGING: ORIGINAL MANUFACTURER CONTAINER" in item
               for item in previews)
    assert all("ORIGINAL_CONTAINER_MANUFACTURER_EXPIRATION_APPLIES" in item
               for item in previews)
