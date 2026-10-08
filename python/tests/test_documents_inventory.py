"""Dedicated migration regression cases; synthetic records exclusively."""
import base64
import json
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.documents import DocumentError, DocumentService, decode_base64
from pharmacy1os.inventory_ops import InventoryService
from pharmacy1os.models import Document, DocumentAnnotation, DocumentChange, InventoryMovement, Stock
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def fixtures(tmp_path, monkeypatch):
    monkeypatch.setenv("DOCUMENT_STORAGE_ROOT", str(tmp_path / "vault"))
    monkeypatch.delenv("DOCUMENT_ENCRYPTION_KEY", raising=False)
    db = PharmacyService()
    db.create_schema()
    a = db.bootstrap_demo()["actors"]
    pharmacist, technician = a["PHARMACIST"], a["TECHNICIAN"]
    p = db.add_patient(technician, "Synthetic", "Only")
    dr = db.add_prescriber(technician, "Dr", "Test", "MD")
    drug = db.add_drug(pharmacist, "NoRealDrug", "25mg", "tablet")
    product = db.add_product(pharmacist, drug, "00001-0001-01", "Synthetic", "white tablet")
    db.register_barcode(technician, product, "BAR-1")
    expiry = (date.today() + timedelta(days=180)).isoformat()
    stock = db.receive(technician, "BAR-1", "SYNLOT", expiry, "100")
    rx = db.add_prescription(technician, p, dr, drug, "SYN-001", "Test SIG", "90")
    return db, a, stock, rx, expiry, tmp_path


def change(**overrides):
    return {"change_type": "SIG", "what_changed": "One tablet daily to one tablet twice daily",
            "reason": "Synthetic prescriber clarification", "communication_method": "PHONE",
            "contacted_party": "Office nurse", "authorizing_prescriber": "Dr Test", **overrides}


def test_immutable_source_and_audited_separate_annotation_versions(fixtures):
    svc, actors, _, rx, _, tmp = fixtures
    documents = DocumentService(svc, tmp / "vault", encryption_key=b"A" * 32)
    tech = actors["TECHNICIAN"]
    original = b"\x89PNG\r\n\x1a\nsynthetic immutable image"
    doc = documents.create_source(tech, rx, original, "image/png", filename="scanned.png")
    assert doc["encrypted"] and doc["sha256"]
    assert documents.read_source(tech, doc["id"])[0] == original
    raw = documents._path(tech.site_id, doc["id"]).read_bytes()
    assert raw.startswith(b"P1DV1") and original not in raw
    first = documents.annotate(tech, doc["id"], "Called office", ".1", ".2", ".4", ".2", change())
    second = documents.annotate(tech, doc["id"], "Reconfirmed", ".2", ".2", ".4", ".2", change(), supersedes_id=first)
    ann = documents.list_annotations(tech, doc["id"])
    assert len(ann) == 2
    assert ann[0]["status"] == "SUPERSEDED"
    assert ann[1]["supersedes_id"] == first
    assert ann[1]["status"] == "ACTIVE"
    assert ann[0]["change"]["reason"] == "Synthetic prescriber clarification"
    assert documents.read_source(tech, doc["id"])[0] == original
    with svc.sessions() as s:
        assert s.get(DocumentAnnotation, first).status == "SUPERSEDED"
        assert s.scalar(select(DocumentChange).where(DocumentChange.annotation_id == first)).status == "SUPERSEDED"


def test_document_corruption_bad_key_and_site_rejection(fixtures):
    svc, actors, _, rx, _, tmp = fixtures
    docsvc = DocumentService(svc, tmp / "vault", encryption_key=b"X" * 32)
    doc = docsvc.create_source(actors["TECHNICIAN"], rx, b"synthetic pdf", "application/pdf")
    other = svc.bootstrap_demo()["actors"]["PHARMACIST"]
    with pytest.raises(WorkflowError):
        docsvc.read_source(other, doc["id"])
    with pytest.raises(WorkflowError):
        docsvc.list_sources(other, rx)
    with pytest.raises(DocumentError):
        DocumentService(svc, tmp / "vault", encryption_key=b"Y" * 32).read_source(actors["TECHNICIAN"], doc["id"])
    path = docsvc._path(actors["TECHNICIAN"].site_id, doc["id"])
    path.write_bytes(path.read_bytes()[:-1] + b"!")
    with pytest.raises(DocumentError):
        docsvc.read_source(actors["TECHNICIAN"], doc["id"])
    assert len(docsvc.verify_integrity(actors["TECHNICIAN"])) == 1
    with svc.sessions() as s:
        assert s.get(Document, doc["id"]).sha256 == doc["sha256"]


