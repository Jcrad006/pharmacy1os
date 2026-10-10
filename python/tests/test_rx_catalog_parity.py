"""Original prescription-source and medication/product field parity tests.

All fixtures are synthetic. Deliberately fail closed on unported clinical rules.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.models import Drug, Patient, Prescription, Product
from pharmacy1os.pos import PosService
from pharmacy1os.service import PharmacyService, WorkflowError


@pytest.fixture
def fixture():
    service = PharmacyService()
    service.create_schema()
    actors = service.bootstrap_demo()["actors"]
    outside = service.bootstrap_demo()["actors"]
    tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = service.add_patient(tech, "Synthetic", "Example", email="example@synthetic.invalid")
    doctor = service.add_prescriber(tech, "Demo", "Doctor", "MD")
    drug = service.add_drug(pharmacist, "EXAMPLE-DRUG", "10 mg", "tablet",
        brand_name="EXAMPLE-BRAND", route="ORAL")
    main = service.add_product(pharmacist, drug, "00000-1010-01", "Demo Labeler",
        "Synthetic round tablet", price="0.1200", package_description="100 tablets",
        package_type="BOTTLE", units_per_package="100", package_price="12.0000",
        therapeutic_equivalence_code="AB")
    alt = service.add_product(pharmacist, drug, "00000-1010-02", "Other Labeler",
        "Synthetic capsule", price="0.2000", package_type="BOTTLE",
        units_per_package="60")
    exp = (date.today() + timedelta(days=365)).isoformat()
    for p, barcode, lot in ((main, "PARITY-BC-1", "LOT1"), (alt, "PARITY-BC-2", "LOT2")):
        service.register_barcode(tech, p, barcode)
        service.receive(tech, barcode, lot, exp, "200")
    return service, actors, outside, patient, doctor, drug, main, alt, exp


def create_rx(env, number, *, source="PAPER", prescribed=None, directive="UNSPECIFIED",
              drug_id=None, erx_id=None, raw=None):
    svc, actors, _, patient, doctor, drug, main, alt, exp = env
    return svc.add_prescription(actors["TECHNICIAN"], patient, doctor, drug_id or drug,
        number, "take once daily", "30", refills=2,
        source_type=source, written_date=date.today().isoformat(),
        prescribed_product_id=prescribed, product_selection_directive=directive,
        electronic_message_id=erx_id, electronic_raw_message=raw)


def test_preserves_catalog_and_rx_provenance_without_exposing_raw_electronic_text(fixture):
    svc, actors, outside, patient, doctor, drug_id, main, alt, exp = fixture
    rx_id = create_rx(fixture, "PARITY-ERX-01", source="ELECTRONIC",
                      prescribed=main, directive="DISPENSE_AS_WRITTEN",
                      erx_id="SYNTH-ERX-123", raw="FAKE SYNTHETIC RAW MESSAGE")
    with svc.sessions() as s:
        d = s.get(Drug, drug_id)
        p = s.get(Product, main)
        rx = s.get(Prescription, rx_id)
        assert d.brand_name == "EXAMPLE-BRAND" and d.route == "ORAL"
        assert d.controlled_substance_schedule == "NONE"
        assert d.active
        assert p.package_type == "BOTTLE"
        assert p.package_description == "100 tablets"
        assert p.units_per_package == 100
        assert p.package_price == Decimal("12.0000")
        assert p.therapeutic_equivalence_code == "AB"
        assert rx.source_type == "ELECTRONIC"
        assert rx.written_date == date.today().isoformat()
        assert rx.electronic_raw_message == "FAKE SYNTHETIC RAW MESSAGE"
        assert rx.prescribed_product_id == main
        assert rx.product_selection_directive == "DISPENSE_AS_WRITTEN"
        assert s.get(Patient, patient).email == "example@synthetic.invalid"
    api = TestClient(create_app(svc, synthetic_enabled=True))
    head = {"x-demo-staff-id": actors["AUDITOR"].id}
    info = api.get(f"/api/prescriptions/{rx_id}", headers=head)
    assert info.status_code == 200
    assert info.json()["source_type"] == "ELECTRONIC"
    assert info.json()["electronic_source_recorded"] is True
    assert "FAKE SYNTHETIC" not in info.text
    assert "electronic_raw_message" not in info.json()
    assert api.get("/api/catalog/drugs", headers=head).json()["drugs"][0]["brand_name"] == "EXAMPLE-BRAND"
    assert len(api.get(f"/api/catalog/products?drug_id={drug_id}",
        headers=head).json()["products"]) == 2
    assert api.get(f"/api/prescriptions/{rx_id}",
        headers={"x-demo-staff-id": outside["AUDITOR"].id}).status_code == 409


def test_daw_rejects_alternate_ndc_at_scan_but_allows_prescribed_product(fixture):
    svc, a, outside, patient, doctor, drug, main, alt, exp = fixture
    rx = create_rx(fixture, "RX-DAW-01", prescribed=main, directive="DISPENSE_AS_WRITTEN")
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    fid = svc.start_fill(a["TECHNICIAN"], rx)
    with pytest.raises(WorkflowError, match="Dispense-as-written"):
        svc.scan_source(a["TECHNICIAN"], fid, "PARITY-BC-2", "LOT2", exp, "30")
    svc.scan_source(a["TECHNICIAN"], fid, "PARITY-BC-1", "LOT1", exp, "30")
    svc.prepare_for_review(a["TECHNICIAN"], fid, [])
    svc.verify(a["PHARMACIST"], fid)
    svc.sell(a["TECHNICIAN"], fid, True, True, "0", "CASH")
    with svc.sessions() as s:
        assert s.get(Prescription, rx).status == "SOLD"


def test_synthetic_selection_permitted_still_allows_other_product(fixture):
    svc, a, _, patient, doctor, drug, main, alt, exp = fixture
    rx = create_rx(fixture, "RX-ALT-01", prescribed=main, directive="SELECTION_PERMITTED")
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    fid = svc.start_fill(a["TECHNICIAN"], rx)
    svc.scan_source(a["TECHNICIAN"], fid, "PARITY-BC-2", "LOT2", exp, "30")
    assert fid


@pytest.mark.parametrize("kwargs,match", [
    ({"source_type": "NOTREAL"}, "source type"),
    ({"source_type": "FAX", "electronic_message_id": "NOT-ALLOWED"}, "requires ELECTRONIC"),
    ({"product_selection_directive": "DISPENSE_AS_WRITTEN"}, "requires a prescribed NDC"),
    ({"product_selection_directive": "INVALID"}, "product selection"),
    ({"written_date": "2026-02-30"}, "written date"),
    ({"written_date": "2999-01-01"}, "Future written date"),
    ({"written_date": "2026-01-04", "expiration_date": "2026-01-03"}, "precedes"),
    ({"refills": True}, "Refills must"),
])
def test_rejects_invalid_original_source_contract(fixture, kwargs, match):
    svc, a, _, patient, doctor, drug, main, alt, exp = fixture
    with pytest.raises(WorkflowError, match=match):
        svc.add_prescription(a["TECHNICIAN"], patient, doctor, drug,
            "INVALID-RX-01", "daily", "30", **kwargs)


def test_rejects_wrong_drug_product_and_inactive_metadata(fixture):
    svc, a, _, patient, doctor, drug, main, alt, exp = fixture
    other_drug = svc.add_drug(a["PHARMACIST"], "OTHER-DRUG", "4mg", "tablet")
    with pytest.raises(WorkflowError, match="under the selected drug"):
        create_rx(fixture, "RX-MISMATCH", drug_id=other_drug,
                  prescribed=main)
    with svc.sessions.begin() as s:
        s.get(Product, main).active = False
    with pytest.raises(WorkflowError, match="active under"):
        create_rx(fixture, "RX-INACTIVE", prescribed=main)
    with svc.sessions.begin() as s:
        s.get(Drug, drug).active = False
    with pytest.raises(WorkflowError, match="inactive"):
        create_rx(fixture, "RX-INACTIVE-DRUG")


@pytest.mark.parametrize("flags", [
    {"is_biological": True},
    {"requires_cold_chain": True},
    {"controlled_substance_schedule": "II"},
])
def test_unported_special_compliance_fails_closed(fixture, flags):
    svc, a, _, patient, doctor, drug, main, alt, exp = fixture
    special = svc.add_drug(a["PHARMACIST"], "SPECIAL-DEMO", "1mg", "tablet", **flags)
    if flags.get("controlled_substance_schedule"):
        with pytest.raises(WorkflowError, match="Controlled"):
            create_rx(fixture, "RX-CONTROLLED", drug_id=special)
    else:
        rx = create_rx(fixture, "RX-SPECIAL", drug_id=special)
        svc.advance_to_dur(a["TECHNICIAN"], rx)
        with pytest.raises(WorkflowError, match="not|requires|validated"):
            svc.start_fill(a["TECHNICIAN"], rx)


def test_transfer_in_provenance_is_retained_but_not_unvalidated_dispensed(fixture):
    svc, a, _, patient, doctor, drug, main, alt, exp = fixture
    rx = create_rx(fixture, "RX-TRANSFER-IN", source="TRANSFER")
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    with pytest.raises(WorkflowError, match="Transfer-in"):
        svc.start_fill(a["TECHNICIAN"], rx)


def test_rechecks_mutable_catalog_status_after_scanning_and_before_checkout(fixture):
    svc, a, _, patient, doctor, drug, main, alt, exp = fixture
    rx = create_rx(fixture, "RX-STALENESS")
    svc.advance_to_dur(a["TECHNICIAN"], rx)
    fill = svc.start_fill(a["TECHNICIAN"], rx)
    svc.scan_source(a["TECHNICIAN"], fill, "PARITY-BC-1", "LOT1", exp, "30")
    with svc.sessions.begin() as s:
        s.get(Product, main).active = False
    with pytest.raises(WorkflowError, match="inactive"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, [])
    with svc.sessions.begin() as s:
        s.get(Product, main).active = True
    svc.prepare_for_review(a["TECHNICIAN"], fill, [])
    with svc.sessions.begin() as s:
        s.get(Drug, drug).nc_narrow_therapeutic_index = True
    with pytest.raises(WorkflowError, match="NTI"):
        svc.verify(a["PHARMACIST"], fill)
    with svc.sessions.begin() as s:
        s.get(Drug, drug).nc_narrow_therapeutic_index = False
    svc.verify(a["PHARMACIST"], fill)
    with svc.sessions.begin() as s:
        s.get(Product, main).active = False
    with pytest.raises(WorkflowError, match="inactive"):
        svc.sell(a["TECHNICIAN"], fill, True, True, "0", "CASH")
    with pytest.raises(WorkflowError, match="inactive"):
        PosService(svc).checkout(a["CASHIER"], lines=[{"fill_id": fill, "amount": "0"}],
            tenders=[], scanned_bags={}, recipient_name="Synthetic Patient",
            identity_method="DATE_OF_BIRTH", signature_method="PAPER",
            signature_attested=True, idempotency_key="DAW-POS-ONE",
            mode="IMMEDIATE")
    with svc.sessions() as s:
        assert s.get(Prescription, rx).status == "READY"


def test_detailed_product_prices_fail_closed(fixture):
    svc, a, _, patient, doctor, drug, main, alt, exp = fixture
    with pytest.raises(WorkflowError, match="Price"):
        svc.add_product(a["PHARMACIST"], drug, "FAKE-NEW", "Test", "product", price="-1")
    with pytest.raises(WorkflowError, match="positive"):
        svc.add_product(a["PHARMACIST"], drug, "FAKE-NEW", "Test", "product",
                        units_per_package="0")
    with pytest.raises(WorkflowError, match="Price"):
        svc.add_product(a["PHARMACIST"], drug, "FAKE-NEW", "Test", "product",
                        package_price="NaN")
