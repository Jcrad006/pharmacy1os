"""Pure-Python copy of the legacy workflow transition rules.

The rest of the system is migrated independently. All checks in this module are
domain rules, not authentication or regulatory compliance.
"""
from __future__ import annotations

from typing import Final

ROLE_PERMISSIONS: Final[dict[str, frozenset[str]]] = {
    "ADMIN": frozenset(("entry", "process", "verify", "sell", "inventory", "correct", "clinical", "read")),
    "PHARMACIST": frozenset(("entry", "process", "verify", "sell", "inventory", "correct", "clinical", "read")),
    "TECHNICIAN": frozenset(("entry", "process", "sell", "inventory", "read")),
    "INTERN": frozenset(("entry", "process", "read")),
    "CASHIER": frozenset(("sell", "read")),
    "AUDITOR": frozenset(("read",)),
}

TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    "RECEIVED": frozenset(("DATA_ENTRY", "ON_HOLD", "CANCELLED", "TRANSFERRED")),
    "DATA_ENTRY": frozenset(("DUR_REVIEW", "ON_HOLD", "CANCELLED", "TRANSFERRED")),
    "DUR_REVIEW": frozenset(("ON_HOLD", "CANCELLED", "TRANSFERRED")),
    "PRODUCT_FILL": frozenset(("PHARMACIST_REVIEW", "ON_HOLD", "CANCELLED")),
    "PHARMACIST_REVIEW": frozenset(("READY", "PRODUCT_FILL", "ON_HOLD", "CANCELLED")),
    "READY": frozenset(("SOLD", "ON_HOLD", "CANCELLED")),
    "SOLD": frozenset(("DUR_REVIEW", "ON_HOLD", "CANCELLED", "TRANSFERRED")),
    "CANCELLED": frozenset(),
    "TRANSFERRED": frozenset(),
}

def allowed_transitions(status: str, held_from_status: str | None = None) -> frozenset[str]:
    if status == "ON_HOLD":
        return (frozenset((held_from_status, "CANCELLED", "TRANSFERRED"))
                if held_from_status in TRANSITIONS else frozenset(("CANCELLED", "TRANSFERRED")))
    return TRANSITIONS[status]

def can_transition(status: str, target: str, held_from_status: str | None = None) -> bool:
    return target in allowed_transitions(status, held_from_status)

def required_permission(status: str, target: str) -> str:
    if status == "PHARMACIST_REVIEW" and target == "READY":
        return "verify"
    if status == "READY" and target == "SOLD":
        return "sell"
    return "process"

def role_can_transition(role: str, status: str, target: str,
                        held_from_status: str | None = None) -> bool:
    return (can_transition(status, target, held_from_status)
            and required_permission(status, target) in ROLE_PERMISSIONS.get(role, frozenset()))
