"""Synthetic workstation network calls that never execute in the Qt GUI thread.

Only approved local-session API operations. A review PATCH is idempotent on
the server but MUST NOT be automatically retried after a lost response.
Journal mutations intentionally belong to the UI thread instead.
"""
from __future__ import annotations

from PySide6.QtCore import QThread, Signal

from .remote_preview import WorkstationConnectionError


ALLOWED_OPERATIONS = frozenset({
    "queue", "detail", "audit", "edit_context", "submit_review",
})


def dispatch_workstation_request(client, operation: str, arguments: dict):
    """Narrow operation router without raw URL, dynamic method or SQL access."""
    if operation not in ALLOWED_OPERATIONS or not isinstance(arguments, dict):
        raise ValueError("Unsupported workstation operation")
    if operation == "queue":
        if set(arguments) != {"query", "status", "sort", "limit"}:
            raise ValueError("Invalid synthetic queue request")
        return client.queue(**arguments)
    if operation in ("detail", "audit", "edit_context"):
        allowed = {"rx_id"} if operation != "audit" else {"rx_id", "limit"}
        if set(arguments) != allowed:
            raise ValueError("Invalid synthetic detail request")
        if operation == "detail":
            return client.detail(arguments["rx_id"])
        if operation == "audit":
            return client.audit(**arguments)
        return client.edit_context(arguments["rx_id"])
    if set(arguments) != {
        "rx_id", "changes", "expected_version", "expected_status",
        "attestation_note", "request_id",
    }:
        raise ValueError("Invalid reviewed edit request")
    return client.review_fields(**arguments)


class WorkstationRequestThread(QThread):
    completed = Signal(object)

    def __init__(self, client, operation: str, arguments: dict, parent=None):
        super().__init__(parent)
        if operation not in ALLOWED_OPERATIONS:
            raise ValueError("Unsupported workstation operation")
        self.client = client
        self.operation = operation
        self.arguments = dict(arguments)

    def run(self):
        try:
            value = dispatch_workstation_request(
                self.client, self.operation, self.arguments)
            self.completed.emit(("ok", value))
        except WorkstationConnectionError as exc:
            # The HTTP client intentionally translates status codes; returning
            # only the code avoids UI leakage of arbitrary server bodies.
            self.completed.emit(("error", {
                "category": "HTTP", "status": exc.status,
            }))
        except Exception:
            # Never emit SIGs, review notes, passwords, HTTP responses or trace.
            self.completed.emit(("error", {
                "category": "UNEXPECTED", "status": None,
            }))
        finally:
            # Do not keep reviewed content in a completed QThread longer than
            # necessary. The client owns the authenticated token in memory.
            self.arguments = {}
