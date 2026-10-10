"""Actual offscreen Qt interactions against an isolated synthetic database."""
import os
from datetime import date, timedelta

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6.QtWidgets")
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QMessageBox

from pharmacy1os.desktop_prescription import PrescriptionDetailDialog
from pharmacy1os.models import Prescription, Staff
from pharmacy1os.prescription_edit import PrescriptionEditService
from pharmacy1os.scheduling import SchedulingService
from pharmacy1os.service import PharmacyService


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture
def setup(app):
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    outside = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "NativeEditor")
    prescriber = svc.add_prescriber(tech, "Original", "Doctor", "MD")
    other_prescriber = svc.add_prescriber(tech, "Second", "Doctor", "NP")
    foreign_prescriber = svc.add_prescriber(outside["TECHNICIAN"], "Outside", "Doctor", "MD")
    drug = svc.add_drug(pharm, "Synthetic original", "10 mg", "tablet")
    other_drug = svc.add_drug(pharm, "Synthetic replacement", "20 mg", "tablet")
    product = svc.add_product(pharm, drug, "00000-0050-01", "Maker A", "Example tablet")
    other_product = svc.add_product(pharm, other_drug, "00000-0050-02", "Maker B", "Example replacement")
    rx = svc.add_prescription(tech, patient, prescriber, drug, "NATIVE-001", "Take daily", "30",
        refills=2, expiration_date=(date.today() + timedelta(days=365)).isoformat(),
        source_type="ELECTRONIC", electronic_message_id="MOCK-NATIVE-ERX",
        electronic_raw_message="PRIVATE_SYNTHETIC_RAW_MESSAGE", prescribed_product_id=product)
    current = [pharm]
    dialogs = []

    def open_dialog():
        dialog = PrescriptionDetailDialog(svc, lambda: current[0], rx)
        dialogs.append(dialog)
        dialog.show()
        app.processEvents()
        return dialog

    yield dict(svc=svc, actors=actors, outside=outside, rx=rx, current=current,
        drug=drug, product=product, other_drug=other_drug, other_product=other_product,
        other_prescriber=other_prescriber, foreign_prescriber=foreign_prescriber,
        open=open_dialog)
    for dialog in dialogs:
        dialog.editing = False
        dialog.close()
    app.processEvents()
    svc.engine.dispose()


def click(button):
    QTest.mouseClick(button, Qt.MouseButton.LeftButton)
    QApplication.processEvents()


def test_native_multi_field_save_resets_dur_and_refreshes_histories(setup):
    e = setup
    e["svc"].advance_to_dur(e["actors"]["TECHNICIAN"], e["rx"])
    dialog = e["open"]()
    assert dialog.context and dialog.context["editable"]
    assert dialog.fields["prescriber_id"].findData(e["foreign_prescriber"]) == -1
    click(dialog.edit_button)
    assert dialog.save_button.isEnabled()
    dialog.fields["sig"].setPlainText("Take one tablet at bedtime")
    dialog.fields["quantity"].setText("60")
    dialog.fields["refills_allowed"].setValue(3)
    dialog.fields["expiration_date"].clear()
    dialog.attestation.setPlainText("Confirmed synthetic prescriber correction for this test")
    click(dialog.save_button)
    assert "Saved version 1" in dialog.message.text()
    assert "DATA_ENTRY" in dialog.summary.text()
    assert dialog.edit_table.rowCount() == 4
    assert "PHARMACIST" in dialog.edit_table.item(0, 5).text()
    assert dialog.audit_table.item(0, 1).text() == "RX_EDIT_REVIEWED"
    with e["svc"].sessions() as s:
        rx = s.get(Prescription, e["rx"])
        assert rx.sig == "Take one tablet at bedtime" and rx.quantity == 60
        assert rx.refills_allowed == 3 and rx.expiration_date is None
        assert rx.electronic_raw_message == "PRIVATE_SYNTHETIC_RAW_MESSAGE"
    assert "PRIVATE_SYNTHETIC_RAW_MESSAGE" not in str(dialog.snapshot)


def test_native_drug_ndc_and_prescriber_change_is_one_reviewed_save(setup):
    e = setup
    dialog = e["open"]()
    click(dialog.edit_button)
    drug = dialog.fields["drug_id"]
    drug.setCurrentIndex(drug.findData(e["other_drug"]))
    product = dialog.fields["prescribed_product_id"]
    assert product.findData(e["product"]) == -1
    assert product.currentData() is None
    product.setCurrentIndex(product.findData(e["other_product"]))
    provider = dialog.fields["prescriber_id"]
    provider.setCurrentIndex(provider.findData(e["other_prescriber"]))
    directive = dialog.fields["product_selection_directive"]
    directive.setCurrentIndex(directive.findData("DISPENSE_AS_WRITTEN"))
    dialog.attestation.setPlainText("Reviewed synthetic medication and exact NDC correction")
    click(dialog.save_button)
    with e["svc"].sessions() as s:
        rx = s.get(Prescription, e["rx"])
        assert rx.version == 1
        assert rx.drug_id == e["other_drug"] and rx.prescribed_product_id == e["other_product"]
        assert rx.prescriber_id == e["other_prescriber"]
        assert rx.product_selection_directive == "DISPENSE_AS_WRITTEN"


