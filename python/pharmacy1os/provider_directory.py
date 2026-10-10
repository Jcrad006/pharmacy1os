"""Python-native multi-record prescriber directory (synthetic only).

Attached identifiers, contacts and addresses never replace original Rx history.
The enclosing PharmacyService session performs authorization and durable audit.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, UniqueConstraint, func, or_, select, text, update
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, Prescriber, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError


class ProviderIdentifier(Base):
    __tablename__ = "py_provider_identifiers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescriber_id: Mapped[str] = mapped_column(ForeignKey("py_prescribers.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    number: Mapped[str] = mapped_column(String(80), nullable=False)
    normalized: Mapped[str] = mapped_column(String(80), nullable=False)
    jurisdiction: Mapped[str] = mapped_column(String(10), nullable=False, default="")
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("prescriber_id", "type", "normalized", "jurisdiction"),
        Index("ux_py_provider_identifier_primary", "prescriber_id", "type", "jurisdiction", unique=True,
              sqlite_where=text("is_primary = 1 AND active = 1"),
              postgresql_where=text("is_primary = true AND active = true")),
    )


class ProviderContact(Base):
    __tablename__ = "py_provider_contacts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescriber_id: Mapped[str] = mapped_column(ForeignKey("py_prescribers.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(15), nullable=False)
    label: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    value: Mapped[str] = mapped_column(String(80), nullable=False)
    normalized: Mapped[str] = mapped_column(String(80), nullable=False)
    extension: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("prescriber_id", "kind", "normalized", "extension"),
        Index("ux_py_provider_contact_primary", "prescriber_id", "kind", unique=True,
              sqlite_where=text("is_primary = 1 AND active = 1"),
              postgresql_where=text("is_primary = true AND active = true")),
    )


class ProviderAddress(Base):
    __tablename__ = "py_provider_addresses"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescriber_id: Mapped[str] = mapped_column(ForeignKey("py_prescribers.id"), nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    line1: Mapped[str] = mapped_column(String(150), nullable=False)
    line2: Mapped[str] = mapped_column(String(150), nullable=False, default="")
    city: Mapped[str] = mapped_column(String(100), nullable=False)
    state: Mapped[str] = mapped_column(String(30), nullable=False)
    postal_code: Mapped[str] = mapped_column(String(30), nullable=False)
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        Index("ux_py_provider_address_primary", "prescriber_id", unique=True,
              sqlite_where=text("is_primary = 1 AND active = 1"),
              postgresql_where=text("is_primary = true AND active = true")),
    )


def _required(value: str, title: str, max_length: int = 150) -> str:
    stripped = (value or "").strip()
    if not stripped or len(stripped) > max_length:
        raise WorkflowError(f"{title} is required and cannot exceed {max_length} characters")
    return stripped


def _normalized_identifier(value: str) -> str:
    return "".join(c for c in value.upper() if c.isalnum())


def _normalized_phone(value: str) -> str:
    return "".join(c for c in value if c.isdigit())


class ProviderDirectory:
    """Site-isolated user-facing prescriber directory operations with append-only audit."""

    def __init__(self, pharmacy: PharmacyService):
        self.pharmacy = pharmacy

    def add_identifier(self, actor: Actor, prescriber_id: str, type: str, number: str,
                       jurisdiction: str = "", is_primary: bool = False) -> str:
        kind = _required(type, "Identifier type", 20).upper()
        if kind not in {"NPI", "DEA", "STATE_ID", "OTHER"}:
            raise WorkflowError("Unsupported identifier type")
        raw = _required(number, "Identifier number", 80)
        normalized = _normalized_identifier(raw)
        if not normalized:
            raise WorkflowError("Identifier must contain letters or numbers")
        place = (jurisdiction or "").strip().upper()
        if len(place) > 10:
            raise WorkflowError("Jurisdiction too long")
        with self.pharmacy.sessions.begin() as s:
            self.pharmacy._authorized(s, actor, "correct")
            provider = self.pharmacy._site(s, Prescriber, prescriber_id, actor)
            # A persisted active NPI is authoritative. Check it first so
            # repeated enrollment is reported as an existing-child conflict,
            # regardless of any legacy scalar NPI still on the parent.
            if kind == "NPI":
                existing = s.scalar(select(ProviderIdentifier.id).where(
                    ProviderIdentifier.site_id == actor.site_id,
                    ProviderIdentifier.prescriber_id == prescriber_id,
                    ProviderIdentifier.type == "NPI",
                    ProviderIdentifier.active.is_(True)))
                if existing:
                    raise WorkflowError("A prescriber may have only one active NPI")
                if (provider.npi and
                        _normalized_identifier(provider.npi) != normalized):
                    raise WorkflowError("NPI conflicts with the existing provider identity")
            if is_primary:
                s.execute(update(ProviderIdentifier).where(
                    ProviderIdentifier.prescriber_id == prescriber_id,
                    ProviderIdentifier.type == kind,
                    ProviderIdentifier.jurisdiction == place,
                    ProviderIdentifier.active.is_(True),
                ).values(is_primary=False))
            identifier = ProviderIdentifier(site_id=actor.site_id, prescriber_id=prescriber_id,
                                            type=kind, number=raw, normalized=normalized,
                                            jurisdiction=place, is_primary=is_primary)
            s.add(identifier); s.flush()
            self.pharmacy._audit(s, actor, "PROVIDER_IDENTIFIER_ADDED", identifier.id,
                                 {"prescriber_id": prescriber_id, "type": kind, "jurisdiction": place,
                                  "primary": is_primary, "number": "[REDACTED]"})
            return identifier.id

    def retire_identifier(self, actor: Actor, identifier_id: str, reason: str) -> None:
        note = _required(reason, "Reason", 1000)
        with self.pharmacy.sessions.begin() as s:
            self.pharmacy._authorized(s, actor, "correct")
            identifier = self.pharmacy._site(s, ProviderIdentifier, identifier_id, actor)
            if not identifier.active:
                raise WorkflowError("Identifier is already retired")
            identifier.active = False
            identifier.is_primary = False
            self.pharmacy._audit(s, actor, "PROVIDER_IDENTIFIER_RETIRED", identifier.id,
                                 {"prescriber_id": identifier.prescriber_id, "reason": note})

    def add_contact(self, actor: Actor, prescriber_id: str, kind: str, value: str,
                    label: str = "", extension: str = "", is_primary: bool = False) -> str:
        contact_kind = _required(kind, "Contact kind", 15).upper()
        if contact_kind not in {"PHONE", "FAX"}:
            raise WorkflowError("Only phone and fax contacts are supported")
        raw = _required(value, "Contact value", 80)
        number = _normalized_phone(raw)
        if not 7 <= len(number) <= 15:
            raise WorkflowError("Phone/fax number must contain 7-15 digits")
        extension = (extension or "").strip()
        if len(extension) > 20:
            raise WorkflowError("Extension too long")
        with self.pharmacy.sessions.begin() as s:
            self.pharmacy._authorized(s, actor, "entry")
            self.pharmacy._site(s, Prescriber, prescriber_id, actor)
            if is_primary:
                s.execute(update(ProviderContact).where(
                    ProviderContact.prescriber_id == prescriber_id,
                    ProviderContact.kind == contact_kind,
                    ProviderContact.active.is_(True),
                ).values(is_primary=False))
            contact = ProviderContact(site_id=actor.site_id, prescriber_id=prescriber_id,
                                      kind=contact_kind, value=raw, normalized=number,
                                      extension=extension, label=(label or "").strip()[:80],
                                      is_primary=is_primary)
            s.add(contact); s.flush()
            self.pharmacy._audit(s, actor, "PROVIDER_CONTACT_ADDED", contact.id,
                                 {"prescriber_id": prescriber_id, "kind": contact_kind, "primary": is_primary})
            return contact.id

    def add_address(self, actor: Actor, prescriber_id: str, line1: str, city: str,
                    state: str, postal_code: str, line2: str = "", label: str = "",
                    is_primary: bool = False) -> str:
        line = _required(line1, "Address line 1")
        city = _required(city, "City", 100)
        state = _required(state, "State", 30).upper()
        postal_code = _required(postal_code, "Postal code", 30)
        with self.pharmacy.sessions.begin() as s:
            self.pharmacy._authorized(s, actor, "entry")
            self.pharmacy._site(s, Prescriber, prescriber_id, actor)
            if is_primary:
                s.execute(update(ProviderAddress).where(
                    ProviderAddress.prescriber_id == prescriber_id,
                    ProviderAddress.active.is_(True),
                ).values(is_primary=False))
            address = ProviderAddress(site_id=actor.site_id, prescriber_id=prescriber_id,
                                      line1=line, line2=(line2 or "").strip()[:150], city=city,
                                      state=state, postal_code=postal_code,
                                      label=(label or "").strip()[:80], is_primary=is_primary)
            s.add(address); s.flush()
            self.pharmacy._audit(s, actor, "PROVIDER_ADDRESS_ADDED", address.id,
                                 {"prescriber_id": prescriber_id, "primary": is_primary})
            return address.id

    def details(self, actor: Actor, prescriber_id: str) -> dict[str, Any]:
        with self.pharmacy.sessions() as s:
            self.pharmacy._authorized(s, actor, "entry")
            prescriber = self.pharmacy._site(s, Prescriber, prescriber_id, actor)
            ids = s.scalars(select(ProviderIdentifier).where(
                ProviderIdentifier.prescriber_id == prescriber_id,
                ProviderIdentifier.site_id == actor.site_id,
            ).order_by(ProviderIdentifier.type, ProviderIdentifier.created_at)).all()
            contacts = s.scalars(select(ProviderContact).where(
                ProviderContact.prescriber_id == prescriber_id,
                ProviderContact.site_id == actor.site_id,
            ).order_by(ProviderContact.kind, ProviderContact.created_at)).all()
            addresses = s.scalars(select(ProviderAddress).where(
                ProviderAddress.prescriber_id == prescriber_id,
                ProviderAddress.site_id == actor.site_id,
            ).order_by(ProviderAddress.created_at)).all()
            return {
                "id": prescriber.id, "first_name": prescriber.first_name,
                "last_name": prescriber.last_name, "practice_level": prescriber.practice_level,
                "identifiers": [{"id": x.id, "type": x.type, "number": x.number,
                                 "jurisdiction": x.jurisdiction, "active": x.active,
                                 "primary": x.is_primary} for x in ids],
                "contacts": [{"id": x.id, "kind": x.kind, "value": x.value,
                              "label": x.label, "extension": x.extension, "primary": x.is_primary} for x in contacts if x.active],
                "addresses": [{"id": x.id, "line1": x.line1, "line2": x.line2,
                               "city": x.city, "state": x.state, "postal_code": x.postal_code,
                               "primary": x.is_primary} for x in addresses if x.active],
            }

    def search(self, actor: Actor, query: str, limit: int = 50) -> list[dict[str, str]]:
        term = (query or "").strip()
        if len(term) > 120 or not 1 <= limit <= 100:
            raise WorkflowError("Invalid search term or limit")
        with self.pharmacy.sessions() as s:
            self.pharmacy._authorized(s, actor, "read")
            statement = select(Prescriber).where(Prescriber.site_id == actor.site_id)
            if term:
                normalized = _normalized_identifier(term)
                digits = _normalized_phone(term)
                phone_matches = select(ProviderContact.prescriber_id).where(
                    ProviderContact.site_id == actor.site_id,
                    ProviderContact.active.is_(True),
                    ProviderContact.normalized.like(f"%{digits}%"),
                ) if digits else select(ProviderContact.prescriber_id).where(text("1=0"))
                identifier_matches = select(ProviderIdentifier.prescriber_id).where(
                    ProviderIdentifier.site_id == actor.site_id,
                    ProviderIdentifier.active.is_(True),
                    ProviderIdentifier.normalized.like(f"%{normalized}%"),
                ) if normalized else select(ProviderIdentifier.prescriber_id).where(text("1=0"))
                statement = statement.where(or_(
                    func.lower(Prescriber.first_name).contains(term.lower()),
                    func.lower(Prescriber.last_name).contains(term.lower()),
                    Prescriber.id.in_(phone_matches),
                    Prescriber.id.in_(identifier_matches),
                ))
            rows = s.scalars(statement.order_by(Prescriber.last_name, Prescriber.first_name).limit(limit)).all()
            return [{"id": row.id, "name": f"{row.last_name}, {row.first_name}",
                     "practice_level": row.practice_level} for row in rows]
