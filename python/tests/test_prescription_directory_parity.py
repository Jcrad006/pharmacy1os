"""Original-inspired read-only Rx queue/detail/audit parity regression.

All records are fictional. No real patient information or dispensing.
"""
import pytest
from fastapi.testclient import TestClient
from pharmacy1os.api import create_app
from pharmacy1os.models import Prescription
from pharmacy1os.service import PharmacyService
from pharmacy1os.prescription_directory import PrescriptionDirectory
from pharmacy1os.prescription_edit import PrescriptionEditService
from pharmacy1os.lifecycle import LifecycleService


@pytest.fixture
def fixture():
    svc = PharmacyService()
    svc.create_schema()
    first = svc.bootstrap_demo()["actors"]
    other = svc.bootstrap_demo()["actors"]
    tech, pharm = first["TECHNICIAN"], first["PHARMACIST"]
    patient = svc.add_patient(tech, "Morgan", "Iverson")
    provider = svc.add_prescriber(tech, "Lena", "Baxter", "MD")
    drug = svc.add_drug(pharm, "Synthetic Lisinopril", "10 mg", "tablet")
    rx = svc.add_prescription(tech, patient, provider, drug, "RX-QUEUE-101",
        "One tablet each morning", "30", refills=2,
        source_type="ELECTRONIC", electronic_message_id="MOCK-ERX-01",
        electronic_raw_message="<sensitive test source>Do not echo me</sensitive test source>")
    another_patient = svc.add_patient(tech, "Jordan", "Fritz")
    rx2 = svc.add_prescription(tech, another_patient, provider, drug,
        "RX-QUEUE-102", "One tablet daily", "20")
    api = TestClient(create_app(svc, synthetic_enabled=True))
    yield svc, first, other, rx, rx2, api
    svc.engine.dispose()


def h(actor):
    return {"x-demo-staff-id": actor.id}


def test_queue_legacy_search_fields_status_filter_and_limits(fixture):
    svc, actors, other, rx, rx2, api = fixture
    route = "/api/prescriptions/queue"
    read = h(actors["AUDITOR"])
    for key in ("iverson", "baxter", "synthetic lisinopril", "queue-101"):
        resp = api.get(route, headers=read, params={"query": key})
        assert resp.status_code == 200, resp.text
        assert rx in [x["id"] for x in resp.json()["prescriptions"]]
    oldest = api.get(route, headers=read, params={"limit": 1, "sort": "oldest"})
    newest = api.get(route, headers=read, params={"limit": 1, "sort": "newest"})
    assert oldest.status_code == 200 and newest.status_code == 200
    assert oldest.json()["meta"]["limit"] == 1
    assert newest.json()["meta"]["sort"] == "newest"
    assert oldest.json()["prescriptions"][0]["id"] != newest.json()["prescriptions"][0]["id"]
    filtered = api.get(route, headers=read,
                       params={"status": "DATA_ENTRY", "limit": 200})
    assert len(filtered.json()["prescriptions"]) == 2
    svc.advance_to_dur(actors["TECHNICIAN"], rx)
    assert [x["id"] for x in api.get(route, headers=read,
        params={"status": "DUR_REVIEW"}).json()["prescriptions"]] == [rx]
    assert api.get(route, headers=read, params={"status": "NOT_A_REAL_STATE"}).status_code == 409
    assert api.get(route, headers=read, params={"limit": 0}).status_code == 409
    assert api.get(route, headers=read, params={"sort": "random"}).status_code == 409


def test_rx_detail_fills_and_immutable_erx_redaction(fixture):
    svc, actors, other, rx, rx2, api = fixture
    tech, pharmacist = actors["TECHNICIAN"], actors["PHARMACIST"]
    svc.advance_to_dur(tech, rx)
    fill_id = svc.start_fill(tech, rx)
    detail = api.get(f"/api/prescriptions/{rx}", headers=h(actors["AUDITOR"]))
    assert detail.status_code == 200, detail.text
    record = detail.json()["prescription"]
    assert record["rxNumber"] == "RX-QUEUE-101"
    assert record["patient"]["lastName"] == "Iverson"
    assert record["prescriber"]["lastName"] == "Baxter"
    assert record["sig"] == "One tablet each morning"
    assert record["sourceType"] == "ELECTRONIC"
    assert record["electronicMessageId"] == "MOCK-ERX-01"
    assert record["fills"][0]["id"] == fill_id
    assert record["fills"][0]["billedQuantity"] == "30.000"
    assert "sensitive test source" not in detail.text
    queue = api.get("/api/prescriptions/queue", headers=h(actors["AUDITOR"]))
    assert "One tablet each morning" not in queue.text
    assert "sensitive test source" not in queue.text
    next_steps = api.get(f"/api/prescriptions/{rx2}",
                         headers=h(actors["AUDITOR"])).json()["prescription"]["allowedTransitions"]
    assert "DUR_REVIEW" in next_steps


