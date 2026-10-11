"""Synthetic native-workstation recovery orchestration.

Persist metadata BEFORE PATCH. On restart, reconcile by authenticated GET.
Never replay or infer success from NOT_RECORDED or unrelated edit history.
"""
from __future__ import annotations

from .remote_preview import LocalSessionWorkstationClient, WorkstationConnectionError
from .workstation_recovery_journal import JournalSafetyError, WorkstationRecoveryJournal


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
        return {"site_id": account["site_id"], "staff_id": account["staff_id"],
                "base_url": self.client.base_url}

    def submit(self, rx_id: str, *, changes: dict, expected_version: int,
               expected_status: str, attestation_note: str) -> dict:
        """No HTTP call unless the pending metadata was safely fsynced."""
        from .remote_review_fields import checked_review_changes
        if not 12 <= len(attestation_note.strip()) <= 2000:
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

    def reconcile(self, *, limit: int = 8) -> dict:
        """Only authenticated read requests; never automatically PATCH.

        Bounded read batch avoids making the Qt UI unresponsive while checking
        requests. A recorded receipt is correlated with one exact UUID.
        """
        if type(limit) is not int or not 1 <= limit <= 16:
            raise ValueError("Reconciliation batch must be between 1 and 16")
        scope = self._scope()
        pending = self.journal.entries_for(**scope, state="PENDING")
        report = {"checked": 0, "recorded": 0, "uncertain": 0,
                  "errors": [], "remaining": len(pending)}
        for entry in pending[:limit]:
            report["checked"] += 1
            try:
                result = self.client.review_request_status(
                    entry["prescription_id"], entry["request_id"])
            except (WorkstationConnectionError, ValueError) as exc:
                # Avoid including any eRx, staff credentials or review content
                # in journal state or error report.
                report["errors"].append({"request_id": entry["request_id"],
                                         "type": "LOOKUP_FAILED"})
                continue
            if result["state"] == "RECORDED":
                self.journal.mark_recorded(
                    site_id=scope["site_id"], staff_id=scope["staff_id"],
                    request_id=entry["request_id"])
                report["recorded"] += 1
            else:
                report["uncertain"] += 1
        report["remaining"] = len(self.journal.entries_for(
            **scope, state="PENDING"))
        return report

    def acknowledge(self, request_id: str) -> None:
        """Called only after the operator explicitly confirms recorded receipt."""
        scope = self._scope()
        self.journal.acknowledge_recorded(
            site_id=scope["site_id"], staff_id=scope["staff_id"],
            request_id=request_id)
