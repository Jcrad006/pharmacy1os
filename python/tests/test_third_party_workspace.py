"""Consolidated synthetic Third Party view mirrors the old screen safely."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from pharmacy1os.api import create_app
from pharmacy1os.claim_rebilling import ClaimRebillService
from pharmacy1os.claim_transactions import SandboxClaimService
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError
from pharmacy1os.third_party_workspace import ThirdPartyWorkspace


@pytest.fixture
def case():
    svc = PharmacyService()
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    tech, pharm = actors["TECHNICIAN"], actors["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "Workspace", phone="919-555-0199")
    doc = svc.add_prescriber(tech, "Synthetic", "Doctor", "MD")
    drug = svc.add_drug(pharm, "Third Party Test Drug", "10mg", "tablet")
    product = svc.add_product(pharm, drug, "55555-0999-01", "Demo", "Synthetic tablet")
    svc.register_barcode(tech, product, "TEST-WORKSPACE-BC")
    exp = (date.today() + timedelta(days=300)).isoformat()
    svc.receive(tech, "TEST-WORKSPACE-BC", "WORKSPACE-LOT", exp, "100")
    rx = svc.add_prescription(tech, patient, doc, drug,
                              "THIRD-PARTY-WORKSPACE", "once daily", "40")
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx)
    svc.scan_source(tech, fill, "TEST-WORKSPACE-BC", "WORKSPACE-LOT", exp, "40")
    return svc, actors, other, patient, rx, fill, exp


def test_workspace_search_coverage_privacy_payer_and_open_test_hold(case):
    svc, a, other, patient, rx, fill, exp = case
    insurance = InsuranceDirectory(svc)
    payer = insurance.create_payer(a["PHARMACIST"], "Demo Pharmacy Plan", bin="123456")
    coverage = insurance.upsert_coverage(
        a["PHARMACIST"], patient, 1, payer, "TEST-SECRET-MEMBER-9384",
        group_id="TEST-SECRET-GROUP", person_code="TEST-SECRET-PERSON")
    txs = SandboxClaimService(svc)
    reject_id = txs.inject_rejection(a["PHARMACIST"], fill, coverage, "TEST_75",
        "SYNTH-OPEN-REJECT-1", "Developers testing local mock rejection queue")
    work = ThirdPartyWorkspace(svc)
    view = work.snapshot(a["AUDITOR"], query="WORKSPACE")
    assert len(view["patients"]) == 1
    assert len(view["payers"]) == 1
    assert view["patients"][0]["id"] == patient
    cover = view["patients"][0]["coverages"][0]
    assert cover["member_id_masked"].endswith("9384")
    assert cover["member_id_masked"] != "TEST-SECRET-MEMBER-9384"
    assert view["claimIssues"][0]["id"] == reject_id
    assert view["claimIssues"][0]["external_payer_rejection"] is False
    assert len(view["recentClaimEvents"]) == 1
    assert view["printQueue"] == [] and view["pendingRebills"] == []
    assert "TEST-SECRET-MEMBER-9384" not in str(view)
    assert "TEST-SECRET-GROUP" not in str(view)
    assert "TEST-SECRET-PERSON" not in str(view)
    assert "123456" not in str(view)
    assert work.snapshot(a["AUDITOR"], query="919-555-0199")["patients"][0]["id"] == patient
    assert work.snapshot(a["AUDITOR"], query="NotThere")["patients"] == []
    assert work.snapshot(other["AUDITOR"])["payers"] == []
    assert work.snapshot(other["AUDITOR"])["claimIssues"] == []
    with pytest.raises(WorkflowError, match="100"):
        work.snapshot(a["AUDITOR"], query="X" * 101)
    txs.resolve_rejection(a["PHARMACIST"], reject_id,
        "Reviewed local development-only rejection and removed hold")
    assert work.snapshot(a["AUDITOR"])["claimIssues"] == []
    # The existing Python permission matrix grants site-scoped read to cashiers.
    assert work.snapshot(a["CASHIER"])["patients"][0]["id"] == patient


def test_workspace_paid_reversal_print_queue_and_new_rebill_attempt(case):
    svc, a, other, patient, rx, fill, exp = case
    view = ThirdPartyWorkspace(svc)
    svc.prepare_for_review(a["TECHNICIAN"], fill, ["Legacy Synthetic Plan"])
    initial = view.snapshot(a["AUDITOR"])
    assert len(initial["printQueue"]) == 1
    assert initial["printQueue"][0]["rx_number"] == "THIRD-PARTY-WORKSPACE"
    assert len(initial["recentClaimEvents"]) == 1
    assert initial["recentClaimEvents"][0]["status"] == "PAID_SYNTHETIC_LOCAL_ONLY"
    assert initial["claimIssues"] == []
    bill = initial["recentClaimEvents"][0]["claim_id"]
    result = ClaimRebillService(svc).restart(a["PHARMACIST"], fill,
        "Original synthetic product claim needs verified manufacturer rescan",
        expected_claim_ids=[bill])
    after = view.snapshot(a["AUDITOR"])
    assert after["printQueue"] == []
    assert len(after["pendingRebills"]) == 1
    assert after["pendingRebills"][0]["replacement_fill_id"] == result["replacement_fill_id"]
    assert after["pendingRebills"][0]["requires_fresh_scans"] is True
    assert {x["operation"] for x in after["recentClaimEvents"]} == {"BILL", "REVERSE"}
    reversed_bill = next(x for x in after["recentClaimEvents"] if x["operation"] == "BILL")
    assert reversed_bill["status"] == "REVERSED_SYNTHETIC"


def test_workspace_api_auth_site_scope_and_disabled_production(case):
    svc, a, outside, patient, rx, fill, exp = case
    enabled = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    path = "/api/third-party/workspace"
    auditor = {"x-demo-staff-id": a["AUDITOR"].id}
    assert disabled.get(path, headers=auditor).status_code == 503
    assert enabled.get(path).status_code == 403
    assert enabled.get(path, headers={"x-demo-staff-id": a["CASHIER"].id}).status_code == 200
    response = enabled.get(path + "?query=Workspace", headers=auditor)
    assert response.status_code == 200, response.text
    assert response.json()["patients"][0]["id"] == patient
    other_response = enabled.get(path, headers={"x-demo-staff-id": outside["AUDITOR"].id})
    assert other_response.status_code == 200
    assert other_response.json()["patients"] == []


def test_workspace_site_scoped_payer_names_even_when_similar(case):
    svc, a, outside, patient, rx, fill, exp = case
    inside_payer = InsuranceDirectory(svc).create_payer(
        a["PHARMACIST"], "Shared Payer Name", bin="987654")
    InsuranceDirectory(svc).create_payer(
        outside["PHARMACIST"], "Shared Payer Name", bin="111111")
    view = ThirdPartyWorkspace(svc)
    assert len(view.snapshot(a["AUDITOR"])["payers"]) == 1
    assert view.snapshot(a["AUDITOR"])["payers"][0]["id"] == inside_payer
    assert len(view.snapshot(outside["AUDITOR"])["payers"]) == 1
    assert view.snapshot(outside["AUDITOR"])["payers"][0]["id"] != inside_payer
