"""Synthetic original-style prescriber directory, independent of FastAPI and Qt.

The legacy Fastify POST /prescribers creates demographics and all child
records in a single database transaction. This adapter preserves that important
atomicity instead of chaining separate Python create calls. It DOES NOT
authenticate NPI/DEA credentials or authorize real patient data.
"""
from __future__ import annotations

from typing import Any

from pydantic import AliasChoices, BaseModel, Field
from sqlalchemy import select

from .models import Prescriber
from .patient_directory import normalize_date, normalize_phone
from .provider_directory import (
    ProviderAddress, ProviderContact, ProviderIdentifier, _normalized_identifier,
    _required,
)
from .service import Actor, PharmacyService, WorkflowError


class IdentifierInput(BaseModel):
    type: str
    number: str
    jurisdiction: str = ""
    is_primary: bool = Field(default=False, validation_alias=AliasChoices("isPrimary", "is_primary"))


class ContactInput(BaseModel):
    type: str
    value: str
    label: str = ""
    extension: str = ""
    is_primary: bool = Field(default=False, validation_alias=AliasChoices("isPrimary", "is_primary"))


class AddressInput(BaseModel):
    address_line1: str = Field(validation_alias=AliasChoices("addressLine1", "line1"))
    city: str
    state: str
    postal_code: str = Field(validation_alias=AliasChoices("postalCode", "postal_code"))
    address_line2: str = Field(default="", validation_alias=AliasChoices("addressLine2", "line2"))
    label: str = ""
    is_primary: bool = Field(default=False, validation_alias=AliasChoices("isPrimary", "is_primary"))


class PrescriberContractIn(BaseModel):
    first_name: str = Field(validation_alias=AliasChoices("firstName", "first"))
    last_name: str = Field(validation_alias=AliasChoices("lastName", "last"))
    practice_level: str = Field(default="UNKNOWN", validation_alias=AliasChoices("practiceLevel", "level"))
    date_of_birth: str | None = Field(default=None, validation_alias=AliasChoices("dateOfBirth", "dob"))
    identifiers: list[IdentifierInput] = Field(default_factory=list, max_length=30)
    contacts: list[ContactInput] = Field(default_factory=list, max_length=30)
    addresses: list[AddressInput] = Field(default_factory=list, max_length=30)
    npi: str | None = None
    dea_number: str | None = Field(default=None, validation_alias=AliasChoices("deaNumber", "dea"))
    state_provider_id: str | None = Field(default=None, validation_alias=AliasChoices("stateProviderId", "state_provider_id"))
    state_provider_id_state: str | None = Field(default=None, validation_alias=AliasChoices("stateProviderIdState", "state_provider_id_state"))
    phone: str | None = None
    fax: str | None = None


