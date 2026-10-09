"""Site-isolated synthetic patient directory, ported from patients.ts.

Uses existing Python Patient records; this is not identity matching or deduplication
for real clinical care. Never use with genuine patient information.
"""
from __future__ import annotations

from datetime import date
import re
from typing import Any
from sqlalchemy import select
from .models import Patient
from .service import Actor, PharmacyService, WorkflowError


def normalize_date(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    raw = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T.*", raw):
        raw = raw[:10]
    m = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", raw)
    if m:
        month, day, year = m.groups()
        raw = f"{year}-{int(month):02}-{int(day):02}"
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        raise WorkflowError("DOB must use YYYY-MM-DD or MM/DD/YYYY")
    try:
        result = date.fromisoformat(raw)
    except ValueError as exc:
        raise WorkflowError("DOB is not a valid calendar date") from exc
    if result > date.today():
        raise WorkflowError("DOB cannot be in the future")
    return result.isoformat()


def normalize_phone(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


class PatientDirectory:
    def __init__(self, service: PharmacyService):
        self.service = service

    def create(self, actor: Actor, first: str, last: str, *,
               dob: str | None = None, phone: str | None = None,
               email: str | None = None) -> str:
        if not isinstance(first, str) or not isinstance(last, str):
            raise WorkflowError("Patient first and last names are required")
        first, last = first.strip(), last.strip()
        if not first or not last or len(first) > 100 or len(last) > 100:
            raise WorkflowError("Valid patient first and last names are required")
        if phone is not None and len(phone) > 50:
            raise WorkflowError("Phone number is too long")
        return self.service.add_patient(actor, first, last,
                                        dob=normalize_date(dob),
                                        phone=phone.strip() if phone else None,
                                        email=email.strip() or None if isinstance(email, str) else None)

    def search(self, actor: Actor, *, query: str = "", first_name: str = "",
               last_name: str = "", date_of_birth: str | None = None,
               phone: str = "", limit: int = 100) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise WorkflowError("Patient search limit must be between 1 and 100")
        dob = normalize_date(date_of_birth)
        q = query.strip().casefold()
        firstname = first_name.strip().casefold()
        lastname = last_name.strip().casefold()
        digits = normalize_phone(phone)
        generic_phone = normalize_phone(q) if len(normalize_phone(q)) >= 3 else ""
        name_parts = tuple(part.strip() for part in q.split(",", 1)) if "," in q else None
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            # Site filter is executed in SQL; the remaining search normalization
            # follows the original TypeScript directory semantics.
            rows = s.scalars(select(Patient).where(Patient.site_id == actor.site_id)
                             .order_by(Patient.last_name, Patient.first_name, Patient.id)).all()
            matches = []
            for p in rows:
                fn, ln = p.first_name.casefold(), p.last_name.casefold()
                patient_phone = normalize_phone(p.phone)
                if firstname and not fn.startswith(firstname):
                    continue
                if lastname and not ln.startswith(lastname):
                    continue
                if dob and p.date_of_birth != dob:
                    continue
                if digits and digits not in patient_phone:
                    continue
                if q:
                    if name_parts:
                        if not ln.startswith(name_parts[0]) or (
                            name_parts[1] and not fn.startswith(name_parts[1])):
                            continue
                    elif not (fn.startswith(q) or ln.startswith(q) or
                              (generic_phone and generic_phone in patient_phone)):
                        continue
                matches.append({"id": p.id, "first_name": p.first_name,
                                "last_name": p.last_name, "date_of_birth": p.date_of_birth,
                                "phone": p.phone, "email": p.email,
                                "site_id": p.site_id})
                if len(matches) == limit:
                    break
            return matches
