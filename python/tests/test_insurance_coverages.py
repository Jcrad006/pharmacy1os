"""Payer/coverage and COB snapshot parity tests. Synthetic-only."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pharmacy1os.api import create_app
from pharmacy1os.insurance import InsuranceDirectory
from pharmacy1os.insurance_models import ClaimCoverageSnapshot, InsurancePayer, PatientCoverage
from pharmacy1os.models import Claim, Fill, Prescription
from pharmacy1os.service import AccessDenied, PharmacyService, WorkflowError


@pytest.fixture
def env():
    svc = PharmacyService()
    svc.create_schema()
    a = svc.bootstrap_demo()["actors"]
    foreign = svc.bootstrap_demo()["actors"]
    tech, pharmacist = a["TECHNICIAN"], a["PHARMACIST"]
    patient = svc.add_patient(tech, "Synthetic", "Covered")
    provider = svc.add_prescriber(tech, "Synthetic", "Doctor", "MD")
    drug = svc.add_drug(pharmacist, "Coverage test", "10mg", "tablet")
    prod = svc.add_product(pharmacist, drug, "22222-3333-44", "Demo", "Synthetic tablets")
    svc.register_barcode(tech, prod, "COVER-BC")
    exp = (date.today() + timedelta(days=300)).isoformat()
    svc.receive(tech, "COVER-BC", "COVER-LOT", exp, "200")
    rx = svc.add_prescription(tech, patient, provider, drug,
        "SYN-COVER-RX", "once daily", "90", refills=1)
    svc.advance_to_dur(tech, rx)
    fill = svc.start_fill(tech, rx, "60")
    svc.scan_source(tech, fill, "COVER-BC", "COVER-LOT", exp, "60")
    return svc, a, foreign, patient, rx, fill, InsuranceDirectory(svc)


def _payers(env):
    svc, a, _, patient, rx, fill, flow = env
    p1 = flow.create_payer(a["PHARMACIST"], "Synthetic Plan A",
        bin="123456", pcn="AB01", default_group_id="GROUP")
    p2 = flow.create_payer(a["PHARMACIST"], "Synthetic Plan B", bin="987654")
    c1 = flow.upsert_coverage(a["PHARMACIST"], patient, 1, p1, "SYN-MEMBER-1111",
        person_code="01", effective_date=(date.today()-timedelta(days=2)).isoformat())
    c2 = flow.upsert_coverage(a["PHARMACIST"], patient, 2, p2, "SYN-MEMBER-2222")
    return p1, p2, c1, c2


def test_payer_and_coverage_registration_is_site_isolated_and_redacted(env):
    svc, a, foreign, patient, rx, fill, flow = env
    with pytest.raises(AccessDenied):
        flow.create_payer(a["TECHNICIAN"], "Unauthorized")
    p1, p2, c1, c2 = _payers(env)
    payers = flow.list_payers(a["AUDITOR"])
    assert [p["name"] for p in payers] == ["Synthetic Plan A", "Synthetic Plan B"]
    assert payers[0]["bin"] == "123456"
    assert flow.list_payers(foreign["AUDITOR"]) == []
    public = flow.list_coverages(a["TECHNICIAN"], patient)
    assert [p["position"] for p in public] == [1, 2]
    assert public[0]["member_id_masked"].endswith("1111")
    assert "SYN-MEMBER-1111" not in repr(public)
    # Correct cross-site denial must not leak whether patient exists.
    with pytest.raises(WorkflowError, match="site|not found|pharmacy"):
        flow.list_coverages(foreign["AUDITOR"], patient)
    with pytest.raises(WorkflowError, match="active payer"):
        flow.upsert_coverage(a["PHARMACIST"], patient, 3,
                             "00000000-0000-0000-0000-000000000000", "SYN")
    with pytest.raises(WorkflowError, match="not found at actor's pharmacy site"):
        flow.upsert_coverage(foreign["PHARMACIST"], patient, 1, p1, "CROSS-SITE")
    with svc.sessions() as s:
        assert len(s.scalars(select(InsurancePayer)).all()) == 2
        assert len(s.scalars(select(PatientCoverage)).all()) == 2


def test_connected_cob_claims_preserve_snapshot_and_do_not_duplicate_intended_quantity(env):
    svc, a, foreign, patient, rx, fill, flow = env
    p1, p2, c1, c2 = _payers(env)
    bottles = svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[c1, c2])
    assert len(bottles) == 1
    with svc.sessions() as s:
        claims = s.scalars(select(Claim).where(Claim.fill_id == fill)
                           .order_by(Claim.sequence)).all()
        assert len(claims) == 2
        assert [c.payer for c in claims] == ["Synthetic Plan A", "Synthetic Plan B"]
        assert [c.sequence for c in claims] == [1, 2]
        assert all(c.status == "PAID_SYNTHETIC" for c in claims)
        assert all(str(c.billed_quantity) == "90.000" for c in claims)
        snapshots = s.scalars(select(ClaimCoverageSnapshot).where(
            ClaimCoverageSnapshot.fill_id == fill)
            .order_by(ClaimCoverageSnapshot.coverage_position)).all()
        assert len(snapshots) == 2
        assert snapshots[0].member_id_snapshot == "SYN-MEMBER-1111"
        assert snapshots[1].coverage_id == c2
        assert snapshots[0].physical_quantity_snapshot == "60.000"
        assert snapshots[0].intended_quantity_snapshot == "90.000"
    history = flow.fill_claim_history(a["AUDITOR"], fill)
    assert len(history) == 2
    assert history[0]["member_id_masked"].endswith("1111")
    assert "SYN-MEMBER-1111" not in repr(history)
    with pytest.raises(WorkflowError):
        flow.fill_claim_history(foreign["AUDITOR"], fill)
    # Coverage changes cannot silently rewrite active claim provenance.
    with pytest.raises(WorkflowError, match="Active paid"):
        flow.upsert_coverage(a["PHARMACIST"], patient, 1, p2, "CHANGE-REFUSED")
    with pytest.raises(WorkflowError, match="Active paid"):
        flow.deactivate_coverage(a["PHARMACIST"], patient, 1, "Cannot alter current payer")
    with pytest.raises(WorkflowError, match="Active paid"):
        flow.set_payer_active(a["PHARMACIST"], p1, False, "Cannot retire active paid claim")


def test_coverage_order_and_active_status_errors_roll_back_fill_labels(env):
    svc, a, foreign, patient, rx, fill, flow = env
    p1, p2, c1, c2 = _payers(env)
    for ids, match in (
        ([c2, c1], "order"), ([c1, c1], "Duplicate"),
        ([c2], "order"), ([], "One to four"),
        ([c1, "not-a-real-coverage"], "does not belong"),
    ):
        with pytest.raises(WorkflowError, match=match):
            svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=ids)
    with pytest.raises(WorkflowError, match="mix"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, ["Legacy name"], coverage_ids=[c1])
    with svc.sessions() as s:
        assert s.scalars(select(Claim)).all() == []
        assert s.scalars(select(ClaimCoverageSnapshot)).all() == []
        assert s.get(Fill, fill).status == "PRODUCT_FILL"


def test_dates_and_deactivation_prevent_adjudication(env):
    svc, a, foreign, patient, rx, fill, flow = env
    p1 = flow.create_payer(a["PHARMACIST"], "Expired synthetic")
    tomorrow = (date.today()+timedelta(days=1)).isoformat()
    yesterday = (date.today()-timedelta(days=1)).isoformat()
    c1 = flow.upsert_coverage(a["PHARMACIST"], patient, 1, p1,
        "SYN-EXPIRED-1234", effective_date=tomorrow)
    with pytest.raises(WorkflowError, match="not yet effective"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[c1])
    flow.upsert_coverage(a["PHARMACIST"], patient, 1, p1, "SYN-EXPIRED-1234",
        termination_date=yesterday)
    with pytest.raises(WorkflowError, match="terminated"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[c1])
    flow.deactivate_coverage(a["PHARMACIST"], patient, 1, "Synthetic coverage withdrawn")
    with pytest.raises(WorkflowError, match="Inactive patient"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[c1])
    flow.upsert_coverage(a["PHARMACIST"], patient, 1, p1, "SYN-EXPIRED-1234")
    flow.set_payer_active(a["PHARMACIST"], p1, False, "Test payer inactive")
    with pytest.raises(WorkflowError, match="Inactive or missing payer"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[c1])
    with svc.sessions() as s:
        assert s.scalars(select(ClaimCoverageSnapshot)).all() == []


@pytest.mark.parametrize("kwargs,match", [
    ({"position": 0}, "position"), ({"position": 5}, "position"),
    ({"relationship": "UNKNOWN"}, "relationship"),
    ({"effective_date": "2026-02-30"}, "Invalid Effective"),
    ({"effective_date": "2026-01-02", "termination_date": "2026-01-01"}, "precedes"),
    ({"cardholder_date_of_birth": "2999-12-31"}, "future"),
])
def test_coverage_invalid_input_rejected(env, kwargs, match):
    svc, a, foreign, patient, rx, fill, flow = env
    payer = flow.create_payer(a["PHARMACIST"], "My synthetic plan")
    position = kwargs.pop("position", 1)
    with pytest.raises(WorkflowError, match=match):
        flow.upsert_coverage(a["PHARMACIST"], patient, position, payer,
                             "FAKE-MEMBER", **kwargs)


def test_payer_validation_and_protects_unimplemented_strategy(env):
    svc, a, foreign, patient, rx, fill, flow = env
    with pytest.raises(WorkflowError, match="BIN"):
        flow.create_payer(a["PHARMACIST"], "Malformed", bin="0A3456")
    with pytest.raises(WorkflowError, match="claim standard"):
        flow.create_payer(a["PHARMACIST"], "Malformed", claim_standard="F99")
    payer = flow.create_payer(a["PHARMACIST"], "Manual payer",
                               billing_ndc_strategy="REQUIRE_MANUAL_SELECTION")
    cov = flow.upsert_coverage(a["PHARMACIST"], patient, 1, payer, "MEMBER-0001")
    with pytest.raises(WorkflowError, match="lacks an implemented"):
        svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[cov])


def test_reversal_retains_snapshot_and_allows_future_coverage_change(env):
    svc, a, foreign, patient, rx, fill, flow = env
    p1, p2, c1, c2 = _payers(env)
    svc.prepare_for_review(a["TECHNICIAN"], fill, [], coverage_ids=[c1])
    svc.verify(a["PHARMACIST"], fill)
    svc.return_to_stock(a["PHARMACIST"], fill, "Synthetic patient changed decision")
    flow.deactivate_coverage(a["PHARMACIST"], patient, 1, "Now safe to deactivate")
    history = flow.fill_claim_history(a["AUDITOR"], fill)
    assert history[0]["coverage_id"] == c1
    with svc.sessions() as s:
        assert s.scalar(select(Claim).where(Claim.fill_id == fill)).status == "REVERSED_SYNTHETIC"
        assert s.get(PatientCoverage, c1).active is False


def test_api_payer_and_four_position_coverage_routes_and_synthetic_gating(env):
    svc, a, foreign, patient, rx, fill, flow = env
    api = TestClient(create_app(svc, synthetic_enabled=True))
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    pharm = {"x-demo-staff-id": a["PHARMACIST"].id}
    tech = {"x-demo-staff-id": a["TECHNICIAN"].id}
    outer = {"x-demo-staff-id": foreign["PHARMACIST"].id}
    base = "/api/third-party/payers"
    assert disabled.get(base, headers=tech).status_code == 503
    assert api.post(base, json={"name": "Unauthorized"}, headers=tech).status_code == 403
    assert api.get(base).status_code == 403
    payer = api.post(base, headers=pharm, json={
        "name": "Demo API Payer", "bin": "121212"})
    assert payer.status_code == 201, payer.text
    payer_id = payer.json()["id"]
    assert len(api.get(base, headers=tech).json()["payers"]) == 1
    assert api.get(base, headers=outer).json()["payers"] == []
    covurl = f"/api/patients/{patient}/coverages/1"
    response = api.put(covurl, headers=pharm, json={
        "payer_id": payer_id, "member_id": "SECRET-SYN-3456"})
    assert response.status_code == 200, response.text
    cov_id = response.json()["id"]
    listed = api.get(f"/api/patients/{patient}/coverages", headers=tech)
    assert listed.status_code == 200
    assert listed.json()["coverages"][0]["id"] == cov_id
    assert "SECRET-SYN-3456" not in listed.text
    assert api.put(covurl, headers=outer, json={
        "payer_id": payer_id, "member_id": "CROSS-SITE"}).status_code == 409
    prepare = api.post(f"/api/fills/{fill}/prepare", headers=tech, json={
        "payers": [], "coverage_ids": [cov_id]})
    assert prepare.status_code == 200, prepare.text
    claim_history = api.get(f"/api/fills/{fill}/coverage-claim-history", headers=tech)
    assert claim_history.status_code == 200
    assert claim_history.json()["items"][0]["coverage_id"] == cov_id
    assert "SECRET-SYN-3456" not in claim_history.text
    assert api.request("DELETE", covurl, headers=pharm,
                       json={"reason": "Active paid claim"}).status_code == 409
