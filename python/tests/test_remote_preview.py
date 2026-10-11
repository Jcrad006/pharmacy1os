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
    with pytest.raises(ValueError, match="Read-only preview"):
        client._call("POST", f"/api/prescriptions/{rx}/fills", payload={"quantity": "99"})
    with pytest.raises(ValueError, match="Read-only preview"):
        client._call("POST", "/api/fills/mutate")
    with pytest.raises(ValueError, match="Read-only preview"):
        client._call("GET", "/api/auth/logout")


def test_unreachable_server_fails_closed():
    port = None
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    client = LocalSessionWorkstationClient(f"http://127.0.0.1:{port}", timeout=0.5)
    with pytest.raises(WorkstationConnectionError, match="unavailable"):
        client.login("synthetic.staff", "Synthetic Password Only 2026")