def test_annotation_validation_and_erx_xml_escaping(fixtures):
    svc, actors, _, rx, _, tmp = fixtures
    docsvc = DocumentService(svc, tmp / "vault")
    tech = actors["TECHNICIAN"]
    doc = docsvc.create_source(tech, rx, b"source", "image/jpeg")
    with pytest.raises(DocumentError):
        docsvc.annotate(tech, doc["id"], "text", ".8", ".5", ".4", ".2", change())
    with pytest.raises(DocumentError):
        docsvc.annotate(tech, doc["id"], "text", "NaN", ".5", ".2", ".2", change())
    with pytest.raises(DocumentError):
        docsvc.annotate(tech, doc["id"], "text", ".1", ".2", ".2", ".2", change(reason=""))
    with pytest.raises(DocumentError):
        docsvc.create_source(tech, rx, b"<svg/>", "image/svg+xml", "ELECTRONIC_RENDER")
    erx = docsvc.render_erx(tech, rx, "<fake&message>")
    svg, _ = docsvc.read_source(tech, erx["id"])
    assert b"&lt;fake&amp;message&gt;" in svg
    assert b"<fake&message>" not in svg


def test_inventory_quarantine_rejects_overissue_and_preserves_ledgers(fixtures):
    svc, actors, stock, rx, expiry, _ = fixtures
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    inv = InventoryService(svc)
    before = inv.ledger(tech, stock)
    assert [i["kind"] for i in before] == ["RECEIVE"]
    hold = inv.create_hold(tech, stock, "70", "Synthetic quality excursion")
    with svc.sessions() as s:
        assert s.get(Stock, stock).quarantined == Decimal("70")
    svc.advance_to_dur(tech, rx)
    fid = svc.start_fill(tech, rx)
    with pytest.raises(WorkflowError, match="Insufficient"):
        svc.scan_source(tech, fid, "BAR-1", "SYNLOT", expiry, "90")
    with pytest.raises(AccessDenied):
        inv.resolve_hold(tech, hold, "RELEASED", "Checked")
    with pytest.raises(WorkflowError):
        inv.resolve_hold(pharm, hold, "RELEASED", "")
    inv.resolve_hold(pharm, hold, "RELEASED", "Synthetic inspection complete")
    with pytest.raises(WorkflowError):
        inv.resolve_hold(pharm, hold, "DISPOSED", "Double processing")
    svc.scan_source(tech, fid, "BAR-1", "SYNLOT", expiry, "90")
    svc.prepare_for_review(tech, fid, ["Demo insurer"])
    svc.verify(pharm, fid)
    svc.return_to_stock(pharm, fid, "synthetic patient declined")
    ledger = inv.ledger(tech, stock)
    assert [x["kind"] for x in ledger] == ["RECEIVE", "QUARANTINE", "RELEASED", "FILL_RESERVE", "FILL_DISPENSE", "RETURN_TO_STOCK"]
    with svc.sessions() as s:
        row = s.get(Stock, stock)
        assert row.on_hand == Decimal("100") and row.quarantined == row.reserved == 0
        assert len(s.scalars(select(InventoryMovement)).all()) == 6


def test_disposal_manual_adjustment_and_site_protection(fixtures):
    svc, actors, stock, _, _, _ = fixtures
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    inv = InventoryService(svc)
    hold = inv.create_hold(tech, stock, "20", "Damaged shipment")
    inv.resolve_hold(pharm, hold, "DISPOSED", "Destroyed in synthetic test")
    with pytest.raises(WorkflowError):
        inv.adjust(pharm, stock, "-81", "Would violate constraints")
    with pytest.raises(AccessDenied):
        inv.adjust(tech, stock, "10", "No technician adjustments")
    inv.adjust(pharm, stock, "-5", "Cycle recount")
    other = svc.bootstrap_demo()["actors"]["PHARMACIST"]
    with pytest.raises(WorkflowError):
        inv.ledger(other, stock)
    with svc.sessions() as s:
        row = s.get(Stock, stock)
        assert row.on_hand == Decimal("75")


def test_synthetic_api_documents_and_holds(fixtures):
    svc, actors, stock, rx, _, _ = fixtures
    client = TestClient(create_app(svc, synthetic_enabled=True))
    tech = actors["TECHNICIAN"]
    headers = {"x-demo-staff-id": tech.id}
    doc = client.post(f"/api/prescriptions/{rx}/documents/original", json={
        "base64_data": base64.b64encode(b"SYNTHETIC TEST SOURCE").decode(),
        "mime_type": "application/pdf", "source_type": "SCAN", "filename": "test.pdf"}, headers=headers)
    assert doc.status_code == 200, doc.text
    ident = doc.json()["document"]["id"]
    assert client.get(f"/api/documents/{ident}/content", headers=headers).content == b"SYNTHETIC TEST SOURCE"
    assert len(client.get(f"/api/prescriptions/{rx}/documents", headers=headers).json()["documents"]) == 1
    hold = client.post("/api/inventory/holds", json={"stock_id": stock, "quantity": "2", "reason": "damaged"}, headers=headers)
    assert hold.status_code == 200, hold.text
    assert client.get("/api/inventory/holds", headers=headers).json()["holds"][0]["status"] == "ACTIVE"
    assert client.get(f"/api/inventory/stock/{stock}/ledger", headers=headers).status_code == 200


def test_base64_rejects_invalid_and_empty():
    for value in ("\ud800", "wrong_+base64", ""):
        with pytest.raises(DocumentError):
            decode_base64(value)
