"""Synthetic transfer-out handoff tests: no transport, site isolation, state safety."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.lifecycle import LifecycleService
from pharmacy1os.models import Drug, Fill, Prescription
from pharmacy1os.prescription_transfer import TransferOut, TransferService
from pharmacy1os.scheduling import SchedulingService
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "Person")
    prescriber = svc.add_prescriber(tech, "Synthetic", "Doctor", "MD")
    drug = svc.add_drug(pharmacist, "Simulated med", "10mg", "tablet")
    product = svc.add_product(pharmacist, drug, "12345-6789-00", "Synthetic", "Example tablet")
    svc.register_barcode(tech, product, "XFER-BAR")
    exp = (date.today()+timedelta(days=365)).isoformat()
    svc.receive(tech, "XFER-BAR", "LOT-X", exp, "180")
    rx = svc.add_prescription(tech, patient, prescriber, drug,
                              "TEST-TRANSFER", "daily", "30", refills=1)
    svc.advance_to_dur(tech, rx)
    return svc, a, outside, rx, drug, exp, TransferService(svc)


def _send(svc, actors, rx, exp):
    tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
    fid = svc.start_fill(tech, rx)
    svc.scan_source(tech, fid, "XFER-BAR", "LOT-X", exp, "30")
    svc.prepare_for_review(tech, fid, [])
    svc.verify(pharmacist, fid)
    svc.sell(tech, fid, True, True, "0", "CASH")
    return fid


def _request(flow, actor, rx, key="OUT-01"):
    return flow.request(actor, rx, "Receiving Development Pharmacy",
                        "555-0100", "Patient-requested transfer", key)


def test_request_then_pharmacist_attestation_moves_rx_and_preserves_original_sale(env):
    svc, a, outside, rx, drug, exp, transfers = env
    root = _send(svc, a, rx, exp)
    event = _request(transfers, a["TECHNICIAN"], rx)
    assert transfers.get(a["AUDITOR"], event)["status"] == "REQUESTED"
    assert transfers.get(a["AUDITOR"], event)["warning"] == "NO_EXTERNAL_TRANSFER_TRANSMISSION_PERFORMED"
    assert _request(transfers, a["TECHNICIAN"], rx) == event
    with pytest.raises(WorkflowError, match="reused"):
        transfers.request(a["TECHNICIAN"], rx, "Another pharmacy", "555-0100",
                          "Patient-requested transfer", "OUT-01")
    with pytest.raises(AccessDenied):
        transfers.attest_out(a["TECHNICIAN"], event,
            receiving_pharmacist="Receiving pharmacist", handoff_reference="PHONE-01",
            note="Confirmed outside", personally_confirmed=True)
    with pytest.raises(WorkflowError, match="attestation"):
        transfers.attest_out(a["PHARMACIST"], event,
            receiving_pharmacist="Receiving pharmacist", handoff_reference="PHONE-01",
            note="Not yet confirmed", personally_confirmed=False)
    with pytest.raises(WorkflowError, match="pharmacy site"):
        transfers.get(outside["PHARMACIST"], event)
    assert transfers.list(outside["AUDITOR"]) == []
    transfers.attest_out(a["PHARMACIST"], event,
        receiving_pharmacist="Receiving pharmacist", handoff_reference="PHONE-01",
        note="Contact confirmed by phone outside application", personally_confirmed=True)
    with svc.sessions() as s:
        assert s.get(Prescription, rx).status == "TRANSFERRED"
        assert s.get(Fill, root).status == "SOLD"
        assert s.scalar(select(TransferOut).where(TransferOut.id == event)).attested_by_id == a["PHARMACIST"].id
    with pytest.raises(WorkflowError, match="Only a requested"):
        transfers.attest_out(a["PHARMACIST"], event,
            receiving_pharmacist="Name", handoff_reference="Again", note="Again", personally_confirmed=True)
    with pytest.raises(WorkflowError, match="Only an unconfirmed"):
        transfers.withdraw(a["TECHNICIAN"], event, "Cannot undo acknowledged transfer")
    with pytest.raises(WorkflowError):
        SchedulingService(svc).begin_refill_review(a["TECHNICIAN"], rx, "Try to refill")


def test_pending_transfer_blocks_scheduling_and_active_refill_and_allows_withdrawal(env):
    svc, a, outside, rx, drug, exp, transfers = env
    _send(svc, a, rx, exp)
    event = _request(transfers, a["TECHNICIAN"], rx)
    with pytest.raises(WorkflowError, match="pending outgoing transfer"):
        SchedulingService(svc).schedule(a["TECHNICIAN"], rx,
                                      (date.today()+timedelta(days=5)).isoformat(), "SCHEDULE-X")
    with pytest.raises(WorkflowError, match="pending outgoing transfer"):
        SchedulingService(svc).begin_refill_review(a["TECHNICIAN"], rx, "Normal refill")
    with pytest.raises(WorkflowError, match="pending outgoing transfer"):
        LifecycleService(svc).cancel(a["TECHNICIAN"], rx, "Cannot cancel during handoff")
    transfers.withdraw(a["TECHNICIAN"], event, "Recipient no longer requests transfer")
    assert transfers.get(a["AUDITOR"], event)["status"] == "WITHDRAWN"
    SchedulingService(svc).begin_refill_review(a["TECHNICIAN"], rx, "New refill after withdrawal")
    refill = svc.start_fill(a["TECHNICIAN"], rx)
    assert refill
    with pytest.raises(WorkflowError, match="history already exists"):
        _request(transfers, a["TECHNICIAN"], rx, "RENEWED-TRANSFER")


def test_fail_closed_for_active_unreviewed_controlled_partial_and_no_refills(env):
    svc, a, outside, rx, drug, exp, transfers = env
    tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = True
    with pytest.raises(WorkflowError, match="Controlled"):
        _request(transfers, tech, rx)
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = False
    fid = svc.start_fill(tech, rx)
    with pytest.raises(WorkflowError, match="reviewed or previously sold"):
        _request(transfers, tech, rx)
    svc.scan_source(tech, fid, "XFER-BAR", "LOT-X", exp, "30")
    svc.prepare_for_review(tech, fid, [])
    svc.verify(pharmacist, fid)
    svc.sell(tech, fid, True, True, "0", "CASH")
    with svc.sessions.begin() as s:
        s.get(Prescription, rx).refills_allowed = 0
    with pytest.raises(WorkflowError, match="No remaining refills"):
        _request(transfers, tech, rx)


def test_transfer_rechecks_mutable_drug_and_refill_state_on_attestation(env):
    svc, a, outside, rx, drug, exp, transfers = env
    _send(svc, a, rx, exp)
    tid = _request(transfers, a["TECHNICIAN"], rx)
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = True
    with pytest.raises(WorkflowError, match="Controlled"):
        transfers.attest_out(a["PHARMACIST"], tid, receiving_pharmacist="Remote",
            handoff_reference="REF-1", note="Not allowable", personally_confirmed=True)
    with svc.sessions() as s:
        assert s.get(Prescription, rx).status == "SOLD"
        assert s.get(TransferOut, tid).status == "REQUESTED"
    with svc.sessions.begin() as s:
        s.get(Drug, drug).controlled = False
        s.get(Prescription, rx).refills_allowed = 0
    with pytest.raises(WorkflowError, match="No remaining refills"):
        transfers.attest_out(a["PHARMACIST"], tid, receiving_pharmacist="Remote",
            handoff_reference="REF-1", note="Not allowable", personally_confirmed=True)


def test_api_gated_and_idempotent_with_site_scoped_reads(env):
    svc, a, outside, rx, drug, exp, transfers = env
    _send(svc, a, rx, exp)
    route = "/api/prescription-transfers-out"
    payload = {"prescription_id": rx, "destination_name": "Other Pharmacy",
               "destination_phone": "555-0112", "reason": "Patient request",
               "request_key": "API-TRANS-01"}
    demo_headers = {"x-demo-staff-id": a["TECHNICIAN"].id}
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    assert disabled.post(route, json=payload, headers=demo_headers).status_code == 503
    api = TestClient(create_app(svc, synthetic_enabled=True))
    assert api.post(route, json=payload).status_code == 403
    response = api.post(route, json=payload, headers=demo_headers)
    assert response.status_code == 201
    assert response.json()["externally_sent"] is False
    tid = response.json()["id"]
    assert api.post(route, json=payload, headers=demo_headers).json()["id"] == tid
    assert api.get(route, headers={"x-demo-staff-id": outside["AUDITOR"].id}).json()["items"] == []
    assert api.get(f"{route}/{tid}", headers={"x-demo-staff-id": outside["AUDITOR"].id}).status_code == 409
    assert api.post(f"{route}/{tid}/attest",
        headers=demo_headers, json={"receiving_pharmacist": "Remote",
                                     "handoff_reference": "TEST", "note": "Sample",
                                     "personally_confirmed": True}).status_code == 403
    pharmacist_headers = {"x-demo-staff-id": a["PHARMACIST"].id}
    assert api.post(f"{route}/{tid}/attest",
        headers=pharmacist_headers, json={"receiving_pharmacist": "Remote",
                                     "handoff_reference": "TEST", "note": "Confirmed externally",
                                     "personally_confirmed": True}).status_code == 200
    assert api.get(f"{route}/{tid}", headers=demo_headers).json()["status"] == "ATTESTED_OUT"


def test_transfer_blocked_when_partial_owed(env):
    svc, a, outside, rx, drug, exp, transfers = env
    tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    fid = svc.start_fill(tech, rx, "10")
    svc.scan_source(tech, fid, "XFER-BAR", "LOT-X", exp, "10")
    svc.prepare_for_review(tech, fid, [])
    svc.verify(pharmacist, fid)
    svc.sell(tech, fid, True, True, "0", "CASH")
    with pytest.raises(WorkflowError, match="outstanding partial"):
        _request(transfers, tech, rx)