def test_native_stale_save_retains_input_without_overwriting_other_workstation(setup):
    e = setup
    dialog = e["open"]()
    click(dialog.edit_button)
    dialog.fields["sig"].setPlainText("My stale proposed directions")
    dialog.attestation.setPlainText("Local synthetic review before concurrent modification")
    PrescriptionEditService(e["svc"]).update(e["actors"]["PHARMACIST"], e["rx"],
        {"sig": "Newer verified directions"}, 0, "Other workstation pharmacist reviewed the change")
    click(dialog.save_button)
    assert "version changed" in dialog.message.text()
    assert dialog.fields["sig"].toPlainText() == "My stale proposed directions"
    assert dialog.context["version"] == 0
    with e["svc"].sessions() as s:
        assert s.get(Prescription, e["rx"]).sig == "Newer verified directions"


@pytest.mark.parametrize("change", ["actor", "inactive"])
def test_native_identity_rechecked_before_save_and_private_form_cleared(setup, change):
    e = setup
    dialog = e["open"]()
    click(dialog.edit_button)
    dialog.fields["sig"].setPlainText("Must not be saved")
    dialog.attestation.setPlainText("Synthetic change on a stale or disabled session")
    if change == "actor":
        e["current"][0] = e["outside"]["PHARMACIST"]
    else:
        with e["svc"].sessions.begin() as s:
            s.get(Staff, e["current"][0].id).active = False
    click(dialog.save_button)
    assert "Save blocked" in dialog.message.text()
    assert dialog.snapshot is None and dialog.context is None
    assert dialog.fields["sig"].toPlainText() == ""
    assert not dialog.save_button.isEnabled()
    with e["svc"].sessions() as s:
        assert s.get(Prescription, e["rx"]).version == 0


def test_native_readonly_roles_and_cross_site_load(setup):
    e = setup
    e["current"][0] = e["actors"]["TECHNICIAN"]
    dialog = e["open"]()
    assert "NativeEditor" in dialog.summary.text()
    assert not dialog.edit_button.isEnabled()
    dialog.begin_edit()
    assert not dialog.save_button.isEnabled()
    e["current"][0] = e["outside"]["AUDITOR"]
    assert dialog.reload() is False
    assert dialog.snapshot is None and dialog.summary.text() == ""
    assert dialog.audit_table.rowCount() == 0


def test_native_fill_source_claim_and_label_history_remains_readonly(setup):
    e = setup
    svc, tech = e["svc"], e["actors"]["TECHNICIAN"]
    svc.register_barcode(tech, e["product"], "NATIVE-BC")
    expiry = (date.today() + timedelta(days=365)).isoformat()
    svc.receive(tech, "NATIVE-BC", "LOT-NATIVE", expiry, "100")
    svc.advance_to_dur(tech, e["rx"])
    fill = svc.start_fill(tech, e["rx"])
    svc.scan_source(tech, fill, "NATIVE-BC", "LOT-NATIVE", expiry, "30")
    svc.prepare_for_review(tech, fill, ["Synthetic payer"])
    dialog = e["open"]()
    assert dialog.fill_table.rowCount() == 1
    assert dialog.source_table.item(0, 2).text() == "LOT-NATIVE"
    assert dialog.claim_table.item(0, 1).text() == "Synthetic payer"
    assert dialog.label_table.item(0, 0).text() == "1 of 1"
    assert dialog.label_table.item(0, 2).text() == "30.000 / 30.000"
    assert not dialog.edit_button.isEnabled()


def test_native_pending_schedule_blocks_edit_and_reload_discards_only_on_request(setup, monkeypatch):
    e = setup
    dialog = e["open"]()
    click(dialog.edit_button)
    dialog.fields["sig"].setPlainText("Uncommitted proposal")
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Cancel)
    assert not dialog.reload()
    assert dialog.fields["sig"].toPlainText() == "Uncommitted proposal"
    svc, tech = e["svc"], e["actors"]["TECHNICIAN"]
    svc.advance_to_dur(tech, e["rx"])
    SchedulingService(svc).schedule(tech, e["rx"],
        (date.today() + timedelta(days=7)).isoformat(), "NATIVE-SCHEDULE")
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Discard)
    assert dialog.reload()
    assert dialog.fields["sig"].toPlainText() == "Take daily"
    assert "pending future fills" in dialog.edit_hint.text()
    assert not dialog.edit_button.isEnabled()
