"""Qt-only off-main-thread receipt lookup for synthetic native workstations.

No disk/journal mutation, SQLAlchemy service, prescription edits or Qt widgets
inside the worker. All journal updates run back on the GUI main thread.
"""
from __future__ import annotations

from PySide6.QtCore import QThread, Signal


class RecoveryLookupThread(QThread):
    completed = Signal(object)

    def __init__(self, recovery, batch, parent=None):
        super().__init__(parent)
        self.recovery = recovery
        self.batch = batch

    def run(self):
        try:
            result = self.recovery.lookup_receipts(self.batch)
            self.completed.emit(("ok", result))
        except Exception:
            # Fail closed without emitting sensitive review content, tokens or
            # HTTP error bodies into Qt status widgets.
            self.completed.emit(("error", None))
