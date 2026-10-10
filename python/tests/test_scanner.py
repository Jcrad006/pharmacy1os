"""GS1 deterministic parse and synthetic receiving/fill integration tests."""
from datetime import date, timedelta
import pytest

from pharmacy1os.barcode import parse_barcode, gs1_date, valid_check_digit
from pharmacy1os.scanner import ScannerService
from pharmacy1os.service import PharmacyService, WorkflowError


def make_check_digit(first: str) -> str:
    for x in '0123456789':
        if valid_check_digit(first + x):
            return first + x
    raise AssertionError('Impossible GTIN input')


def test_check_digits_all_lengths():
    for first in ('12345678901', '012345678901', '1001234567890'):
        valid = make_check_digit(first)
        parsed = parse_barcode(valid)
        assert parsed.identifier == valid
        assert parsed.type == {12:'UPC_A',13:'EAN_13',14:'GTIN_14'}[len(valid)]
        assert parse_barcode(valid[:-1] + str((int(valid[-1])+1)%10)) is None


def test_parenthesized_gs1_and_raw_element_strings():
    gtin = make_check_digit('1001234567890')
    values = [f'(01){gtin}(17)270201(10)BATCH-77(21)SERIAL-5',
              f']d201{gtin}1727020110BATCH-77\x1d21SERIAL-5',
              f']C101{gtin}10BATCH-77\x1d1727020121SERIAL-5']
    for value in values:
        parsed = parse_barcode(value)
        assert parsed and parsed.format == 'GS1' and parsed.identifier == gtin
        assert parsed.lot_number == 'BATCH-77'
        assert parsed.expiration_date == date(2027, 2, 1)
        assert parsed.serial_number == 'SERIAL-5'


def test_gs1_date_validation_and_month_end():
    assert gs1_date('240200') == date(2024, 2, 29)
    assert gs1_date('250200') == date(2025, 2, 28)
    for value in ('251301','250230','abcxyz','250000','250232'):
        assert gs1_date(value) is None


def test_invalid_gs1_never_falls_back_to_other():
    gtin = make_check_digit('1001234567890')
    for raw in (f'(01){gtin}(17)250230', f'(01){gtin}(10)',
                f'01{gtin}17250230', f'01{gtin}10',
                f'(01){gtin}(01){gtin}', f'(01){gtin}(99)HELLO',
                f'01{gtin}10LOT\x1d10DUP', '01not-a-real-gtin123', ''):
        assert parse_barcode(raw) is None


@pytest.fixture
def ctx():
    svc = PharmacyService()
    svc.create_schema()
    people = svc.bootstrap_demo()['actors']
    technician, pharmacist = people['TECHNICIAN'], people['PHARMACIST']
    drug = svc.add_drug(pharmacist,'SyntheticGs1Med','25mg','tablet')
    gtin = make_check_digit('1001234567890')
    prod = svc.add_product(pharmacist,drug,'12345-0102-03','Mock','blue tablet')
    svc.register_barcode(technician,prod,gtin)
    return svc, ScannerService(svc), technician, pharmacist, drug, gtin


def test_scanner_receive_resolves_gs1_fields_and_rejects_mismatch(ctx):
    svc, scanner, tech, pharm, drug, gtin = ctx
    raw = f']d201{gtin}1728111010LOT-1\x1d21SER-1'
    sid = scanner.receive(tech, raw, '90')
    assert sid
    with pytest.raises(WorkflowError, match='lot does not match'):
        scanner.receive(tech, raw, '10', lot='DIFFERENT')
    with pytest.raises(WorkflowError, match='expiration does not match'):
        scanner.receive(tech, raw, '10', expires='2029-01-01')
    with svc.sessions() as s:
        from pharmacy1os.models import Stock
        stock = s.get(Stock, sid)
        assert stock.lot == 'LOT-1' and stock.expires == '2028-11-10'
        assert str(stock.on_hand).startswith('90')


def test_scanner_product_fill_verifies_registered_gs1_metadata(ctx):
    svc, scanner, tech, pharm, drug, gtin = ctx
    raw = f'(01){gtin}(17)281110(10)LOT-2(21)SER2'
    scanner.receive(tech, raw, '60')
    patient = svc.add_patient(tech, 'Test', 'GS1')
    prescriber = svc.add_prescriber(tech, 'Fake','Doctor','MD')
    rx = svc.add_prescription(tech, patient, prescriber, drug, 'RX-GS1', 'Test SIG', '60')
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx)
    scanner.scan_source(tech, fill, raw, '60')
    assert svc.prepare_for_review(tech, fill, ['PAYER'])
    svc.verify(pharm, fill)
    with pytest.raises(WorkflowError):
        scanner.scan_source(tech, fill, raw, '1')


def test_unknown_gtin_is_blocked_even_if_structure_valid(ctx):
    svc, scanner, tech, pharm, drug, _ = ctx
    different = make_check_digit('1999999999999')
    with pytest.raises(WorkflowError, match='not registered'):
        scanner.receive(tech, f'(01){different}(17)281110(10)LOT', '5')