class PrescriberParityService:
    def __init__(self, pharmacy: PharmacyService):
        self.pharmacy = pharmacy

    @staticmethod
    def _prepare(payload: PrescriberContractIn) -> tuple[dict, list[dict], list[dict], list[dict]]:
        first = _required(payload.first_name, "Provider first name", 100)
        last = _required(payload.last_name, "Provider last name", 100)
        level = _required(payload.practice_level or "UNKNOWN", "Practice level", 30).upper()
        dob = normalize_date(payload.date_of_birth)
        demo_identifiers = [x.model_dump() for x in payload.identifiers]
        state = (payload.state_provider_id_state or "").strip().upper()
        for kind, number, jurisdiction in (
            ("NPI", payload.npi, ""),
            ("DEA", payload.dea_number, state),
            ("STATE_ID", payload.state_provider_id, state),
        ):
            if number and number.strip():
                demo_identifiers.append({"type": kind, "number": number,
                    "jurisdiction": jurisdiction, "is_primary": True})

        if sum(str(item["type"]).strip().upper() == "NPI" for item in demo_identifiers) > 1:
            raise WorkflowError("A prescriber may have only one NPI")

        identifiers: list[dict] = []
        seen: set[tuple[str, str, str]] = set()
        for value in demo_identifiers:
            kind = _required(value["type"], "Identifier type", 20).upper()
            if kind not in {"NPI", "DEA", "STATE_ID", "OTHER"}:
                raise WorkflowError("Unsupported identifier type")
            number = _required(value["number"], "Identifier number", 80)
            normalized = _normalized_identifier(number)
            if not normalized:
                raise WorkflowError("Identifier must contain letters or numbers")
            jurisdiction = str(value.get("jurisdiction") or "").strip().upper()
            if len(jurisdiction) > 10:
                raise WorkflowError("Identifier jurisdiction too long")
            if kind == "STATE_ID" and not jurisdiction:
                raise WorkflowError("State provider IDs require a jurisdiction")
            key = (kind, normalized, jurisdiction)
            if key in seen:
                continue
            seen.add(key)
            identifiers.append({"type": kind, "number": number, "normalized": normalized,
                "jurisdiction": jurisdiction, "is_primary": bool(value.get("is_primary"))})
        # Enforce the Python uniqueness model: primary identifier per type/jurisdiction.
        primary_ids: set[tuple[str, str]] = set()
        for row in identifiers:
            group = (row["type"], row["jurisdiction"])
            if row["is_primary"]:
                if group in primary_ids:
                    raise WorkflowError("Only one primary identifier per type and jurisdiction")
                primary_ids.add(group)
        for row in identifiers:
            group = (row["type"], row["jurisdiction"])
            if group not in primary_ids:
                row["is_primary"] = True
                primary_ids.add(group)

        contacts_in = [x.model_dump() for x in payload.contacts]
        for kind, number in (("PHONE", payload.phone), ("FAX", payload.fax)):
            if number and number.strip():
                contacts_in.append({"type": kind, "value": number,
                                    "label": "Main", "extension": "", "is_primary": True})
        contacts = []
        seen_contacts = set()
        for item in contacts_in:
            kind = _required(item["type"], "Contact type", 15).upper()
            if kind not in {"PHONE", "FAX"}:
                raise WorkflowError("Contact type must be PHONE or FAX")
            value = _required(item["value"], "Contact value", 80)
            digits = normalize_phone(value)
            if not 7 <= len(digits) <= 15:
                raise WorkflowError("Contact value must contain 7-15 digits")
            extension = (item.get("extension") or "").strip()
            if len(extension) > 20:
                raise WorkflowError("Contact extension too long")
            key = (kind, digits, extension)
            if key in seen_contacts:
                continue
            seen_contacts.add(key)
            contacts.append({"kind": kind, "value": value, "normalized": digits,
                "extension": extension,
                "label": (item.get("label") or "").strip()[:80],
                "is_primary": bool(item.get("is_primary"))})
        for kind in ("PHONE", "FAX"):
            relevant = [row for row in contacts if row["kind"] == kind]
            primaries = [row for row in relevant if row["is_primary"]]
            if len(primaries) > 1:
                raise WorkflowError("Only one primary phone or fax is permitted")
            if relevant and not primaries:
                relevant[0]["is_primary"] = True

        addresses = []
        for item in payload.addresses:
            addresses.append({
                "line1": _required(item.address_line1, "Street address", 150),
                "line2": (item.address_line2 or "").strip()[:150],
                "city": _required(item.city, "City", 100),
                "state": _required(item.state, "State", 30).upper(),
                "postal_code": _required(item.postal_code, "Postal code", 30),
                "label": (item.label or "").strip()[:80],
                "is_primary": item.is_primary,
            })
        if sum(row["is_primary"] for row in addresses) > 1:
            raise WorkflowError("Only one primary provider address is permitted")
        if addresses and not any(row["is_primary"] for row in addresses):
            addresses[0]["is_primary"] = True
        return {"first_name": first, "last_name": last, "practice_level": level,
                "date_of_birth": dob}, identifiers, contacts, addresses

    def create(self, actor: Actor, payload: PrescriberContractIn) -> dict[str, Any]:
        demographics, identifiers, contacts, addresses = self._prepare(payload)
        with self.pharmacy.sessions.begin() as s:
            self.pharmacy._authorized(s, actor, "entry")
            rx_provider = Prescriber(site_id=actor.site_id, **demographics)
            s.add(rx_provider)
            s.flush()
            for model, rows in ((ProviderIdentifier, identifiers),
                                (ProviderContact, contacts),
                                (ProviderAddress, addresses)):
                for row in rows:
                    s.add(model(site_id=actor.site_id, prescriber_id=rx_provider.id, **row))
            s.flush()
            # Keep transitional scalar fields available for older Python
            # readers. Structured child records remain authoritative; values
            # too long for the legacy scalar are never silently truncated.
            def scalar_compat(value: str | None, max_len: int) -> str | None:
                return value if value is not None and len(value) <= max_len else None
            rx_provider.npi = scalar_compat(next((x["number"] for x in identifiers
                if x["type"] == "NPI"), None), 20)
            rx_provider.dea = scalar_compat(next((x["number"] for x in identifiers
                if x["type"] == "DEA"), None), 30)
            rx_provider.phone = scalar_compat(next((x["value"] for x in contacts
                if x["kind"] == "PHONE" and x["is_primary"]), None), 50)
            rx_provider.fax = scalar_compat(next((x["value"] for x in contacts
                if x["kind"] == "FAX" and x["is_primary"]), None), 50)
            self.pharmacy._audit(s, actor, "PRESCRIBER_CREATED", rx_provider.id,
                {"practice_level": rx_provider.practice_level,
                 "identifier_count": len(identifiers),
                 "contact_count": len(contacts), "address_count": len(addresses)})
            new_id = rx_provider.id
        return {"id": new_id, "prescriber": self.get_one(actor, new_id)}

    def get_one(self, actor: Actor, prescriber_id: str) -> dict[str, Any]:
        with self.pharmacy.sessions() as s:
            self.pharmacy._authorized(s, actor, "read")
            prescriber = self.pharmacy._site(s, Prescriber, prescriber_id, actor)
            return self._serialize(s, prescriber, actor.site_id)

    @staticmethod
    def _serialize(s, prescriber: Prescriber, site_id: str) -> dict[str, Any]:
        ids = s.scalars(select(ProviderIdentifier).where(
            ProviderIdentifier.site_id == site_id,
            ProviderIdentifier.prescriber_id == prescriber.id,
            ProviderIdentifier.active.is_(True)).order_by(
                ProviderIdentifier.type, ProviderIdentifier.is_primary.desc(),
                ProviderIdentifier.created_at, ProviderIdentifier.id)).all()
        contacts = s.scalars(select(ProviderContact).where(
            ProviderContact.site_id == site_id,
            ProviderContact.prescriber_id == prescriber.id,
            ProviderContact.active.is_(True)).order_by(
                ProviderContact.kind, ProviderContact.is_primary.desc(),
                ProviderContact.created_at, ProviderContact.id)).all()
        addresses = s.scalars(select(ProviderAddress).where(
            ProviderAddress.site_id == site_id,
            ProviderAddress.prescriber_id == prescriber.id,
            ProviderAddress.active.is_(True)).order_by(
                ProviderAddress.is_primary.desc(),
                ProviderAddress.created_at, ProviderAddress.id)).all()
        return {
            "id": prescriber.id, "siteId": site_id,
            "firstName": prescriber.first_name, "lastName": prescriber.last_name,
            "practiceLevel": prescriber.practice_level,
            "dateOfBirth": prescriber.date_of_birth,
            "identifiers": [{
                "id": x.id, "type": x.type, "number": x.number,
                "numberSearch": x.normalized, "jurisdiction": x.jurisdiction,
                "isPrimary": x.is_primary} for x in ids],
            "contacts": [{
                "id": x.id, "type": x.kind, "value": x.value,
                "valueSearch": x.normalized, "label": x.label,
                "extension": x.extension, "isPrimary": x.is_primary} for x in contacts],
            "addresses": [{
                "id": x.id, "label": x.label, "addressLine1": x.line1,
                "addressLine2": x.line2, "city": x.city,
                "state": x.state, "postalCode": x.postal_code,
                "isPrimary": x.is_primary} for x in addresses],
        }

    def search(self, actor: Actor, *, query: str = "", first_name: str = "",
               last_name: str = "", date_of_birth: str | None = None,
               phone: str = "") -> list[dict[str, Any]]:
        dob = normalize_date(date_of_birth)
        generic = (query or "").strip().casefold()
        first = (first_name or "").strip().casefold()
        last = (last_name or "").strip().casefold()
        digits = normalize_phone(phone)
        ident = _normalized_identifier(generic)
        generic_digits = normalize_phone(generic)
        parts = [p.strip() for p in generic.split(",", 1)] if "," in generic else None
        for part in (generic, first, last):
            if len(part) > 120:
                raise WorkflowError("Provider search term is too long")
        with self.pharmacy.sessions() as s:
            self.pharmacy._authorized(s, actor, "read")
            # Site restriction in SQL. Additional original-style filtering
            # occurs before the 100-result limit, not on an arbitrary page.
            providers = s.scalars(select(Prescriber).where(
                Prescriber.site_id == actor.site_id).order_by(
                    Prescriber.last_name, Prescriber.first_name,
                    Prescriber.date_of_birth, Prescriber.id)).all()
            results = []
            for p in providers:
                if first and not p.first_name.casefold().startswith(first):
                    continue
                if last and not p.last_name.casefold().startswith(last):
                    continue
                if dob and p.date_of_birth != dob:
                    continue
                ids = s.scalars(select(ProviderIdentifier).where(
                    ProviderIdentifier.prescriber_id == p.id,
                    ProviderIdentifier.site_id == actor.site_id,
                    ProviderIdentifier.active.is_(True))).all()
                contacts = s.scalars(select(ProviderContact).where(
                    ProviderContact.prescriber_id == p.id,
                    ProviderContact.site_id == actor.site_id,
                    ProviderContact.active.is_(True))).all()
                if digits and not any(digits in x.normalized for x in contacts if x.kind == "PHONE"):
                    continue
                if generic:
                    if parts:
                        if not (p.last_name.casefold().startswith(parts[0]) and
                                (not parts[1] or p.first_name.casefold().startswith(parts[1]))):
                            continue
                    elif not (
                        p.first_name.casefold().startswith(generic)
                        or p.last_name.casefold().startswith(generic)
                        or p.practice_level.casefold().startswith(generic)
                        or any(ident and ident in x.normalized for x in ids)
                        or any(generic_digits and generic_digits in x.normalized for x in contacts)):
                        continue
                results.append(self._serialize(s, p, actor.site_id))
                if len(results) == 100:
                    break
            return results
