from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.models import Claim, Fill, FillSource, Label, Prescription, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError, positive


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    demo = svc.bootstrap_demo()
    actors = demo["actors"]
    pharm, tech = actors["PHARMACIST"], actors["TECHNICIAN"]
    patient = svc.add_patient(tech, "Test", "Patient")
    doctor = svc.add_prescriber(tech, "Test", "Doctor", "MD")
    drug = svc.add_drug(pharm, "Examplemed", "10 mg", "tablet")
    products = []
    expiry = (date.today() + timedelta(days=180)).isoformat()
    for idx in (1, 2):
        pid = svc.add_product(pharm, drug, f"00000-000{idx}-01", f"MFG {idx}", f"tablet {idx}")
        barcode = f"BARCODE-{idx}"
        svc.register_barcode(tech, pid, barcode)
        sid = svc.receive(tech, barcode, f"LOT-{idx}", expiry, "100")
        products.append((pid, barcode, sid, f"LOT-{idx}"))
    rx = svc.add_prescription(tech, patient, doctor, drug, "RX100", "Once daily", "90", refills=1)
    svc.advance_to_dur(tech, rx)
    return svc, actors, rx, products, expiry


def test_split_fill_full_billing_and_separate_bottle_labels(env):
    svc, actors, rx, products, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    fid = svc.start_fill(tech, rx)
    svc.scan_source(tech, fid, products[0][1], products[0][3], expiry, "60")
    svc.scan_source(tech, fid, products[1][1], products[1][3], expiry, "30")
    labels = svc.prepare_for_review(tech, fid, ["Primary", "Secondary", "Third", "Fourth"])
    assert "60.000/90.000" in labels[0]
    assert "Bottle 1 of 2" in labels[0]
    assert "30.000/90.000" in labels[1]
    with svc.sessions() as session:
        assert len(session.scalars(select(Label).where(Label.fill_id == fid)).all()) == 2
        claims = session.scalars(select(Claim).where(Claim.fill_id == fid)).all()
        assert len(claims) == 4
        assert all(x.billed_quantity == Decimal("90") for x in claims)
    with pytest.raises(AccessDenied):
        svc.verify(tech, fid)
    svc.verify(pharm, fid)
    with svc.sessions() as session:
        assert all(session.get(Stock, row[2]).reserved == 0 for row in products)
        assert session.get(Stock, products[0][2]).on_hand == Decimal("40")
        assert session.get(Stock, products[1][2]).on_hand == Decimal("70")
    svc.stage_will_call(tech, fid, "A-1", "BAG-001")
    with pytest.raises(WorkflowError):
        svc.sell(tech, fid, True, True, "5", "cash", scanned_bag="wrong")
    svc.sell(tech, fid, True, True, "5", "cash", scanned_bag="BAG-001")
    assert svc.queue(tech)[0]["status"] == "SOLD"


def test_return_to_stock_claim_reversal_and_no_refill_consumption(env):
    svc, actors, rx, products, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    fid = svc.start_fill(tech, rx)
    svc.scan_source(tech, fid, products[0][1], products[0][3], expiry, "90")
    svc.prepare_for_review(tech, fid, ["Synthetic plan"])
    svc.verify(pharm, fid)
    svc.return_to_stock(pharm, fid, "Patient declined")
    with svc.sessions() as session:
        assert session.get(Stock, products[0][2]).on_hand == Decimal("100")
        assert session.get(Prescription, rx).refills_used == 0
        assert session.scalar(select(Claim).where(Claim.fill_id == fid)).status == "REVERSED_SYNTHETIC"
    fid2 = svc.start_fill(tech, rx)
    assert fid2 != fid
    with svc.sessions() as session:
        a, b = session.get(Fill, fid), session.get(Fill, fid2)
        assert a.fill_number == b.fill_number == 0
        assert (a.attempt, b.attempt) == (1, 2)


def test_rejection_does_not_reserve_or_add_sources(env):
    svc, actors, rx, products, expiry = env
    tech = actors["TECHNICIAN"]
    fid = svc.start_fill(tech, rx)
    for barcode, qty in (("unregistered", "10"), (products[0][1], "101")):
        with pytest.raises(WorkflowError):
            svc.scan_source(tech, fid, barcode, products[0][3], expiry, qty)
    with svc.sessions() as session:
        assert session.get(Stock, products[0][2]).reserved == 0
        assert session.scalars(select(FillSource).where(FillSource.fill_id == fid)).all() == []


def test_site_isolation_and_clinical_gate(env):
    svc, actors, rx, products, expiry = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    other = svc.bootstrap_demo()["actors"]["PHARMACIST"]
    with pytest.raises(WorkflowError):
        svc.start_fill(other, rx)
    issue = svc.add_dur_issue(pharm, rx, "HIGH", "SYNTHETIC_ALERT")
    with pytest.raises(WorkflowError):
        svc.start_fill(tech, rx)
    with pytest.raises(AccessDenied):
        svc.resolve_dur(tech, issue, "No concerns")
    with pytest.raises(WorkflowError):
        svc.resolve_dur(pharm, issue, "")
    svc.resolve_dur(pharm, issue, "Reviewed synthetic warning")
    assert svc.start_fill(tech, rx)


def test_partial_fills_use_full_billed_quantity(env):
    svc, actors, rx, products, expiry = env
    tech = actors["TECHNICIAN"]
    fid = svc.start_fill(tech, rx, "30")
    svc.scan_source(tech, fid, products[0][1], products[0][3], expiry, "30")
    svc.prepare_for_review(tech, fid, ["Test payer"])
    with svc.sessions() as s:
        f = s.get(Fill, fid)
        assert f.quantity == Decimal("30")
        assert f.billed_quantity == Decimal("90")
        assert s.scalar(select(Claim).where(Claim.fill_id == fid)).billed_quantity == Decimal("90")


def test_qty_input_and_controlled_drug_block(env):
    svc, actors, rx, products, expiry = env
    for quantity in ("-1", "0", "NaN", "Infinity", "1.0001"):
        with pytest.raises(WorkflowError):
            positive(quantity)
    pharm, tech = actors["PHARMACIST"], actors["TECHNICIAN"]
    drug = svc.add_drug(pharm, "ControlledExample", "5 mg", "tablet", True)
    with svc.sessions() as s:
        current = s.get(Prescription, rx)
        patient, prescriber = current.patient_id, current.prescriber_id
    with pytest.raises(WorkflowError, match="Controlled"):
        svc.add_prescription(tech, patient, prescriber, drug, "RX200", "daily", "10")


def test_api_fail_closed_and_synthetic_mode(env):
    svc, actors, rx, products, expiry = env
    api = TestClient(create_app(svc, synthetic_enabled=False))
    assert api.get("/health").status_code == 200
    assert api.get("/api/queue").status_code == 503
    api = TestClient(create_app(svc, synthetic_enabled=True))
    assert api.get("/api/queue").status_code == 403
    tech = actors["TECHNICIAN"]
    response = api.get("/api/queue", headers={"x-demo-staff-id": tech.id})
    assert response.status_code == 200
    assert response.json()[0]["rx_number"] == "RX100"
