"""Narrow synthetic pre-fill workstation editor input contract.

Client-side checks are only defense in depth; authoritative pharmacist rights,
row locking, quantity/refill eligibility and clinical safeguards live on server.
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

REVIEW_FIELDS = frozenset({"sig", "quantity", "refills_allowed"})
QUANTITY_RE = re.compile(r"(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,3})?\Z")


def checked_review_changes(changes: dict) -> dict:
    if (not isinstance(changes, dict) or not 1 <= len(changes) <= 3
            or not set(changes) <= REVIEW_FIELDS):
        raise ValueError("Only reviewed SIG, quantity and refills are supported")
    normalized = {}
    for key, value in changes.items():
        if key == "sig":
            if not isinstance(value, str) or not 1 <= len(value.strip()) <= 4000:
                raise ValueError("Reviewed SIG must contain 1–4000 characters")
            normalized[key] = value.strip()
        elif key == "quantity":
            if (not isinstance(value, str)
                    or len(value) > 14 or QUANTITY_RE.fullmatch(value) is None
                    or Decimal(value) <= 0):
                raise ValueError("Quantity must be positive, with at most three decimal places")
            normalized[key] = value
        elif key == "refills_allowed":
            if type(value) is not int or not 0 <= value <= 999:
                raise ValueError("Refills must be a whole number between 0 and 999")
            normalized[key] = value
    return normalized


def collect_review_changes(before: dict, after: dict) -> dict:
    """Collect only modified fields: 30.000 and 30 count as identical."""
    if (not isinstance(before, dict) or not isinstance(after, dict)
            or set(after) != REVIEW_FIELDS):
        raise ValueError("Review form requires all three supported fields")
    submitted = checked_review_changes(after)
    changes = {}
    for key, value in submitted.items():
        if key == "quantity":
            try:
                same = Decimal(str(before[key])) == Decimal(value)
            except (KeyError, InvalidOperation, TypeError):
                raise ValueError("Original quantity in the edit context is invalid") from None
        else:
            same = before.get(key) == value
        if not same:
            changes[key] = value
    return changes
