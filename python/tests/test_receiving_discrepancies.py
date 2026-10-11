"""Receiving discrepancies: evidence, site boundary, movement link and API gate."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_advanced import AdvancedInventoryService
from pharmacy1os.inventory_discrepancies import ReceivingDiscrepancyService
from pharmacy1os.inventory_discrepancy_models import (
    ReceivingDiscrepancy, ReceivingDiscrepancyEvent,
)
from pharmacy1os.inventory_ops import InventoryService
from pharmacy1os.models import InventoryMovement, PurchaseOrderLine, PurchaseOrderReceipt, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    service = PharmacyService()
    service.create_schema()
    actors = service.bootstrap_demo()["actors"]
    other = service.bootstrap_demo()["actors"]
    drug = service.add_drug(actors["PHARMACIST"], "Synthetic receiving case", "5 mg", "tablet")
    product = service.add_product(actors["PHARMACIST"], drug, "40000-0404-01", "Demo", "White")
    alt = service.add_product(actors["PHARMACIST"], drug, "40000-0404-02", "Demo", "Blue")
    advanced = AdvancedInventoryService(service)
    po = advanced.create_purchase_order(actors["TECHNICIAN"], "Synthetic vendor",
                                        "TEST-DISC-PO-1", [{"product_id": product, "quantity": "10"}])
    with service.sessions() as s:
        line_id = s.scalar(select(PurchaseOrderLine.id).where(PurchaseOrderLine.order_id == po))
    receipt = advanced.receive_purchase_order(
        actors["TECHNICIAN"], line_id, "REC-LOT-1",
        (date.today() + timedelta(days=180)).isoformat(), "8", "TEST-INV-1")
    directory = ReceivingDiscrepancyService(service)
    return service, actors, other, po, line_id, receipt, product, alt, directory


def test_shortage_evidence_is_audited_without_phantom_stock_change(env):
    service, actors, other, po, line, receipt, product, alt, directory = env
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    with service.sessions() as s:
        stock_id = s.get(PurchaseOrderReceipt, receipt).stock_id
        balance_before = s.get(Stock, stock_id).on_hand
    did = directory.open(tech, "SHORT_SHIPMENT", note="Two units missing from delivered package.",
                         purchase_order_line_id=line, receipt_id=receipt,
                         expected_product_id=product, expected_quantity="10",
                         observed_quantity="8", evidence_reference="INV-TEST-001")
    rows = directory.list(actors["AUDITOR"])
    assert len(rows) == 1 and rows[0]["purchase_order_id"] == po
    assert rows[0]["status"] == "OPEN" and rows[0]["expected_quantity"] == "10.000"
    with service.sessions() as s:
        assert s.get(Stock, stock_id).on_hand == balance_before
    with pytest.raises(AccessDenied):
        directory.resolve(tech, did, "Vendor credited missing two tablets.")
    assert directory.resolve(pharm, did, "Vendor credited two units; no physical adjustment necessary.")["status"] == "RESOLVED"
    assert [e["action"] for e in directory.history(actors["AUDITOR"], did)] == ["OPENED", "RESOLVED"]
    with pytest.raises(WorkflowError, match="already resolved"):
        directory.resolve(pharm, did, "Attempt to improperly close again.")
    with service.sessions() as s:
        assert s.get(Stock, stock_id).on_hand == balance_before
        assert s.query(ReceivingDiscrepancyEvent).count() == 2


def test_existing_stock_adjustment_evidence_must_match_receipt(env):
    service, a, other, po, line, receipt, product, alt, directory = env
    did = directory.open(a["TECHNICIAN"], "DAMAGED_PRODUCT",
                         note="Observed a damaged inner package during delivery.",
                         receipt_id=receipt)
    with service.sessions() as s:
        stock_id = s.get(PurchaseOrderReceipt, receipt).stock_id
    InventoryService(service).adjust(a["PHARMACIST"], stock_id, "-1",
                                    "One tablet removed due to receiving damage")
    with service.sessions() as s:
        movement_id = s.scalar(select(InventoryMovement.id).where(
            InventoryMovement.stock_id == stock_id,
            InventoryMovement.kind == "MANUAL_ADJUST").order_by(
                InventoryMovement.created_at.desc()))
    resolved = directory.resolve(a["PHARMACIST"], did,
        "Verified damaged stock removed in separate pharmacist-reviewed adjustment.",
        adjustment_movement_id=movement_id)
    assert resolved["adjustment_movement_id"] == movement_id
    assert directory.history(a["AUDITOR"], did)[1]["adjustment_movement_id"] == movement_id
    other_id = directory.open(a["TECHNICIAN"], "DAMAGED_PRODUCT",
                              note="Second review request for the same package issue.",
                              receipt_id=receipt)
    with pytest.raises(WorkflowError, match="already linked"):
        directory.resolve(a["PHARMACIST"], other_id,
                          "Do not reuse the same correction evidence.",
                          adjustment_movement_id=movement_id)


def test_reference_integrity_and_site_isolation(env):
    service, a, other, po, line, receipt, product, alt, directory = env
    with pytest.raises(WorkflowError, match="conflicts"):
        directory.open(a["TECHNICIAN"], "WRONG_PRODUCT",
                       note="Discovered wrong product on shipment.",
                       receipt_id=receipt, expected_product_id=alt)
    with pytest.raises(WorkflowError, match="category"):
        directory.open(a["TECHNICIAN"], "MADE_UP",
                       note="Invalid category check against the domain rules.",
                       receipt_id=receipt)
    with pytest.raises(WorkflowError, match="quantity"):
        directory.open(a["TECHNICIAN"], "SHORT_SHIPMENT",
                       note="Over-precision must fail before database mutation.",
                       receipt_id=receipt, expected_quantity="1.0001")
    with pytest.raises(WorkflowError, match="quantity"):
        directory.open(a["TECHNICIAN"], "SHORT_SHIPMENT",
                       note="Out-of-range quantities must fail before storage.",
                       receipt_id=receipt, observed_quantity="1000000000")
    with pytest.raises(WorkflowError, match="site"):
        directory.open(other["TECHNICIAN"], "OVERAGE",
                       note="Cross-site receipt must not be accessible.",
                       receipt_id=receipt)
    assert directory.list(other["AUDITOR"]) == []
    did = directory.open(a["TECHNICIAN"], "INVOICE_MISMATCH",
                         note="The invoice amount did not match this receipt.",
                         receipt_id=receipt)
    with pytest.raises(WorkflowError, match="site"):
        directory.history(other["AUDITOR"], did)
    with pytest.raises(WorkflowError, match="site"):
        directory.resolve(other["PHARMACIST"], did,
                          "Unauthorized attempt to resolve foreign case.")


def test_api_disabled_without_optin_and_role_enforced(env):
    service, a, other, po, line, receipt, product, alt, directory = env
    payload = {"type": "SHORT_SHIPMENT", "receipt_id": receipt,
               "note": "Received fewer units than the packing slip.",
               "expected_quantity": "10", "observed_quantity": "8"}
    normal = TestClient(create_app(service, synthetic_enabled=False))
    assert normal.post("/api/inventory/discrepancies", json=payload,
                       headers={"x-demo-staff-id": a["TECHNICIAN"].id}).status_code == 503
    client = TestClient(create_app(service, synthetic_enabled=True))
    head = {"x-demo-staff-id": a["TECHNICIAN"].id}
    created = client.post("/api/inventory/discrepancies", json=payload, headers=head)
    assert created.status_code == 201, created.text
    did = created.json()["discrepancy_id"]
    listed = client.get("/api/inventory/discrepancies",
                        headers={"x-demo-staff-id": a["AUDITOR"].id})
    assert listed.status_code == 200 and any(x["id"] == did for x in listed.json()["discrepancies"])
    denied = client.post(f"/api/inventory/discrepancies/{did}/resolve",
                         json={"resolution_note": "No adjustment; vendor credit issued."},
                         headers=head)
    assert denied.status_code == 403
    resolved = client.post(f"/api/inventory/discrepancies/{did}/resolve",
        json={"resolution_note": "Supplier provided credit and discrepancy documented."},
        headers={"x-demo-staff-id": a["PHARMACIST"].id})
    assert resolved.status_code == 200 and resolved.json()["discrepancy"]["status"] == "RESOLVED"
    events = client.get(f"/api/inventory/discrepancies/{did}/events",
        headers={"x-demo-staff-id": a["AUDITOR"].id})
    assert events.status_code == 200 and len(events.json()["events"]) == 2