def test_prescription_audit_timeline_read_roles_site_isolation(fixture):
    svc, actors, second, rx, rx2, api = fixture
    svc.advance_to_dur(actors["TECHNICIAN"], rx)
    rx_audit = api.get(f"/api/prescriptions/{rx}/audit",
                       headers=h(actors["AUDITOR"]))
    assert rx_audit.status_code == 200, rx_audit.text
    events = rx_audit.json()["events"]
    assert [x["action"] for x in events] == ["RX_DUR_REVIEW", "RX_CREATED"]
    assert all("detail" not in x for x in events)
    assert all(x["actor"]["role"] == "TECHNICIAN" for x in events)
    assert all(x["occurredAt"] for x in events)
    assert api.get(f"/api/prescriptions/{rx}/audit", headers=h(second["AUDITOR"])).status_code == 409
    assert api.get(f"/api/prescriptions/{rx}", headers=h(second["AUDITOR"])).status_code == 409
    assert api.get("/api/prescriptions/queue", headers=h(second["AUDITOR"])).json()["prescriptions"] == []
    assert api.get(f"/api/prescriptions/{rx}/audit", headers=h(actors["CASHIER"]),
                   params={"limit": 1}).json()["meta"]["returned"] == 1


def test_will_call_queue_and_synthetic_disabled_gate(fixture):
    svc, actors, second, rx, rx2, api = fixture
    response = api.get("/api/prescriptions/will-call",
                       headers=h(actors["TECHNICIAN"]))
    assert response.status_code == 200
    assert response.json()["prescriptions"] == []
    with svc.sessions.begin() as s:
        row = s.get(Prescription, rx)
        row.status = "READY"
    current = api.get("/api/prescriptions/will-call", headers=h(actors["AUDITOR"]))
    assert [x["id"] for x in current.json()["prescriptions"]] == [rx]
    assert api.get("/api/prescriptions/queue").status_code == 403
    disabled = TestClient(create_app(svc, synthetic_enabled=False))
    assert disabled.get(f"/api/prescriptions/{rx}",
        headers=h(actors["AUDITOR"])).status_code == 503


def test_single_detail_handler_preserves_both_contracts_and_privacy(fixture):
    svc, actors, _, rx, _, api = fixture
    route = f"/api/prescriptions/{rx}"
    response = api.get(route, headers=h(actors["AUDITOR"]))
    data = response.json()
    assert data["sig"] == data["prescription"]["sig"] == "One tablet each morning"
    assert data["source_type"] == data["prescription"]["sourceType"] == "ELECTRONIC"
    assert data["quantity"] == data["prescription"]["quantityWritten"] == "30.000"
    assert data["electronic_source_recorded"] is True
    assert "electronic_raw_message" not in response.text
    assert "sensitive test source" not in response.text
    schema_paths = api.get("/openapi.json").json()["paths"]
    assert "get" in schema_paths["/api/prescriptions/{rx_id}"]
    assert "patch" in schema_paths["/api/prescriptions/{rx_id}"]
    assert "/api/prescriptions/{prescription_id}" not in schema_paths


def test_reviewed_edits_update_timeline_and_queue_order_without_metadata(fixture):
    svc, actors, _, rx, rx2, api = fixture
    directory = PrescriptionDirectory(svc)
    editor = PrescriptionEditService(svc)
    assert directory.queue(actors["AUDITOR"], sort="newest")["prescriptions"][0]["id"] == rx2
    event = editor.update(actors["PHARMACIST"], rx, {"sig": "Reviewed bedtime directions"},
        expected_version=0, attestation_note="Sensitive clinical note omitted from summary audit")
    assert directory.queue(actors["AUDITOR"], sort="newest")["prescriptions"][0]["id"] == rx
    timeline = api.get(f"/api/prescriptions/{rx}/audit", headers=h(actors["AUDITOR"]))
    assert timeline.json()["events"][0]["entityId"] == event["id"]
    assert timeline.json()["events"][0]["action"] == "RX_EDIT_REVIEWED"
    assert "Sensitive clinical note" not in timeline.text
    assert "Reviewed bedtime directions" not in timeline.text
    other = directory.audit(actors["AUDITOR"], rx2)
    assert event["id"] not in [e["entityId"] for e in other["events"]]


def test_on_hold_is_a_supported_queue_filter(fixture):
    svc, actors, _, rx, _, api = fixture
    LifecycleService(svc).hold(actors["TECHNICIAN"], rx, "Await clarification")
    response = api.get("/api/prescriptions/queue", params={"status": "ON_HOLD"},
        headers=h(actors["AUDITOR"]))
    assert response.status_code == 200
    assert [p["id"] for p in response.json()["prescriptions"]] == [rx]
    assert response.json()["prescriptions"][0]["allowedTransitions"] == ["DATA_ENTRY"]
