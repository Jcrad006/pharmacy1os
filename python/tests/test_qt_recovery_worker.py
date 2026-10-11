"""Actual Qt event-loop verification for nonblocking synthetic receipt recovery.

Only network read lookups belong on worker thread. The journal remains owned
by the GUI thread, and an unresponsive lookup must not stall Qt timers.
"""
from __future__ import annotations

import os
from threading import Event, current_thread

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6.QtCore")
from PySide6.QtCore import QCoreApplication, QEventLoop, QTimer, QThread, QObject, Slot, Qt

from pharmacy1os.qt_recovery_worker import RecoveryLookupThread
from pharmacy1os.workstation_recovery import RecoveryLookupBatch


@pytest.fixture(scope="module")
def app():
    return QCoreApplication.instance() or QCoreApplication([])


class MainThreadReceiver(QObject):
    """Real QObject slot, guaranteeing main-thread queued delivery."""
    def __init__(self, loop):
        super().__init__()
        self.loop = loop
        self.values = []
        self.threads = []

    @Slot(object)
    def receive(self, result):
        self.values.append(result)
        self.threads.append(QThread.currentThread())
        self.loop.quit()


def test_receipt_network_wait_runs_on_worker_and_qt_loop_remains_responsive(app):
    gate = Event()
    lookup_started = Event()
    gui_thread = QThread.currentThread()
    fired = []
    batch = RecoveryLookupBatch(
        scope=("synthetic-site", "synthetic-staff", "http://127.0.0.1:8008"),
        entries=(("test-request-1", "test-rx-1"),))

    class SlowReadOnlyRecovery:
        def lookup_receipts(self, snapshot):
            assert snapshot is batch
            assert QThread.currentThread() != gui_thread
            lookup_started.set()
            assert gate.wait(timeout=3), "GUI timer must release worker"
            return ({"request_id": "test-request-1", "prescription_id": "test-rx-1",
                     "state": "NOT_RECORDED"},)

    loop = QEventLoop()
    worker = RecoveryLookupThread(SlowReadOnlyRecovery(), batch)
    receiver = MainThreadReceiver(loop)
    worker.completed.connect(receiver.receive, Qt.ConnectionType.QueuedConnection)

    def gui_timeout_release():
        fired.append(QThread.currentThread() == gui_thread)
        gate.set()

    QTimer.singleShot(30, gui_timeout_release)
    QTimer.singleShot(3000, loop.quit)
    worker.start()
    try:
        loop.exec()
    finally:
        gate.set()
        assert worker.wait(3000)
    assert lookup_started.is_set()
    assert fired == [True], "Qt main event loop was blocked by network lookup"
    assert receiver.threads == [gui_thread]
    assert receiver.values == [("ok", ({"request_id": "test-request-1",
                            "prescription_id": "test-rx-1",
                            "state": "NOT_RECORDED"},))]


def test_worker_failure_emits_redacted_error_without_leaking_exception_message(app):
    batch = RecoveryLookupBatch(scope=("site", "staff", "loopback"), entries=())
    class BrokenServer:
        def lookup_receipts(self, _batch):
            raise RuntimeError("SYNTHETIC_PRIVATE_REVIEW_NOTE_DO_NOT_LEAK")

    loop = QEventLoop()
    worker = RecoveryLookupThread(BrokenServer(), batch)
    receiver = MainThreadReceiver(loop)
    worker.completed.connect(receiver.receive, Qt.ConnectionType.QueuedConnection)
    QTimer.singleShot(3000, loop.quit)
    worker.start()
    try:
        loop.exec()
    finally:
        assert worker.wait(3000)
    assert receiver.threads == [QThread.currentThread()]
    assert receiver.values == [("error", None)]
