"""InventoryDemand synthetic stock forecasting, lifecycle and site security."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_demands import InventoryDemandService
from pharmacy1os.inventory_demand_models import InventoryDemand, InventoryDemandEvent
from pharmacy1os.inventory_ops import InventoryService
from pharmacy1os.lifecycle import LifecycleService
from pharmacy1os.fill_completion import FillCompletionService
from pharmacy1os.models import Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    foreign = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    drug = svc.add_drug(pharm, "SYNTH Demand Medication", "10mg", "tablet")
    p1 = svc.add_product(pharm, drug, "40000-0101-01", "Demo", "Synthetic blue tablets")
    p2 = svc.add_product(pharm, drug, "40000-0101-02", "Demo", "Synthetic white tablets")
    svc.register_barcode(tech, p1, "DEMAND-BC-1")
    svc.register_barcode(tech, p2, "DEMAND-BC-2")
    expiry = (date.today() + timedelta(days=180)).isoformat()
    patient1 = svc.add_patient(tech, "Synthetic", "DemandFirst")
    patient2 = svc.add_patient(tech, "Synthetic", "DemandSecond")
    prescriber = svc.add_prescriber(tech, "Synthetic", "DemandDoctor", "MD")
    return svc, actors, foreign, drug, p1, p2, expiry, patient1, patient2, prescriber, InventoryDemandService(svc)


def create_fill(env, patient_index=0, qty="20", suffix="1", *, directive="UNSPECIFIED", product_id=None):
    svc, actors, _, drug, p1, p2, expiry, patient1, patient2, prescriber, demands = env
    patient = (patient1, patient2)[patient_index]
    rx = svc.add_prescription(actors["TECHNICIAN"], patient, prescriber, drug,
        f"DEMAND-RX-{suffix}", "once daily", qty,
        product_selection_directive=directive, prescribed_product_id=product_id)
    svc.advance_to_dur(actors["TECHNICIAN"], rx)
    return rx, svc.start_fill(actors["TECHNICIAN"], rx)


def demand_for_fill(env, fill):
    return next(x for x in env[-1].list(env[1]["AUDITOR"]) if x["fill_id"] == fill)


def test_demand_created_at_fill_and_fifo_does_not_double_count_available_units(env):
    svc, a, foreign, drug, p1, p2, expiry, patient1, patient2, doctor, directory = env
    svc.receive(a["TECHNICIAN"], "DEMAND-BC-1", "LOT1", expiry, "25")
    rx1, f1 = create_fill(env, qty="20", suffix="A")
    rx2, f2 = create_fill(env, patient_index=1, qty="20", suffix="B")
    first = demand_for_fill(env, f1)
    second = demand_for_fill(env, f2)
    assert first["required_quantity"] == "20.000"
    assert first["status"] == "READY"
    assert first["available_quantity"] == "20.000"
    assert second["status"] == "OPEN"
    assert second["available_quantity"] == "5.000"
    assert first["warning"] == "ADVISORY_SNAPSHOT_NOT_PHYSICALLY_RESERVED"
    assert directory.list(foreign["AUDITOR"]) == []
    with pytest.raises(WorkflowError, match="not found"):
        directory.history(foreign["AUDITOR"], first["id"])
    svc.receive(a["TECHNICIAN"], "DEMAND-BC-1", "LOT1", expiry, "15")
    assert demand_for_fill(env, f2)["status"] == "READY"
    assert demand_for_fill(env, f2)["available_quantity"] == "20.000"
    events = directory.history(a["AUDITOR"], second["id"])
    assert [x["operation"] for x in events] == ["CREATED", "RECONCILED", "RECONCILED"]
    # READ and RECONCILE do not invent physical FillSource allocations.
    with svc.sessions() as s:
        assert s.query(InventoryDemand).count() == 2
        assert s.query(InventoryDemandEvent).count() >= 4


def test_stock_reserve_and_cancel_recompute_other_patient_demand(env):
    svc, a, foreign, drug, p1, p2, expiry, patient1, patient2, doctor, directory = env
    svc.receive(a["TECHNICIAN"], "DEMAND-BC-1", "LOT1", expiry, "30")
    rx1, f1 = create_fill(env, qty="20", suffix="C")
    rx2, f2 = create_fill(env, patient_index=1, qty="20", suffix="D")
    assert demand_for_fill(env, f2)["status"] == "OPEN"
    svc.scan_source(a["TECHNICIAN"], f1, "DEMAND-BC-1", "LOT1", expiry, "20")
    assert demand_for_fill(env, f2)["status"] == "OPEN"
    LifecycleService(svc).cancel(a["TECHNICIAN"], rx1, "Synthetic user cancelled fill")
    assert demand_for_fill(env, f1)["status"] == "CANCELLED"
    assert demand_for_fill(env, f2)["status"] == "READY"
    assert demand_for_fill(env, f2)["available_quantity"] == "20.000"
    with pytest.raises(WorkflowError, match="Prescription-linked"):
        directory.cancel(a["TECHNICIAN"], demand_for_fill(env, f2)["id"], "Not permitted")


def test_demand_fulfilled_only_after_pharmacist_verification(env):
    svc, a, _, drug, p1, p2, expiry, patient1, patient2, doctor, directory = env
    svc.receive(a["TECHNICIAN"], "DEMAND-BC-1", "LOT1", expiry, "60")
    rx, fill = create_fill(env, qty="20", suffix="E")
    demand_id = demand_for_fill(env, fill)["id"]
    svc.scan_source(a["TECHNICIAN"], fill, "DEMAND-BC-1", "LOT1", expiry, "20")
    svc.prepare_for_review(a["TECHNICIAN"], fill, [])
    assert demand_for_fill(env, fill)["status"] in ("OPEN", "READY")
    svc.verify(a["PHARMACIST"], fill)
    done = demand_for_fill(env, fill)
    assert done["status"] == "FULFILLED"
    assert done["fulfilled_at"] is not None
    assert done["available_quantity"] == "20.000"
    assert directory.history(a["AUDITOR"], demand_id)[-1]["operation"] == "FULFILLED"
    svc.return_to_stock(a["PHARMACIST"], fill, "Synthetic order was returned")
    # Fulfillment reflects an actual verified physical pick; RTS has separate custody.
    assert demand_for_fill(env, fill)["status"] == "FULFILLED"


def test_partial_interruption_revises_physical_demand_not_full_billed_quantity(env):
    svc, a, _, drug, p1, p2, expiry, patient1, patient2, doctor, directory = env
    svc.receive(a["TECHNICIAN"], "DEMAND-BC-1", "LOT1", expiry, "40")
    rx, fill = create_fill(env, qty="30", suffix="F")
    svc.scan_source(a["TECHNICIAN"], fill, "DEMAND-BC-1", "LOT1", expiry, "12")
    FillCompletionService(svc).interrupt_as_partial(a["TECHNICIAN"], fill, "12",
        "Physically counted shortage and release initial picked products")
    demand = demand_for_fill(env, fill)
    assert demand["required_quantity"] == "12.000"
    with svc.sessions() as s:
        assert str(s.get(InventoryDemand, demand["id"]).required_quantity) == "12.000"
        assert str(s.get(Stock, s.query(Stock).one().id).reserved) == "0.000"
    assert any(x["operation"] == "FILL_TARGET_CHANGED"
               for x in directory.history(a["AUDITOR"], demand["id"]))


def test_specific_ndc_request_cannot_use_other_ndc_forecast(env):
    svc, a, _, drug, p1, p2, expiry, patient1, patient2, doctor, directory = env
    svc.receive(a["TECHNICIAN"], "DEMAND-BC-2", "LOT-WHITE", expiry, "50")
    _, fill = create_fill(env, qty="20", suffix="G",
                          directive="DISPENSE_AS_WRITTEN", product_id=p1)
    assert demand_for_fill(env, fill)["status"] == "OPEN"
    assert demand_for_fill(env, fill)["available_quantity"] == "0.000"
    svc.receive(a["TECHNICIAN"], "DEMAND-BC-1", "LOT-BLUE", expiry, "20")
    assert demand_for_fill(env, fill)["status"] == "READY"
    assert demand_for_fill(env, fill)["product_id"] == p1


def test_manual_and_reorder_demand_audit_and_access(env):
    svc, a, foreign, drug, p1, p2, expiry, patient1, patient2, doctor, directory = env
    with pytest.raises(AccessDenied):
        directory.create_manual(a["AUDITOR"], drug, "20", note="Twelve character note")
    svc.receive(a["TECHNICIAN"], "DEMAND-BC-1", "LOT1", expiry, "15")
    reorder = directory.create_manual(a["TECHNICIAN"], drug, "30", source="REORDER",
        product_id=p1, note="Synthetic replenishment of demo stock")
    manual = directory.create_manual(a["TECHNICIAN"], drug, "10",
        note="Manual synthetic stock request")
    report = {x["id"]: x for x in directory.list(a["AUDITOR"])}
    assert report[reorder]["status"] == "OPEN"
    assert report[reorder]["available_quantity"] == "15.000"
    assert report[manual]["status"] == "READY"
    assert report[manual]["available_quantity"] == "10.000"
    with pytest.raises(WorkflowError, match="does not belong"):
        directory.create_manual(a["TECHNICIAN"], drug, "10", product_id="unknown",
                                note="Unknown NDC should be blocked")
    with pytest.raises(WorkflowError, match="not found"):
        directory.cancel(foreign["TECHNICIAN"], manual, "No cross-site edits")
    directory.cancel(a["TECHNICIAN"], manual, "Synthetic manual demand no longer needed")
    assert next(x for x in directory.list(a["AUDITOR"]) if x["id"] == manual)["status"] == "CANCELLED"
    with pytest.raises(WorkflowError, match="Only OPEN/READY"):
        directory.cancel(a["TECHNICIAN"], manual, "Duplicate cancelled request")


def test_expired_and_quarantined_stock_not_counted_and_stock_events_refresh(env):
    svc, a, _, drug, p1, p2, expiry, patient1, patient2, doctor, directory = env
    rx, fill = create_fill(env, qty="20", suffix="H")
    stock = svc.receive(a["TECHNICIAN"], "DEMAND-BC-1", "LOT1", expiry, "25")
    assert demand_for_fill(env, fill)["status"] == "READY"
    hold = InventoryService(svc).create_hold(a["TECHNICIAN"], stock, "20",
        "Synthetic damaged bottles quarantined")
    assert demand_for_fill(env, fill)["available_quantity"] == "5.000"
    assert demand_for_fill(env, fill)["status"] == "OPEN"
    InventoryService(svc).resolve_hold(a["PHARMACIST"], hold, "RELEASED",
                                      "Demo quarantined units cleared for use")
    assert demand_for_fill(env, fill)["status"] == "READY"
    with svc.sessions.begin() as s:
        s.query(Stock).filter_by(id=stock).one().expires = (date.today() - timedelta(days=1)).isoformat()
    assert directory.reconcile(a["TECHNICIAN"], drug)["available_quantity"] == "0"
    assert demand_for_fill(env, fill)["status"] == "OPEN"


def test_demand_api_mode_and_cross_site_isolation(env):
    svc, a, foreign, drug, p1, p2, expiry, patient1, patient2, doctor, directory = env
    rx, fill = create_fill(env, qty="20", suffix="I")
    cli = TestClient(create_app(svc, synthetic_enabled=True))
    off = TestClient(create_app(svc, synthetic_enabled=False))
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    audit = {"x-demo-staff-id": a["AUDITOR"].id}
    other = {"x-demo-staff-id": foreign["AUDITOR"].id}
    prefix = "/api/inventory/demands"
    assert off.get(prefix, headers=tech).status_code == 503
    assert cli.get(prefix, headers=other).json()["demands"] == []
    current = cli.get(prefix, headers=audit).json()["demands"]
    assert len(current) == 1
    assert current[0]["fill_id"] == fill
    resp = cli.post(prefix + "/manual", headers=tech, json={
        "drug_id": drug, "quantity": "15", "note": "Test manual stock backorder"})
    assert resp.status_code == 201, resp.text
    rid = resp.json()["id"]
    assert cli.get(prefix + f"/{rid}/events", headers=audit).status_code == 200
    assert cli.post(prefix + "/reconcile", headers=audit,
                    json={"drug_id": drug}).status_code == 403
    assert cli.post(prefix + "/reconcile", headers=tech,
                    json={"drug_id": drug}).status_code == 200
    assert cli.post(prefix + f"/{rid}/cancel", headers=tech, json={
        "reason": "Not required"}).status_code == 200
    assert cli.get(prefix, headers=audit).status_code == 200
