"""Synthetic native-workstation recovery orchestration.

Persist metadata BEFORE PATCH. On restart, reconcile by authenticated GET.
Never replay or infer success from NOT_RECORDED or unrelated edit history.
"""
from __future__ import annotations

from dataclasses import dataclass

from .remote_preview import LocalSessionWorkstationClient, WorkstationConnectionError
from .workstation_recovery_journal import JournalSafetyError, WorkstationRecoveryJournal


@dataclass(frozen=True)
class RecoveryLookupBatch:
    """Immutable account scope plus request/Rx identifier pairs, no pharmacy content."""
    scope: tuple[str, str, str]
    entries: tuple[tuple[str, str], ...]


class ReviewedEditRecovery:
    def __init__(self, client: LocalSessionWorkstationClient,
                 journal: WorkstationRecoveryJournal):
        self.client = client
        self.journal = journal
        if client.identity is None:
            raise JournalSafetyError("Sign in before opening the recovery controller")
        if client.identity["role"] not in ("PHARMACIST", "ADMIN"):
            raise JournalSafetyError("Only a clinical reviewer can submit or reconcile edits")

    def _scope(self) -> dict:
        account = self.client.identity
        if account is None:
            raise JournalSafetyError("Session ended; sign in before reconciliation")
        if account["role"] not in ("PHARMACIST", "ADMIN"):
            raise JournalSafetyError("Review permissions changed; sign in with an authorized account")
        return {"site_id": account["site_id"], "staff_id": account["staff_id"],
                "base_url": self.client.base_url}

    def submit(self, rx_id: str, *, changes: dict, expected_version: int,
               expected_status: str, attestation_note: str) -> dict:
        """No HTTP call unless the pending metadata was safely fsynced."""
        from .remote_review_fields import checked_review_changes
        if (not isinstance(attestation_note, str)
                or not 12 <= len(attestation_note.strip()) <= 2000):
            raise ValueError("Documented review attestation is required")
        checked_review_changes(changes)
        rx_id = self.client._id(rx_id)
        request_id = self.client.new_review_request_id()
        scope = self._scope()
        self.journal.register(request_id=request_id, prescription_id=rx_id,
                              **scope)
        # The exception is deliberately NOT caught here: retaining PENDING is
        # safer than silently treating a lost response as a failed request.
        receipt = self.client.review_fields(
            rx_id, changes=changes, expected_version=expected_version,
            expected_status=expected_status, attestation_note=attestation_note,
            request_id=request_id)
        if receipt.get("request_id") != request_id:
            raise WorkstationConnectionError("Mismatched HTTP mutation response")
        self.journal.mark_recorded(
            site_id=scope["site_id"], staff_id=scope["staff_id"],
            request_id=request_id)
        return receipt

    def outstanding(self) -> list[dict]:
        return self.journal.entries_for(**self._scope())

    def prepare_lookup(self, *, limit: int = 8,
                       request_id: str | None = None) -> RecoveryLookupBatch:
        """UI/main-thread operation: snapshot private journal under its lock.

        No networking and no UI data content captured. Explicit request_id can
        refer to a PENDING or RECORDED receipt for manual acknowledgement.
        """
        if type(limit) is not int or not 1 <= limit <= 16:
            raise ValueError("Reconciliation batch must be between 1 and 16")
        scope = self._scope()
        if request_id is None:
            chosen = self.journal.entries_for(**scope, state="PENDING")[:limit]
        else:
            from .remote_preview import _request_id
            key = _request_id(request_id)
            chosen = [entry for entry in self.journal.entries_for(**scope)
                      if entry["request_id"] == key]
            if len(chosen) != 1:
                raise JournalSafetyError("Selected request ID is not in this account's journal")
        return RecoveryLookupBatch(
            scope=(scope["site_id"], scope["staff_id"], scope["base_url"]),
            entries=tuple((item["request_id"], item["prescription_id"])
                          for item in chosen))

    def lookup_receipts(self, batch: RecoveryLookupBatch) -> tuple[dict, ...]:
        """Network-only phase; safe to run on a Qt worker thread.

        There is intentionally NO journal access and NO HTTP mutation in this
        function. Never retain or emit clinical change content.
        """
        if not isinstance(batch, RecoveryLookupBatch) or len(batch.entries) > 16:
            raise JournalSafetyError("Invalid recovery request batch")
        results = []
        for request_id, rx_id in batch.entries:
            try:
                answer = self.client.review_request_status(rx_id, request_id)
            except (WorkstationConnectionError, ValueError):
                results.append({"request_id": request_id, "prescription_id": rx_id,
                                "state": "LOOKUP_FAILED"})
                continue
            if answer["state"] == "RECORDED":
                receipt = answer["result"]
                results.append({
                    "request_id": request_id, "prescription_id": rx_id,
                    "state": "RECORDED", "review_id": receipt["id"],
                    "version": receipt["version"]})
            else:
                results.append({"request_id": request_id, "prescription_id": rx_id,
                                "state": "NOT_RECORDED"})
        return tuple(results)

    def apply_lookup(self, batch: RecoveryLookupBatch,
                     responses: tuple[dict, ...]) -> dict:
        """UI/main-thread phase: verify current account and persist outcomes.

        Only a specific receipt verified by the existing authenticated client
        can move a previously PENDING journal entry to RECORDED.
        """
        scope = self._scope()
        expected = (scope["site_id"], scope["staff_id"], scope["base_url"])
        if not isinstance(batch, RecoveryLookupBatch) or batch.scope != expected:
            raise JournalSafetyError("Recovery session changed since request lookup")
        if not isinstance(responses, tuple) or len(responses) != len(batch.entries):
            raise JournalSafetyError("Recovery response count does not match requested batch")
        entries = {item["request_id"]: item for item in self.journal.entries_for(**scope)}
        details = []
        seen = set()
        report = {"checked": 0, "recorded": 0, "uncertain": 0,
                  "errors": [], "remaining": 0, "details": details}
        for (request_id, rx_id), item in zip(batch.entries, responses):
            if request_id in seen or not isinstance(item, dict):
                raise JournalSafetyError("Duplicated/malformed recovery result")
            seen.add(request_id)
            local = entries.get(request_id)
            if (local is None or local["prescription_id"] != rx_id
                    or item.get("request_id") != request_id
                    or item.get("prescription_id") != rx_id):
                raise JournalSafetyError("Recovery receipt identity or account mismatch")
            state = item.get("state")
            if state not in ("RECORDED", "NOT_RECORDED", "LOOKUP_FAILED"):
                raise JournalSafetyError("Unrecognized recovery receipt state")
            report["checked"] += 1
            if state == "RECORDED":
                if not isinstance(item.get("review_id"), str) or (
                        type(item.get("version")) is not int
                        or item["version"] < 1):
                    raise JournalSafetyError("Invalid committed review receipt")
                self.journal.mark_recorded(
                    site_id=scope["site_id"], staff_id=scope["staff_id"],
                    request_id=request_id)
                report["recorded"] += 1
            elif state == "NOT_RECORDED":
                report["uncertain"] += 1
            else:
                report["errors"].append({"request_id": request_id,
                                         "type": "LOOKUP_FAILED"})
            details.append(dict(item))
        report["remaining"] = len(self.journal.entries_for(
            **scope, state="PENDING"))
        return report

    def reconcile(self, *, limit: int = 8) -> dict:
        """Synchronous compatibility API for tests/CLI; never retry a PATCH.

        Native Qt delegates only lookup_receipts to a QThread and applies the
        results on the main thread, so recovery GETs do not block the UI.
        """
        batch = self.prepare_lookup(limit=limit)
        result = self.apply_lookup(batch, self.lookup_receipts(batch))
        result.pop("details")
        return result

    def acknowledge(self, request_id: str) -> None:
        """Called only after the operator explicitly confirms recorded receipt."""
        scope = self._scope()
        self.journal.acknowledge_recorded(
            site_id=scope["site_id"], staff_id=scope["staff_id"],
            request_id=request_id)
