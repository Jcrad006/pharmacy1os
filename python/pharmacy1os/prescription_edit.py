"""Versioned pharmacist-controlled edits to an unfilled synthetic prescription.

Does not modify immutable source documents/eRx payloads. Existing physical
fill history is never retrospectively reinterpreted. No legal consent is
inferred from a user-typed clinical attestation.
"""
from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, Drug, Fill, Prescriber, Prescription, Product, utcnow, uuid
from .service import Actor, PharmacyService, WorkflowError, positive

EDITABLE = {
    "sig", "quantity", "refills_allowed", "prescriber_id", "drug_id",
    "prescribed_product_id", "product_selection_directive", "written_date",
    "expiration_date", "do_not_fill_before",
}
SELECTION = {"UNSPECIFIED", "SELECTION_PERMITTED", "DISPENSE_AS_WRITTEN"}
DATE_FIELDS = {"written_date", "expiration_date", "do_not_fill_before"}


class PrescriptionEdit(Base):
    __tablename__ = "py_prescription_edits"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    prescription_id: Mapped[str] = mapped_column(
        ForeignKey("py_prescriptions.id"), nullable=False, index=True)
    version_before: Mapped[int] = mapped_column(Integer, nullable=False)
    version_after: Mapped[int] = mapped_column(Integer, nullable=False)
    prior_status: Mapped[str] = mapped_column(String(30), nullable=False)
    resulting_status: Mapped[str] = mapped_column(String(30), nullable=False)
    changes_json: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    attestation_note: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[Any] = mapped_column(DateTime(timezone=True),
                                              nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("prescription_id", "version_after", name="uq_py_rx_edit_version"),
        CheckConstraint("version_after = version_before + 1", name="ck_py_rx_edit_increment"),
    )


def _iso_date(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) != 10:
        raise WorkflowError(f"{field} must be YYYY-MM-DD or null")
    try:
        result = date.fromisoformat(value)
    except ValueError as exc:
        raise WorkflowError(f"Invalid {field}") from exc
    if result.isoformat() != value:
        raise WorkflowError(f"{field} must be YYYY-MM-DD")
    return value


def _value(value: Any) -> Any:
    return str(value) if isinstance(value, Decimal) else value


