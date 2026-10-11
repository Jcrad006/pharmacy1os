"""Actual loopback HTTP read-only client contract tests (fictional patients only).

No PySide6 requirement; transport connects to a real Uvicorn socket rather
than calling a PharmacyService directly or using Starlette's TestClient.
"""
from __future__ import annotations

import socket
from threading import Thread
from time import monotonic, sleep

import pytest
import uvicorn

from pharmacy1os.api import create_app
from pharmacy1os.auth import AuthService
from pharmacy1os.remote_preview import LocalSessionWorkstationClient, WorkstationConnectionError
from pharmacy1os.service import PharmacyService


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    monkeypatch.setenv("DOCUMENT_STORAGE_ROOT", str(tmp_path / "vault"))
    svc = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'network-pilot.sqlite3'}")
    svc.create_schema()
    actors = svc.bootstrap_demo()["actors"]
    auth = AuthService(svc)
    site = actors["TECHNICIAN"].site_id
    admin_id = auth.initialize_offline(site, "preview.admin", "Synthetic Only Login 2026!")
    from pharmacy1os.service import Actor
    auth.provision(Actor(admin_id, site, "ADMIN"), actors["TECHNICIAN"].id,
                   "preview.tech", "Synthetic Technician Password 2026!")
    patient = svc.add_patient(actors["TECHNICIAN"], "Synthetic", "Patient")
    prescriber = svc.add_prescriber(actors["TECHNICIAN"], "Synthetic", "Provider", "MD")
    drug = svc.add_drug(actors["PHARMACIST"], "Synthetic Drug", "5 mg", "tablet")
    rx = svc.add_prescription(actors["TECHNICIAN"], patient, prescriber, drug,
                              "NET-RX-101", "Mock once daily", "30")
    outside = svc.bootstrap_demo()["actors"]
    other_patient = svc.add_patient(outside["TECHNICIAN"], "Other", "Site")
    other_provider = svc.add_prescriber(outside["TECHNICIAN"], "Other", "Prescriber", "MD")
    other_rx = svc.add_prescription(outside["TECHNICIAN"], other_patient,
                                   other_provider, drug, "NET-OTHER", "Synthetic", "20")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    app = create_app(svc, synthetic_enabled=True, auth_mode="session")
    instance = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
    instance.install_signal_handlers = lambda: None
    thread = Thread(target=instance.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    deadline = monotonic() + 10
    while not instance.started and monotonic() < deadline:
        sleep(0.02)
    assert instance.started, "loopback synthetic HTTP server failed to start"
    try:
        yield svc, f"http://127.0.0.1:{port}", actors, outside, rx, other_rx, auth
    finally:
        instance.should_exit = True
        thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive()
        svc.engine.dispose()


@pytest.mark.parametrize("url", [
    "http://localhost:8008", "http://0.0.0.0:8008",
    "http://192.168.1.100:8008", "http://127.0.0.2:8008",
    "https://127.0.0.1:8008", "http://admin:password@127.0.0.1:8008",
    "http://127.0.0.1:8008/prescriptions", "http://127.0.0.1:8008/?secret=abc",
    "http://127.0.0.1:8008#fragment", "http://127.0.0.1", "http://127.0.0.1:22",
    "http://[::1]:8008",
])
def test_client_denies_network_hosts_and_bearer_exfiltration(url):
    with pytest.raises(ValueError, match="Preview permits only"):
        LocalSessionWorkstationClient(url)


def test_loopback_client_requires_auth_and_reads_current_server_state(server):
    svc, url, actors, outside, rx, other_rx, auth = server
    reader = LocalSessionWorkstationClient(url)
    with pytest.raises(WorkstationConnectionError, match="Sign in"):
        reader.queue()
    with pytest.raises(WorkstationConnectionError) as failure:
        reader.login("preview.tech", "Wrong password for synthetic test")
    assert failure.value.status == 401
    actor = reader.login("preview.tech", "Synthetic Technician Password 2026!")
    assert actor["role"] == "TECHNICIAN"
    result = reader.queue(query="NET-RX-101")
    assert [item["id"] for item in result["prescriptions"]] == [rx]
    assert other_rx not in [r["id"] for r in reader.queue()["prescriptions"]]
    details = reader.detail(rx)
    assert details["rxNumber"] == "NET-RX-101"
    assert details["patient"]["lastName"] == "Patient"
    assert details["sig"] == "Mock once daily"
    assert "electronic_raw_message" not in str(details)
    svc.advance_to_dur(actors["TECHNICIAN"], rx)
    assert reader.detail(rx)["status"] == "DUR_REVIEW"
    assert reader.queue(status="DUR_REVIEW")["prescriptions"][0]["id"] == rx
    events = reader.audit(rx)
    assert events["events"][0]["action"] == "RX_DUR_REVIEW"
    reader.logout()
    assert reader.identity is None
    with pytest.raises(WorkstationConnectionError, match="Sign in"):
        reader.detail(rx)


def test_server_rejects_cross_site_and_revoked_login(server):
    svc, url, actors, outside, rx, other_rx, auth = server
    client = LocalSessionWorkstationClient(url)
    client.login("preview.tech", "Synthetic Technician Password 2026!")
    assert client.queue(query="NET-OTHER")["prescriptions"] == []
    with pytest.raises(WorkstationConnectionError) as cross_site:
        client.detail(other_rx)
    assert cross_site.value.status == 409
    auth.disable(auth.verify(auth.login("preview.admin", "Synthetic Only Login 2026!")["access_token"]),
                 actors["TECHNICIAN"].id)
    with pytest.raises(WorkstationConnectionError) as revoked:
        client.queue()
    assert revoked.value.status == 401
    assert client.identity is None
    with pytest.raises(WorkstationConnectionError, match="Sign in"):
        client.queue()


def test_client_refuses_arbitrary_paths_and_bad_identifiers(server):
    _svc, url, actors, outside, rx, other_rx, auth = server
    client = LocalSessionWorkstationClient(url)
    client.login("preview.tech", "Synthetic Technician Password 2026!")
    with pytest.raises(ValueError):
        client.detail("../api/auth/me")
    with pytest.raises(ValueError):
        client.audit("a/b")
    with pytest.raises(ValueError):
        client.queue(limit=0)
    with pytest.raises(ValueError):
        client.queue(sort="unknown")
    with pytest.raises(ValueError):
        client._call("GET", "https://example.org")
    with pytest.raises(ValueError, match="refuses this endpoint"):
        client._call("POST", f"/api/prescriptions/{rx}/fills", payload={"quantity": "99"})
    with pytest.raises(ValueError, match="refuses this endpoint"):
        client._call("POST", "/api/fills/mutate")
    with pytest.raises(ValueError, match="refuses this endpoint"):
        client._call("GET", "/api/auth/logout")


def test_unreachable_server_fails_closed():
    port = None
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    client = LocalSessionWorkstationClient(f"http://127.0.0.1:{port}", timeout=0.5)
    with pytest.raises(WorkstationConnectionError, match="unavailable"):
        client.login("synthetic.staff", "Synthetic Password Only 2026")

def test_two_authenticated_workstations_reject_stale_reviewed_sig(server):
    svc, url, actors, outside, rx, other_rx, auth = server
    from pharmacy1os.service import Actor
    admin_token = auth.login("preview.admin", "Synthetic Only Login 2026!")["access_token"]
    admin = auth.verify(admin_token)
    auth.provision(admin, actors["PHARMACIST"].id, "preview.pharm",
                   "Synthetic Pharmacist Password 2026!")
    first = LocalSessionWorkstationClient(url)
    second = LocalSessionWorkstationClient(url)
    first.login("preview.pharm", "Synthetic Pharmacist Password 2026!")
    second.login("preview.pharm", "Synthetic Pharmacist Password 2026!")
    context_a = first.edit_context(rx)
    context_b = second.edit_context(rx)
    assert context_a["editable"] and context_a["version"] == 0
    assert context_b["version"] == 0
    # Capture both editor views from DUR to isolate the version race.
    svc.advance_to_dur(actors["TECHNICIAN"], rx)
    context_a = first.edit_context(rx)
    context_b = second.edit_context(rx)
    assert context_a["status"] == "DUR_REVIEW"
    saved = first.review_sig(
        rx, sig="Synthetic revised directions", expected_version=context_a["version"],
        expected_status=context_a["status"], attestation_note="Reviewed fictitious directions with test prescriber")
    assert saved["version"] == 1 and saved["status"] == "DATA_ENTRY"
    assert second.detail(rx)["sig"] == "Synthetic revised directions"
    with pytest.raises(WorkstationConnectionError) as stale:
        second.review_sig(
            rx, sig="Stale overwrite", expected_version=context_b["version"],
            expected_status=context_b["status"], attestation_note="Another simulated review note for testing")
    assert stale.value.status == 409
    assert second.edit_context(rx)["version"] == 1
    from pharmacy1os.prescription_edit import PrescriptionEditService
    history = PrescriptionEditService(svc).history(actors["AUDITOR"], rx)
    assert len(history) == 1
    assert history[0]["version_before"] == 0 and history[0]["version_after"] == 1
    assert "Reviewed fictitious directions" in history[0]["attestation_note"]
    assert any(e["action"] == "RX_EDIT_REVIEWED" for e in first.audit(rx)["events"])
    assert "fictitious directions" not in str(first.audit(rx))


def test_reviewed_sig_server_enforces_permissions_and_site(server):
    svc, url, actors, outside, rx, other_rx, auth = server
    technician = LocalSessionWorkstationClient(url)
    technician.login("preview.tech", "Synthetic Technician Password 2026!")
    context = technician.edit_context(rx)
    assert not context["editable"] and context["version"] == 0
    with pytest.raises(WorkstationConnectionError) as wrong_role:
        technician.review_sig(
            rx, sig="Unauthorized test edit", expected_version=0,
            expected_status="DATA_ENTRY", attestation_note="Technician cannot self-authorize this change")
    assert wrong_role.value.status == 403
    with pytest.raises(WorkstationConnectionError) as cross_site:
        technician.edit_context(other_rx)
    assert cross_site.value.status == 409
    assert technician.detail(rx)["sig"] == "Mock once daily"


def test_reviewed_sig_client_refuses_non_sig_edits_and_unversioned_patch(server):
    svc, url, actors, outside, rx, other_rx, auth = server
    reader = LocalSessionWorkstationClient(url)
    reader.login("preview.tech", "Synthetic Technician Password 2026!")
    path = f"/api/prescriptions/{rx}"
    bad = [
        {"expected_version": 0, "attestation_note": "Test review note with sufficient length",
         "changes": {"quantity": "200"}},
        {"expected_version": 0, "attestation_note": "Test review note with sufficient length",
         "changes": {"sig": "Synthetic", "source_type": "FAX"}},
        {"expected_version": True, "attestation_note": "Test review note with sufficient length",
         "changes": {"sig": "Synthetic"}},
        {"expected_version": 0, "attestation_note": "too short",
         "changes": {"sig": "Synthetic"}},
    ]
    for payload in bad:
        with pytest.raises(ValueError):
            reader._call("PATCH", path, payload=payload)
    with pytest.raises(ValueError):
        reader._call("POST", path, payload=bad[0])
    with pytest.raises(ValueError):
        reader._call("PATCH", f"/api/fills/{rx}/verify", payload=bad[0])
    assert reader.detail(rx)["sig"] == "Mock once daily"


def test_server_refuses_status_stale_review_without_editor_version_change(server):
    svc, url, actors, outside, rx, other_rx, auth = server
    admin = auth.verify(auth.login("preview.admin", "Synthetic Only Login 2026!")["access_token"])
    auth.provision(admin, actors["PHARMACIST"].id, "preview.statuspharm",
                   "Synthetic Status Reviewer Password 2026!")
    reviewer = LocalSessionWorkstationClient(url)
    reviewer.login("preview.statuspharm", "Synthetic Status Reviewer Password 2026!")
    draft = reviewer.edit_context(rx)
    assert draft["status"] == "DATA_ENTRY" and draft["version"] == 0
    svc.advance_to_dur(actors["TECHNICIAN"], rx)
    with pytest.raises(WorkstationConnectionError) as stale:
        reviewer.review_sig(rx, sig="Stale review must not commit",
            expected_version=draft["version"], expected_status=draft["status"],
            attestation_note="Independent synthetic prescriber review")
    assert stale.value.status == 409
    assert reviewer.detail(rx)["sig"] == "Mock once daily"
    fresh = reviewer.edit_context(rx)
    assert fresh["status"] == "DUR_REVIEW" and fresh["version"] == 0
    saved = reviewer.review_sig(rx, sig="Reviewed after refresh",
        expected_version=fresh["version"], expected_status=fresh["status"],
        attestation_note="Reviewed simulated change after state refresh")
    assert saved["version"] == 1 and saved["status"] == "DATA_ENTRY"


def pharmacist_preview(server, username="field.reviewer"):
    svc, url, actors, outside, rx, other_rx, auth = server
    admin = auth.verify(auth.login(
        "preview.admin", "Synthetic Only Login 2026!")["access_token"])
    auth.provision(admin, actors["PHARMACIST"].id, username,
                   "Synthetic Reviewer Credential 2026!")
    a = LocalSessionWorkstationClient(url)
    a.login(username, "Synthetic Reviewer Credential 2026!")
    return a


def test_multi_field_review_atomic_and_stale_second_operator(server):
    svc, url, actors, outside, rx, other_rx, auth = server
    a = pharmacist_preview(server)
    b = LocalSessionWorkstationClient(url)
    b.login("field.reviewer", "Synthetic Reviewer Credential 2026!")
    svc.advance_to_dur(actors["TECHNICIAN"], rx)
    first, second = a.edit_context(rx), b.edit_context(rx)
    result = a.review_fields(rx,
        changes={"sig": "Synthetic revised directions", "quantity": "45.000",
                 "refills_allowed": 3},
        expected_version=first["version"], expected_status=first["status"],
        attestation_note="Three fields independently verified in synthetic review")
    assert result["version"] == 1 and result["status"] == "DATA_ENTRY"
    assert set(result["changed"]) == {"sig", "quantity", "refills_allowed"}
    current = b.detail(rx)
    assert current["quantityWritten"] == "45.000"
    assert current["refillsAllowed"] == 3
    assert current["sig"] == "Synthetic revised directions"
    with pytest.raises(WorkstationConnectionError) as stale:
        b.review_fields(rx, changes={"quantity": "60"},
            expected_version=second["version"], expected_status=second["status"],
            attestation_note="Second operator must not overwrite prior review")
    assert stale.value.status == 409
    from pharmacy1os.prescription_edit import PrescriptionEditService
    history = PrescriptionEditService(svc).history(actors["AUDITOR"], rx)
    assert len(history) == 1 and len(history[0]["changes"]) == 3


def test_multi_field_local_validation_and_technician_permissions(server):
    svc, url, actors, outside, rx, other_rx, auth = server
    technician = LocalSessionWorkstationClient(url)
    technician.login("preview.tech", "Synthetic Technician Password 2026!")
    context = technician.edit_context(rx)
    bad = [
        {"source_type": "FAX"},
        {"drug_id": "not-an-editable-field"},
        {"quantity": "0"}, {"quantity": "30.1234"},
        {"quantity": "1e10"}, {"quantity": "-1"}, {"quantity": "1,000"},
        {"refills_allowed": True}, {"refills_allowed": 1000},
        {"sig": "  "}, {},
    ]
    for changes in bad:
        with pytest.raises(ValueError):
            technician.review_fields(rx, changes=changes,
                expected_version=context["version"], expected_status=context["status"],
                attestation_note="Synthetic validation sample review note")
    assert technician.detail(rx)["sig"] == "Mock once daily"
    with pytest.raises(WorkstationConnectionError) as denied:
        technician.review_fields(rx, changes={"quantity": "60.000", "refills_allowed": 2},
            expected_version=context["version"], expected_status=context["status"],
            attestation_note="Nonpharmacist cannot attest clinical changes")
    assert denied.value.status == 403
    with pytest.raises(WorkstationConnectionError) as cross_site:
        technician.review_fields(other_rx, changes={"sig": "Forbidden cross-site"},
            expected_version=0, expected_status="DATA_ENTRY",
            attestation_note="Synthetic outside site review must be refused")
    assert cross_site.value.status == 409
    assert technician.edit_context(rx)["version"] == 0


def test_review_field_normalization_and_plain_decimal_only():
    from pharmacy1os.remote_review_fields import (
        checked_review_changes, collect_review_changes)
    original = {"sig": "Mock once daily", "quantity": "30.000", "refills_allowed": 0}
    assert collect_review_changes(original, {
        "sig": "Mock once daily", "quantity": "30", "refills_allowed": 0}) == {}
    assert collect_review_changes(original, {
        "sig": "Mock twice daily", "quantity": "30", "refills_allowed": 2}) == {
        "sig": "Mock twice daily", "refills_allowed": 2}
    assert checked_review_changes({"quantity": "0.125"}) == {"quantity": "0.125"}
    for value in ("0", "0.000", "12.0000", "10e9", "NaN", "+3", "-5", "9999999999"):
        with pytest.raises(ValueError):
            checked_review_changes({"quantity": value})


def test_lost_response_requires_readback_without_automatic_retry(server, monkeypatch):
    svc, url, actors, outside, rx, other_rx, auth = server
    reviewer = pharmacist_preview(server, "disconnected.reviewer")
    baseline = reviewer.edit_context(rx)
    network_call = reviewer._call

    def lose_reply(method, path, **kwargs):
        if method == "PATCH":
            network_call(method, path, **kwargs)
            raise WorkstationConnectionError("Simulated lost reply after database commit")
        return network_call(method, path, **kwargs)

    monkeypatch.setattr(reviewer, "_call", lose_reply)
    with pytest.raises(WorkstationConnectionError, match="lost reply"):
        reviewer.review_fields(rx, changes={"quantity": "60.000", "refills_allowed": 2},
            expected_version=baseline["version"], expected_status=baseline["status"],
            attestation_note="Simulation of submitted review with disconnected workstation")

    inspection = reviewer.inspect_uncertain_edit(rx)
    assert inspection["version"] == 1
    assert inspection["values"]["quantity"] == "60.000"
    assert inspection["values"]["refills_allowed"] == 2
    assert inspection["resolution"] == "MANUAL_REVIEW_REQUIRED_NOT_PROOF_OF_COMMIT"
    assert "RX_EDIT_REVIEWED" in inspection["recent_actions"]
    monkeypatch.setattr(reviewer, "_call", network_call)

    # A deliberate attempted replay with its OLD preconditions fails closed.
    with pytest.raises(WorkstationConnectionError) as replay:
        reviewer.review_fields(rx, changes={"quantity": "60.000", "refills_allowed": 2},
            expected_version=baseline["version"], expected_status=baseline["status"],
            attestation_note="Simulation of submitted review with disconnected workstation")
    assert replay.value.status == 409
    from pharmacy1os.prescription_edit import PrescriptionEditService
    assert len(PrescriptionEditService(svc).history(actors["AUDITOR"], rx)) == 1
