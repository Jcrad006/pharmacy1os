"""Adversarial regression tests for migrated synthetic advanced inventory."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.inventory_advanced import AdvancedInventoryService
from pharmacy1os.inventory_ops import InventoryService
from pharmacy1os.models import (
    CycleCountSession, InventoryHold, InventoryTransfer, InventoryMovement,
    PurchaseOrder, PurchaseOrderLine, PurchaseOrderReceipt, RecallCase, Stock,
)
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    one = svc.bootstrap_demo()
    two = svc.bootstrap_demo()
    a, b = one['actors'], two['actors']
    product = svc.add_product(a['PHARMACIST'],
        svc.add_drug(a['PHARMACIST'], 'SyntheticMed', '10 mg', 'tablet'),
        '00000-1000-01', 'Test Mfg', 'Test tablets')
    svc.register_barcode(a['TECHNICIAN'], product, 'ITEM-1')
    expiry = (date.today() + timedelta(days=365)).isoformat()
    stock = svc.receive(a['TECHNICIAN'], 'ITEM-1', 'TESTLOT', expiry, '100')
    return svc, AdvancedInventoryService(svc), a, b, product, stock, expiry


def test_purchase_order_partial_completion_overage_and_cancel(env):
    svc, op, a, b, product, stock, expiry = env
    po = op.create_purchase_order(a['TECHNICIAN'], 'Test Vendor', 'PO-001',
                                  [{'product_id': product, 'quantity': '15'}])
    line = op.purchase_orders(a['TECHNICIAN'])[0]['lines'][0]['id']
    receipt = op.receive_purchase_order(a['TECHNICIAN'], line, 'TESTLOT', expiry, '5', 'INV-1')
    assert receipt
    with pytest.raises(WorkflowError, match='over-receipt'):
        op.receive_purchase_order(a['TECHNICIAN'], line, 'TESTLOT', expiry, '11', 'INV-2')
    with pytest.raises(AccessDenied):
        op.cancel_purchase_order(a['TECHNICIAN'], po, 'void')
    op.receive_purchase_order(a['TECHNICIAN'], line, 'TESTLOT', expiry, '10', 'INV-2')
    assert op.purchase_orders(a['TECHNICIAN'])[0]['status'] == 'RECEIVED'
    with pytest.raises(WorkflowError, match='open/partial'):
        op.cancel_purchase_order(a['PHARMACIST'], po, 'cannot undo delivered')
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal('115')
        assert len(s.scalars(select(PurchaseOrderReceipt)).all()) == 2
    assert op.purchase_orders(b['PHARMACIST']) == []


def test_po_cancel_retains_received_inventory(env):
    svc, op, a, b, product, stock, expiry = env
    po = op.create_purchase_order(a['TECHNICIAN'], 'Vendor', 'PO-2',
                                  [{'product_id': product, 'quantity': '10'}])
    line = op.purchase_orders(a['TECHNICIAN'])[0]['lines'][0]['id']
    op.receive_purchase_order(a['TECHNICIAN'], line, 'TESTLOT', expiry, '4', 'I-A')
    op.cancel_purchase_order(a['PHARMACIST'], po, 'back order cancelled')
    with pytest.raises(WorkflowError, match='closed'):
        op.receive_purchase_order(a['TECHNICIAN'], line, 'TESTLOT', expiry, '2', 'I-B')
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal('104')


def test_transfer_destination_isolation_receipt_and_no_duplicate(env):
    svc, op, a, b, product, stock, expiry = env
    dest = b['PHARMACIST'].site_id
    with pytest.raises(AccessDenied):
        op.ship_transfer(a['TECHNICIAN'], stock, dest, '12', 'moving stock')
    with pytest.raises(WorkflowError):
        op.ship_transfer(a['PHARMACIST'], stock, a['PHARMACIST'].site_id, '12', 'same site')
    trans = op.ship_transfer(a['PHARMACIST'], stock, dest, '12', 'source shipment')
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal('88')
    with pytest.raises(WorkflowError):
        op.receive_transfer(a['TECHNICIAN'], trans)
    arrived = op.receive_transfer(b['TECHNICIAN'], trans)
    with svc.sessions() as s:
        assert s.get(Stock, arrived).site_id == dest
        assert s.get(Stock, arrived).on_hand == Decimal('12')
        assert s.get(Stock, arrived).lot == 'TESTLOT'
        assert s.get(Stock, arrived).expires == expiry
    with pytest.raises(WorkflowError):
        op.receive_transfer(b['TECHNICIAN'], trans)
    with pytest.raises(WorkflowError):
        op.cancel_transfer(a['PHARMACIST'], trans, 'already received')
    assert len(op.transfers(b['TECHNICIAN'])) == 1


def test_transfer_cancel_restores_exact_quantity(env):
    svc, op, a, b, product, stock, expiry = env
    trans = op.ship_transfer(a['PHARMACIST'], stock, b['PHARMACIST'].site_id, '24', 'shipping')
    op.cancel_transfer(a['PHARMACIST'], trans, 'carrier refused')
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal('100')
        assert s.get(InventoryTransfer, trans).status == 'CANCELLED'
    with pytest.raises(WorkflowError):
        op.receive_transfer(b['PHARMACIST'], trans)


def test_cycle_count_stale_reconciliation_is_atomic(env):
    svc, op, a, b, product, stock, expiry = env
    count = op.create_cycle_count(a['TECHNICIAN'])
    op.record_count(a['TECHNICIAN'], count, stock, '98')
    op.submit_cycle_count(a['TECHNICIAN'], count)
    InventoryService(svc).adjust(a['PHARMACIST'], stock, '1', 'new stock discovered')
    with pytest.raises(WorkflowError, match='Stale'):
        op.review_cycle_count(a['PHARMACIST'], count, True, 'approve')
    with svc.sessions() as s:
        assert s.get(CycleCountSession, count).status == 'SUBMITTED'
        assert s.get(Stock, stock).on_hand == Decimal('101')
    op.review_cycle_count(a['PHARMACIST'], count, False, 'reject stale')
    with pytest.raises(WorkflowError):
        op.review_cycle_count(a['PHARMACIST'], count, True, 'duplicate')


def test_cycle_count_requires_pharmacist_and_preserves_reservations(env):
    svc, op, a, b, product, stock, expiry = env
    count = op.create_cycle_count(a['TECHNICIAN'])
    op.record_count(a['TECHNICIAN'], count, stock, '92')
    op.submit_cycle_count(a['TECHNICIAN'], count)
    with pytest.raises(AccessDenied):
        op.review_cycle_count(a['TECHNICIAN'], count, True, 'review')
    op.review_cycle_count(a['PHARMACIST'], count, True, 'validated physical count')
    with svc.sessions() as s:
        assert s.get(Stock, stock).on_hand == Decimal('92')
        assert s.get(Stock, stock).reserved == 0
        assert s.get(CycleCountSession, count).status == 'APPROVED'


def test_recall_quarantines_and_blocks_new_scans_and_receipts(env):
    svc, op, a, b, product, stock, expiry = env
    patient = svc.add_patient(a['TECHNICIAN'], 'Test', 'Patient')
    prescriber = svc.add_prescriber(a['TECHNICIAN'], 'Test', 'Clinician', 'MD')
    from pharmacy1os.models import Product
    with svc.sessions() as s:
        drug_id = s.get(Product, product).drug_id
    rx = svc.add_prescription(a['TECHNICIAN'], patient, prescriber, drug_id, 'RECALL-RX', 'daily', '10')
    svc.advance_to_dur(a['TECHNICIAN'], rx)
    fid = svc.start_fill(a['TECHNICIAN'], rx)
    svc.scan_source(a['TECHNICIAN'], fid, 'ITEM-1', 'TESTLOT', expiry, '10')
    svc.prepare_for_review(a['TECHNICIAN'], fid, ['synthetic'])
    recall = op.open_recall(a['PHARMACIST'], product, 'RECALL-001', 'Supplier notification', 'TESTLOT')
    with svc.sessions() as s:
        current = s.get(Stock, stock)
        assert (current.on_hand, current.reserved, current.quarantined) == (
            Decimal('100'), Decimal('10'), Decimal('90'))
        assert s.scalar(select(InventoryHold).where(InventoryHold.recall_id == recall))
    with pytest.raises(WorkflowError, match='recall'):
        svc.verify(a['PHARMACIST'], fid)
    with svc.sessions() as session:
        hold_id = session.scalar(select(InventoryHold.id).where(InventoryHold.recall_id == recall))
    with pytest.raises(WorkflowError, match='recall'):
        InventoryService(svc).resolve_hold(a['PHARMACIST'], hold_id, 'RELEASED', 'unsafe')
    svc.receive(a['TECHNICIAN'], 'ITEM-1', 'TESTLOT', expiry, '5')
    with svc.sessions() as s:
        assert s.get(Stock, stock).quarantined == Decimal('95')
    op.close_recall(a['PHARMACIST'], recall, 'Reviewed synthetic supplier notification')
    with svc.sessions() as s:
        assert s.get(Stock, stock).quarantined == Decimal('95')


def test_ready_fill_cannot_sell_after_recall(env):
    svc, op, a, b, product, stock, expiry = env
    patient = svc.add_patient(a['TECHNICIAN'], 'Test', 'Patient')
    prescriber = svc.add_prescriber(a['TECHNICIAN'], 'Test', 'Clinician', 'MD')
    with svc.sessions() as s:
        from pharmacy1os.models import Product
        drug_id = s.get(Product, product).drug_id
    rx = svc.add_prescription(a['TECHNICIAN'], patient, prescriber, drug_id, 'READY-RECALL', 'daily', '10')
    svc.advance_to_dur(a['TECHNICIAN'], rx)
    fid = svc.start_fill(a['TECHNICIAN'], rx)
    svc.scan_source(a['TECHNICIAN'], fid, 'ITEM-1', 'TESTLOT', expiry, '10')
    svc.prepare_for_review(a['TECHNICIAN'], fid, ['synthetic'])
    svc.verify(a['PHARMACIST'], fid)
    op.open_recall(a['PHARMACIST'], product, 'R2', 'test recall')
    with pytest.raises(WorkflowError, match='recall'):
        svc.sell(a['TECHNICIAN'], fid, True, True, '0', 'cash')
    svc.return_to_stock(a['PHARMACIST'], fid, 'recall found')
    with svc.sessions() as s:
        current = s.get(Stock, stock)
        assert current.on_hand == Decimal('100')
        assert current.quarantined == Decimal('100')


def test_advanced_inventory_api_routes(env):
    svc, op, a, b, product, stock, expiry = env
    client = TestClient(create_app(svc, synthetic_enabled=True))
    h = {'x-demo-staff-id': a['TECHNICIAN'].id}
    # Integration boundary must be available with demo identity but fail closed without it.
    assert client.get('/api/inventory/purchase-orders').status_code == 403
    response = client.get('/api/inventory/purchase-orders', headers=h)
    assert response.status_code == 200, response.text


def test_recall_exposure_tracks_sold_fill_without_mutating_sale(env):
    svc, op, a, b, product, stock, expiry = env
    from pharmacy1os.models import Fill, Product
    p = svc.add_patient(a['TECHNICIAN'], 'Customer', 'Synthetic')
    dr = svc.add_prescriber(a['TECHNICIAN'], 'Provider', 'Synthetic', 'MD')
    with svc.sessions() as session:
        drug = session.get(Product, product).drug_id
    rx = svc.add_prescription(a['TECHNICIAN'], p, dr, drug, 'SOLD-RECALL', 'daily', '5')
    svc.advance_to_dur(a['TECHNICIAN'], rx)
    f = svc.start_fill(a['TECHNICIAN'], rx)
    svc.scan_source(a['TECHNICIAN'], f, 'ITEM-1', 'TESTLOT', expiry, '5')
    svc.prepare_for_review(a['TECHNICIAN'], f)
    svc.verify(a['PHARMACIST'], f)
    svc.sell(a['TECHNICIAN'], f, True, True, '0', 'CASH')
    recall = op.open_recall(a['PHARMACIST'], product, 'EXPOSURE-1', 'Post-sale issue')
    found = op.recalls(a['PHARMACIST'])
    assert len(found) == 1
    assert found[0]['exposures'] == [{'fill_id': f, 'status_at_discovery': 'SOLD'}]
    with svc.sessions() as session:
        assert session.get(Fill, f).status == 'SOLD'
    op.close_recall(a['PHARMACIST'], recall, 'Documentation for closed recall')
    assert op.recalls(a['PHARMACIST'])[0]['exposures'][0]['fill_id'] == f


def test_recalled_po_receipt_is_automatically_quarantined(env):
    svc, op, a, b, product, stock, expiry = env
    op.open_recall(a['PHARMACIST'], product, 'PO-RECALL-1', 'All lots')
    po = op.create_purchase_order(a['TECHNICIAN'], 'Vendor', 'NEW-PO-RECALL',
                                  [{'product_id': product, 'quantity': '10'}])
    line = op.purchase_orders(a['TECHNICIAN'])[0]['lines'][0]['id']
    op.receive_purchase_order(a['TECHNICIAN'], line, 'FRESHLOT', expiry, '10', 'INV-R')
    with svc.sessions() as session:
        new = session.scalar(select(Stock).where(Stock.site_id == a['TECHNICIAN'].site_id,
                    Stock.lot == 'FRESHLOT'))
        assert new.on_hand == Decimal('10')
        assert new.quarantined == Decimal('10')
        assert session.get(PurchaseOrder, po).status == 'RECEIVED'


def test_recalled_transfer_return_remains_quarantined(env):
    svc, op, a, b, product, stock, expiry = env
    transfer = op.ship_transfer(a['PHARMACIST'], stock,
        b['PHARMACIST'].site_id, '7', 'shipment')
    op.open_recall(a['PHARMACIST'], product, 'AFTER-SHIP', 'Lot failure', 'TESTLOT')
    op.cancel_transfer(a['PHARMACIST'], transfer, 'recalled before arrival')
    with svc.sessions() as session:
        rec = session.get(Stock, stock)
        assert rec.on_hand == Decimal('100')
        assert rec.quarantined == Decimal('100')


def test_refill_with_recalled_lot_refused_at_product_fill(env):
    svc, op, a, b, product, stock, expiry = env
    from pharmacy1os.models import Product
    p = svc.add_patient(a['TECHNICIAN'], 'Customer', 'Synthetic')
    dr = svc.add_prescriber(a['TECHNICIAN'], 'Provider', 'Synthetic', 'MD')
    with svc.sessions() as session:
        drug = session.get(Product, product).drug_id
    rx = svc.add_prescription(a['TECHNICIAN'], p, dr, drug, 'SCAN-RECALL', 'daily', '5')
    svc.advance_to_dur(a['TECHNICIAN'], rx)
    f = svc.start_fill(a['TECHNICIAN'], rx)
    op.open_recall(a['PHARMACIST'], product, 'PRE-SCAN', 'Lot failure', 'TESTLOT')
    with pytest.raises(WorkflowError, match='recall'):
        svc.scan_source(a['TECHNICIAN'], f, 'ITEM-1', 'TESTLOT', expiry, '5')
    with svc.sessions() as session:
        assert session.get(Stock, stock).reserved == 0


def test_known_synthetic_sqlite_schema_upgrade(tmp_path):
    from sqlalchemy import text
    svc = PharmacyService(f'sqlite+pysqlite:///{tmp_path / "old_demo.sqlite3"}')
    with svc.engine.begin() as connection:
        connection.exec_driver_sql("""CREATE TABLE py_inventory_holds (
            id VARCHAR(36) PRIMARY KEY, site_id VARCHAR(36), stock_id VARCHAR(36),
            quantity NUMERIC(12,3), reason TEXT, status VARCHAR(25),
            resolution_reason TEXT, created_by_id VARCHAR(36),
            resolved_by_id VARCHAR(36), created_at DATETIME, resolved_at DATETIME)""")
    # SQLAlchemy create_all() won't add missing columns; the isolated synthetic
    # migration path must explicitly add the single new column idempotently.
    svc.create_schema()
    svc.create_schema()
    with svc.engine.begin() as connection:
        columns = {row[1] for row in connection.exec_driver_sql(
            "PRAGMA table_info('py_inventory_holds')").all()}
        assert 'recall_id' in columns
