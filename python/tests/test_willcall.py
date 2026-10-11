"""Synthetic Will Call custody and API regression coverage."""
from datetime import date, timedelta
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.models import WillCall
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError
from pharmacy1os.willcall import WillCallService, WillCallBarcodeRecord


@pytest.fixture
def scenario():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    patient = svc.add_patient(a["TECHNICIAN"], "Sample", "Customer")
    prescriber = svc.add_prescriber(a["TECHNICIAN"], "Sample", "Doctor", "MD")
    drug = svc.add_drug(a["PHARMACIST"], "FakeMed", "10 mg", "tablet")
    product = svc.add_product(a["PHARMACIST"], drug, "00000-0001-01", "Demo", "Tablet")
    svc.register_barcode(a["TECHNICIAN"], product, "FAKE-PRODUCT-1")
    expires = (date.today() + timedelta(days=300)).isoformat()
    svc.receive(a["TECHNICIAN"], "FAKE-PRODUCT-1", "ABC100", expires, "100")
    rx = svc.add_prescription(a["TECHNICIAN"], patient, prescriber, drug,
                              "WC-TEST-101", "Take daily", "30")
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    fill = svc.start_fill(a["TECHNICIAN"], rx)
    svc.scan_source(a["TECHNICIAN"], fill, "FAKE-PRODUCT-1", "ABC100", expires, "30")
    svc.prepare_for_review(a["TECHNICIAN"], fill, [])
    svc.verify(a["PHARMACIST"], fill)
    svc.stage_will_call(a["TECHNICIAN"], fill, "BIN-A", "BAG-OLD")
    return svc, a, fill, WillCallService(svc)


def test_rebag_history_and_irreversible_barcode_retirement(scenario):
    svc, a, fill, ops = scenario
    assert ops.rebag(a["TECHNICIAN"], fill, " bag-new ", "Damaged bag") == "BAG-NEW"
    assert ops.relocate(a["TECHNICIAN"], fill, "BIN-B", "Moved shelf") == "BIN-B"
    with svc.sessions() as s:
        records = s.scalars(select(WillCallBarcodeRecord)
                            .order_by(WillCallBarcodeRecord.barcode)).all()
        assert [(x.barcode, x.status) for x in records] == [
            ("BAG-NEW", "ACTIVE"), ("BAG-OLD", "RETIRED")]
        bag = s.scalar(select(WillCall).where(WillCall.fill_id == fill))
        assert (bag.bag_barcode, bag.bin_name) == ("BAG-NEW", "BIN-B")
    assert [x["kind"] for x in ops.history(a["AUDITOR"], fill)] == [
        "STAGED", "REBAGGED", "RELOCATED"]
    with pytest.raises(WorkflowError, match="assigned"):
        ops.rebag(a["TECHNICIAN"], fill, "BAG-OLD", "Attempt to recycle barcode")


def test_checkout_and_closed_barcode(scenario):
    svc, a, fill, ops = scenario
    ops.rebag(a["TECHNICIAN"], fill, "BAG-NEW", "New bag")
    with pytest.raises(WorkflowError, match="correct bag"):
        svc.sell(a["CASHIER"], fill, True, True, "1.00", "CASH", "BAG-OLD")
    svc.sell(a["CASHIER"], fill, True, True, "1.00", "CASH", "BAG-NEW")
    assert ops.history(a["AUDITOR"], fill)[-1]["kind"] == "SOLD"
    with svc.sessions() as s:
        state = s.scalar(select(WillCallBarcodeRecord).where(
            WillCallBarcodeRecord.barcode == "BAG-NEW"))
        assert state.status == "CLOSED"
    with pytest.raises(WorkflowError, match="ready, staged"):
        ops.relocate(a["TECHNICIAN"], fill, "BIN-C", "Already sold")


def test_authorization_site_isolation_and_reason(scenario):
    svc, a, fill, ops = scenario
    other = svc.bootstrap_demo()["actors"]
    with pytest.raises(AccessDenied):
        ops.rebag(a["CASHIER"], fill, "BAG-NEW", "Not authorized")
    with pytest.raises(WorkflowError, match="pharmacy site"):
        ops.rebag(other["TECHNICIAN"], fill, "BAG-NEW", "Wrong site")
    with pytest.raises(WorkflowError, match="pharmacy site"):
        ops.history(other["PHARMACIST"], fill)
    with pytest.raises(WorkflowError, match="reason"):
        ops.rebag(a["TECHNICIAN"], fill, "BAG-NEW", "")
    assert len(ops.history(a["AUDITOR"], fill)) == 1


def test_custody_api(scenario):
    svc, a, fill, ops = scenario
    client = TestClient(create_app(svc, synthetic_enabled=True))
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    cashier = {"x-demo-staff-id": a["CASHIER"].id}
    res = client.post(f"/api/will-call/fills/{fill}/rebag", headers=tech,
                      json={"new_barcode": "NEW-101", "reason": "Broken seal"})
    assert res.status_code == 200, res.text
    denied = client.post(f"/api/will-call/fills/{fill}/relocate", headers=cashier,
                         json={"new_bin": "BIN-C", "reason": "Unauthorized"})
    assert denied.status_code == 403
    history = client.get(f"/api/will-call/fills/{fill}/history", headers=cashier)
    assert history.status_code == 200
    assert [x["kind"] for x in history.json()["events"]] == ["STAGED", "REBAGGED"]


def test_legacy_staged_bag_custody_import(scenario):
    svc, a, fill, ops = scenario
    with svc.sessions.begin() as s:
        old = s.scalar(select(WillCallBarcodeRecord).where(
            WillCallBarcodeRecord.barcode == "BAG-OLD"))
        s.delete(old)
    ops.rebag(a["TECHNICIAN"], fill, "BAG-NEW", "Historical demo entry")
    with svc.sessions() as s:
        restored = s.scalar(select(WillCallBarcodeRecord).where(
            WillCallBarcodeRecord.barcode == "BAG-OLD"))
        assert restored.status == "RETIRED"


def test_failed_rebag_is_atomic(scenario):
    svc, a, fill, ops = scenario
    ops.rebag(a["TECHNICIAN"], fill, "BAG-NEW", "Replacement")
    before = ops.history(a["AUDITOR"], fill)
    with pytest.raises(WorkflowError):
        ops.rebag(a["TECHNICIAN"], fill, "BAG-OLD", "Reject reuse")
    assert before == ops.history(a["AUDITOR"], fill)