class PrescriptionEditService:
    def __init__(self, service: PharmacyService):
        self.service = service

    def update(self, actor: Actor, prescription_id: str, changes: dict[str, Any],
               expected_version: int, attestation_note: str) -> dict[str, Any]:
        if (isinstance(expected_version, bool) or not isinstance(expected_version, int)
                or expected_version < 0):
            raise WorkflowError("Expected version must be a nonnegative integer")
        note = attestation_note.strip() if isinstance(attestation_note, str) else ""
        if not 12 <= len(note) <= 2000:
            raise WorkflowError("Pharmacist review attestation must contain 12–2000 characters")
        if (not isinstance(changes, dict) or not changes or
                len(changes) > len(EDITABLE) or
                any(field not in EDITABLE for field in changes)):
            raise WorkflowError("Unsupported prescription edits or immutable source fields")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "clinical")
            rx = s.scalar(select(Prescription).where(
                Prescription.id == prescription_id,
                Prescription.site_id == actor.site_id).with_for_update())
            if rx is None:
                raise WorkflowError("Prescription not found at pharmacy site")
            if rx.version != expected_version:
                raise WorkflowError("Prescription version changed; reload before editing")
            if rx.status not in {"DATA_ENTRY", "DUR_REVIEW", "ON_HOLD"}:
                raise WorkflowError("Only an unfilled Data Entry/DUR prescription can be edited")
            if rx.status == "ON_HOLD" and rx.held_from not in {"DATA_ENTRY", "DUR_REVIEW"}:
                raise WorkflowError("Held prescription cannot be edited from active fill state")
            if s.scalar(select(Fill.id).where(Fill.prescription_id == rx.id)):
                raise WorkflowError("Cannot modify prescription after any physical fill history")
            from .scheduling_models import ScheduledFill
            if s.scalar(select(ScheduledFill.id).where(
                    ScheduledFill.prescription_id == rx.id, ScheduledFill.status == "PENDING")):
                raise WorkflowError("Cancel pending future fills before editing")
            from .prescription_transfer import require_no_pending_transfer
            require_no_pending_transfer(s, rx)
            result = {key: getattr(rx, key) for key in EDITABLE}
            for name, raw in changes.items():
                if name == "sig":
                    if not isinstance(raw, str) or not 1 <= len(raw.strip()) <= 4000:
                        raise WorkflowError("SIG must be 1–4000 characters")
                    value = raw.strip()
                elif name == "quantity":
                    value = positive(raw)
                elif name == "refills_allowed":
                    if (isinstance(raw, bool) or not isinstance(raw, int)
                            or not 0 <= raw <= 999 or raw < rx.refills_used):
                        raise WorkflowError("Refills must be an available nonnegative whole number")
                    value = raw
                elif name == "prescriber_id":
                    record = s.get(Prescriber, raw) if isinstance(raw, str) else None
                    if record is None or record.site_id != actor.site_id:
                        raise WorkflowError("Prescriber not found at pharmacy site")
                    value = record.id
                elif name == "drug_id":
                    drug = s.get(Drug, raw) if isinstance(raw, str) else None
                    if drug is None or not drug.active or drug.controlled or drug.controlled_substance_schedule != "NONE":
                        raise WorkflowError("Active noncontrolled catalog drug required")
                    value = drug.id
                elif name == "prescribed_product_id":
                    if raw is not None and not isinstance(raw, str):
                        raise WorkflowError("Prescribed product ID must be a string or null")
                    value = raw
                elif name == "product_selection_directive":
                    if raw not in SELECTION:
                        raise WorkflowError("Unsupported product-selection directive")
                    value = raw
                elif name in DATE_FIELDS:
                    value = _iso_date(raw, name)
                else:
                    raise WorkflowError("Unsupported prescription edit")
                result[name] = value
            if (result["written_date"] and result["written_date"] > date.today().isoformat()):
                raise WorkflowError("Written date cannot be in the future")
            if (result["written_date"] and result["expiration_date"]
                    and result["expiration_date"] < result["written_date"]):
                raise WorkflowError("Prescription expiration predates written date")
            if result["prescribed_product_id"] is not None:
                product = s.get(Product, result["prescribed_product_id"])
                if (product is None or not product.active
                        or product.drug_id != result["drug_id"]):
                    raise WorkflowError("Prescribed NDC must be an active product under the selected drug")
            if (result["product_selection_directive"] == "DISPENSE_AS_WRITTEN"
                    and not result["prescribed_product_id"]):
                raise WorkflowError("Dispense-as-written requires an exact product/NDC")
            before_after = {}
            for field in sorted(changes):
                old, new = getattr(rx, field), result[field]
                if old != new:
                    before_after[field] = {"before": _value(old), "after": _value(new)}
            if not before_after:
                raise WorkflowError("Prescription edits contain no changed values")
            old_status = rx.status
            for field in before_after:
                setattr(rx, field, result[field])
            rx.version += 1
            if rx.status == "DUR_REVIEW":
                rx.status = "DATA_ENTRY"
            elif rx.status == "ON_HOLD" and rx.held_from == "DUR_REVIEW":
                rx.held_from = "DATA_ENTRY"
            event = PrescriptionEdit(site_id=actor.site_id, prescription_id=rx.id,
                version_before=expected_version, version_after=rx.version,
                prior_status=old_status, resulting_status=rx.status,
                changes_json=json.dumps(before_after, sort_keys=True),
                actor_id=actor.id, attestation_note=note)
            s.add(event); s.flush()
            self.service._audit(s, actor, "RX_EDIT_REVIEWED", event.id, {
                "rx_id": rx.id, "version_before": expected_version,
                "version_after": rx.version, "changes": before_after,
                "original_source_mutated": False, "prior_status": old_status,
                "resulting_status": rx.status,
            })
            return {"id": event.id, "prescription_id": rx.id, "version": rx.version,
                    "status": rx.status, "changed": before_after}

    def history(self, actor: Actor, prescription_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            self.service._site(s, Prescription, prescription_id, actor)
            records = s.scalars(select(PrescriptionEdit).where(
                PrescriptionEdit.site_id == actor.site_id,
                PrescriptionEdit.prescription_id == prescription_id
            ).order_by(PrescriptionEdit.version_after)).all()
            return [{
                "id": e.id, "version_before": e.version_before,
                "version_after": e.version_after, "actor_id": e.actor_id,
                "changes": json.loads(e.changes_json),
                "prior_status": e.prior_status,
                "resulting_status": e.resulting_status,
                "attestation_note": e.attestation_note,
                "occurred_at": e.occurred_at.isoformat(),
            } for e in records]
