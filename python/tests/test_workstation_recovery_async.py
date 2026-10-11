"""Increment 67: network-only recovery batches and safe UI-thread journal apply.

No PySide6 dependency: the handoff contract below is deliberately testable
without a display, and the actual Qt QThread delegates ONLY lookup_receipts.
All identities and prescriptions are synthetic.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

import pytest

from pharmacy1os.workstation_recovery import (
    RecoveryLookupBatch, ReviewedEditRecovery,
)
from pharmacy1os.workstation_recovery_journal import (
    JournalSafetyError, WorkstationRecoveryJournal,
)


class FakeClient:
    def __init__(self, *, staff=None, site=None):
        self.identity = {
            "staff_id": staff or str(uuid4()),
            "site_id": site or str(uuid4()),
            "role": "PHARMACIST",
        }
        self.base_url = "http://127.0.0.1:8008"
        self.answers = {}
        self.calls = []
        self.started = Event()
        self.release = Event()
        self.delay_reads = False

    def review_request_status(self, rx_id, request_id):
        self.calls.append(("GET", rx_id, request_id))
        if self.delay_reads:
            self.started.set()
            if not self.release.wait(timeout=5):
                raise RuntimeError("Fake test server was not released")
        return self.answers.get(request_id, {
            "state": "NOT_RECORDED", "request_id": request_id,
            "safe_to_retry": False,
        })


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARMACY1OS_SYNTHETIC_DEMO", "1")
    client = FakeClient()
    with WorkstationRecoveryJournal(tmp_path / "async-reviews") as journal:
        recovery = ReviewedEditRecovery(client, journal)
        yield client, journal, recovery


def add(recovery, *, count=1):
    scope = recovery._scope()
    keys = []
    for _ in range(count):
        rx_id, key = str(uuid4()), str(uuid4())
        recovery.journal.register(request_id=key, prescription_id=rx_id, **scope)
        keys.append((key, rx_id))
    return keys


def test_slow_network_lookup_cannot_modify_journal_before_ui_apply(setup):
    client, journal, recovery = setup
    (key, rx_id), = add(recovery)
    client.answers[key] = {
        "state": "RECORDED", "request_id": key,
        "result": {"id": str(uuid4()), "request_id": key,
                   "prescription_id": rx_id, "version": 1},
    }
    batch = recovery.prepare_lookup()
    client.delay_reads = True
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(recovery.lookup_receipts, batch)
        assert client.started.wait(timeout=3)
        # While server response is stalled, UI-thread journal operations
        # remain available and the worker has not written any state.
        assert recovery.outstanding()[0]["state"] == "PENDING"
        client.release.set()
        answer = future.result(timeout=5)
    assert recovery.outstanding()[0]["state"] == "PENDING"
    assert answer[0]["state"] == "RECORDED"
    report = recovery.apply_lookup(batch, answer)
    assert report["checked"] == 1 and report["recorded"] == 1
    assert report["remaining"] == 0
    assert recovery.outstanding()[0]["state"] == "RECORDED"
    assert all(method == "GET" for method, _, _ in client.calls)


def test_lookups_are_read_only_and_not_recorded_stays_pending(setup):
    client, journal, recovery = setup
    first, second = add(recovery, count=2)
    client.answers[first[0]] = {
        "state": "RECORDED", "request_id": first[0],
        "result": {"id": str(uuid4()), "request_id": first[0],
                   "prescription_id": first[1], "version": 8},
    }
    batch = recovery.prepare_lookup()
    received = recovery.lookup_receipts(batch)
    assert len(received) == 2
    assert recovery.outstanding()[0]["state"] == "PENDING"
    outcome = recovery.apply_lookup(batch, received)
    assert outcome["recorded"] == 1 and outcome["uncertain"] == 1
    assert outcome["remaining"] == 1
    assert next(x for x in recovery.outstanding()
                if x["request_id"] == second[0])["state"] == "PENDING"
    assert len(client.calls) == 2


def test_account_change_blocks_background_result_apply(setup):
    client, journal, recovery = setup
    (key, rx_id), = add(recovery)
    client.answers[key] = {
        "state": "RECORDED", "request_id": key,
        "result": {"id": str(uuid4()), "request_id": key,
                   "prescription_id": rx_id, "version": 1},
    }
    batch = recovery.prepare_lookup()
    received = recovery.lookup_receipts(batch)
    client.identity = {**client.identity, "staff_id": str(uuid4())}
    with pytest.raises(JournalSafetyError, match="session changed"):
        recovery.apply_lookup(batch, received)
    client.identity = {**client.identity, "staff_id": batch.scope[1]}
    assert recovery.outstanding()[0]["state"] == "PENDING"


def test_late_malformed_batch_fails_before_any_entry_is_marked(setup):
    client, journal, recovery = setup
    first, second = add(recovery, count=2)
    batch = recovery.prepare_lookup()
    malformed = (
        {"request_id": first[0], "prescription_id": first[1],
         "state": "RECORDED", "review_id": str(uuid4()), "version": 1},
        {"request_id": second[0], "prescription_id": str(uuid4()),
         "state": "RECORDED", "review_id": str(uuid4()), "version": 1},
    )
    with pytest.raises(JournalSafetyError, match="identity"):
        recovery.apply_lookup(batch, malformed)
    assert all(x["state"] == "PENDING" for x in recovery.outstanding())


def test_reconcile_is_bounded_and_only_manual_selected_receipts_can_be_queried(setup):
    client, journal, recovery = setup
    keys = add(recovery, count=4)
    with pytest.raises(ValueError, match="between"):
        recovery.prepare_lookup(limit=17)
    batch = recovery.prepare_lookup(limit=2)
    assert batch.entries == tuple(keys[:2])
    single = recovery.prepare_lookup(request_id=keys[3][0], limit=1)
    assert single.entries == (keys[3],)
    with pytest.raises(JournalSafetyError, match="not in this account"):
        recovery.prepare_lookup(request_id=str(uuid4()))
    assert isinstance(batch, RecoveryLookupBatch)
    assert not client.calls


def test_worker_network_failure_never_changes_local_receipt_state(setup):
    client, journal, recovery = setup
    (key, rx_id), = add(recovery)
    def down(_rx, _key):
        raise RuntimeError("Injected broken demo network")
    # Unexpected errors fail closed rather than silently treating as missing.
    client.review_request_status = down
    batch = recovery.prepare_lookup()
    with pytest.raises(RuntimeError):
        recovery.lookup_receipts(batch)
    assert recovery.outstanding()[0]["state"] == "PENDING"
