"""Real Qt event-loop checks for synthetic workstation HTTP workers."""
from __future__ import annotations
import os
from threading import Event
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import pytest
pytest.importorskip("PySide6.QtCore")
from PySide6.QtCore import QCoreApplication, QEventLoop, QObject, QThread, QTimer, Slot, Qt
from pharmacy1os.qt_workstation_worker import WorkstationRequestThread, dispatch_workstation_request
from pharmacy1os.remote_preview import WorkstationConnectionError


@pytest.fixture(scope="module")
def app():
    return QCoreApplication.instance() or QCoreApplication([])


class Receiver(QObject):
    def __init__(self, loop):
        super().__init__()
        self.loop = loop
        self.values = []
        self.threads = []

    @Slot(object)
    def done(self, value):
        self.values.append(value)
        self.threads.append(QThread.currentThread())
        self.loop.quit()


def run_worker(client, operation, payload, on_tick=None):
    loop = QEventLoop()
    receiver = Receiver(loop)
    thread = WorkstationRequestThread(client, operation, payload)
    thread.completed.connect(receiver.done, Qt.ConnectionType.QueuedConnection)
    if on_tick:
        QTimer.singleShot(25, on_tick)
    QTimer.singleShot(5000, loop.quit)
    thread.start()
    try:
        loop.exec()
    finally:
        assert thread.wait(5000), "Synthetic HTTP thread did not finish"
    assert receiver.threads == [QThread.currentThread()]
    assert len(receiver.values) == 1
    assert thread.arguments == {}
    return receiver.values[0]


def test_slow_queue_request_does_not_block_qt_timer(app):
    waiting = Event()
    fired = []
    gui_thread = QThread.currentThread()
    class SlowClient:
        def queue(self, **kwargs):
            assert QThread.currentThread() != gui_thread
            assert kwargs["query"] == "mock"
            assert waiting.wait(timeout=3)
            return {"prescriptions": [{"rxNumber": "mock"}]}
    outcome = run_worker(SlowClient(), "queue",
        {"query": "mock", "status": None, "sort": "oldest", "limit": 100},
        on_tick=lambda: (fired.append(True), waiting.set()))
    assert fired == [True]
    assert outcome == ("ok", {"prescriptions": [{"rxNumber": "mock"}]})


def test_approved_detail_audit_and_review_context_reads(app):
    called = []
    class Client:
        def detail(self, rx_id):
            called.append("detail")
            return {"id": rx_id}
        def audit(self, rx_id, *, limit):
            called.append("audit")
            return {"events": []}
        def edit_context(self, rx_id):
            called.append("edit_context")
            return {"editable": False}
    obj = Client()
    assert run_worker(obj, "detail", {"rx_id": "mock"}) == ("ok", {"id": "mock"})
    assert run_worker(obj, "audit", {"rx_id": "mock", "limit": 100}) == ("ok", {"events": []})
    assert run_worker(obj, "edit_context", {"rx_id": "mock"}) == ("ok", {"editable": False})
    assert called == ["detail", "audit", "edit_context"]


def test_lost_patch_response_is_one_call_and_error_is_redacted(app):
    calls = []
    ui_thread = QThread.currentThread()
    class LostResponse:
        def review_fields(self, **kwargs):
            assert QThread.currentThread() != ui_thread
            calls.append(kwargs)
            raise WorkstationConnectionError("PRIVATE_MOCK_REVIEW_NOTE")
    payload = {"rx_id": "mock", "changes": {"sig": "PRIVATE_MOCK_SIG"},
        "expected_version": 0, "expected_status": "DUR_REVIEW",
        "attestation_note": "PRIVATE_MOCK_REVIEW_NOTE", "request_id": "mock-id"}
    outcome = run_worker(LostResponse(), "submit_review", payload)
    assert outcome == ("error", {"category": "HTTP", "status": None})
    assert calls == [payload] and "PRIVATE_MOCK" not in str(outcome)


def test_unapproved_operations_and_payloads_are_rejected():
    for method in ("claim", "refund", "delete", "fill"):
        with pytest.raises(ValueError, match="Unsupported"):
            WorkstationRequestThread(object(), method, {})
    with pytest.raises(ValueError, match="Invalid"):
        dispatch_workstation_request(object(), "submit_review", {"rx_id": "mock"})
    with pytest.raises(ValueError, match="Invalid"):
        dispatch_workstation_request(object(), "queue", {
            "query": "", "status": None, "sort": "oldest", "limit": 100, "extra": "bad"})


def test_unexpected_worker_errors_do_not_emit_source_content(app):
    class Bad:
        def detail(self, _):
            raise RuntimeError("PRIVATE_MOCK_SOURCE_MESSAGE")
    assert run_worker(Bad(), "detail", {"rx_id": "mock"}) == (
        "error", {"category": "UNEXPECTED", "status": None})
