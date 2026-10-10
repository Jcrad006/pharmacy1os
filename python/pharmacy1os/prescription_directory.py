"""Read-only original-inspired Rx queue and detail projection.

Preserves the original's site-scoped /prescriptions/queue and /prescriptions/:id
concepts without claiming equivalent timestamps, regulated clinical history,
patient identity validation or an actual production dispensing workstation.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (Audit, Claim, Drug, Fill, FillSource, Label, Patient,
                     Prescriber, Prescription, Product, Staff, Stock, WillCall)
from .service import Actor, PharmacyService, TRANSITIONS, WorkflowError
from .prescription_edit import PrescriptionEdit
from .structured_changes import StructuredChangeApplication


VALID_STATUSES = frozenset(TRANSITIONS) | {"ON_HOLD"}


def _timestamp(value: datetime | None) -> datetime:
    if value is None:
        return datetime.fromtimestamp(0, timezone.utc)
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _utc_string(value: datetime | None) -> str | None:
    return _timestamp(value).isoformat() if value is not None else None


def _allowable(rx: Prescription) -> list[str]:
    # Preserve the current Python lifecycle rule set. This is a display
    # advisory; authoritative transition checks are inside service methods.
    if rx.status == "ON_HOLD":
        return [rx.held_from] if rx.held_from in VALID_STATUSES else []
    return sorted(TRANSITIONS.get(rx.status, set()))


class PrescriptionDirectory:
    def __init__(self, service: PharmacyService):
        self.service = service

    def _related(self, s: Session, actor: Actor, rx: Prescription):
        patient = self.service._site(s, Patient, rx.patient_id, actor)
        provider = self.service._site(s, Prescriber, rx.prescriber_id, actor)
        drug = s.get(Drug, rx.drug_id)
        if drug is None:
            raise WorkflowError("Selected drug catalog entry is missing")
        return patient, provider, drug

    @staticmethod
    def _event_subjects(s: Session, rx: Prescription, fill_ids: list[str]) -> list[str]:
        # Edits have their own audit subject IDs; ignoring them hides reviewed
        # changes and leaves an edited prescription at its old queue position.
        ids = [rx.id, *fill_ids]
        for model in (PrescriptionEdit, StructuredChangeApplication):
            ids.extend(s.scalars(select(model.id).where(
                model.site_id == rx.site_id, model.prescription_id == rx.id)).all())
        return ids

    @staticmethod
    def _modified(s: Session, rx: Prescription, fills: list[Fill]) -> datetime | None:
        # Python Rx has no updated_at yet. Use latest matching recorded event,
        # not a fabricated exact modification timestamp.
        ids = PrescriptionDirectory._event_subjects(s, rx, [fill.id for fill in fills])
        events = s.scalars(select(Audit).where(
            Audit.site_id == rx.site_id, Audit.subject_id.in_(ids))).all()
        return max((event.created_at for event in events),
                   key=_timestamp, default=None)

    @staticmethod
    def _summary(rx: Prescription, patient: Patient, provider: Prescriber,
                 drug: Drug, modified: datetime | None) -> dict[str, Any]:
        return {
            "id": rx.id, "siteId": rx.site_id,
            "rxNumber": rx.rx_number, "status": rx.status,
            "patientId": rx.patient_id, "prescriberId": rx.prescriber_id,
            "medicationId": rx.drug_id, "medicationName": drug.name,
            "strength": drug.strength, "dosageForm": drug.dosage_form,
            "patient": {"id": patient.id, "firstName": patient.first_name,
                        "lastName": patient.last_name},
            "prescriber": {"id": provider.id, "firstName": provider.first_name,
                           "lastName": provider.last_name,
                           "practiceLevel": provider.practice_level},
            "allowedTransitions": _allowable(rx),
            "updatedAt": _utc_string(modified),
            "updatedAtSource": "LATEST_RELATED_AUDIT_EVENT" if modified else "UNKNOWN",
        }

    def _project(self, s: Session, actor: Actor, rx: Prescription,
                 include_fills: bool = False) -> dict[str, Any]:
        patient, provider, drug = self._related(s, actor, rx)
        fills = s.scalars(select(Fill).where(Fill.prescription_id == rx.id)
                          .order_by(Fill.fill_number.desc(), Fill.attempt.desc(), Fill.id)).all()
        result = self._summary(rx, patient, provider, drug,
                               self._modified(s, rx, fills))
        if not include_fills:
            return result
        result.update({
            "sig": rx.sig, "quantityWritten": str(rx.quantity),
            "refillsAllowed": rx.refills_allowed, "refillsUsed": rx.refills_used,
            "sourceType": rx.source_type,
            "writtenDate": rx.written_date, "expirationDate": rx.expiration_date,
            "doNotFillBefore": rx.do_not_fill_before,
            "productSelectionDirective": rx.product_selection_directive,
            "prescribedProductId": rx.prescribed_product_id,
            "electronicMessageId": rx.electronic_message_id,
            # raw eRx payload is intentionally omitted from this projection
            "version": rx.version, "heldFromStatus": rx.held_from,
            "fills": [],
        })
        for fill in fills:
            sources = []
            for source in s.scalars(select(FillSource).where(
                    FillSource.fill_id == fill.id).order_by(FillSource.id)).all():
                stock = s.get(Stock, source.stock_id)
                if stock is None or stock.site_id != actor.site_id:
                    raise WorkflowError("Fill source stock site/provenance mismatch")
                product = s.get(Product, stock.product_id)
                if product is None or product.drug_id != rx.drug_id:
                    raise WorkflowError("Fill source product does not match selected medication")
                sources.append({
                    "id": source.id, "stockId": stock.id,
                    "productId": product.id, "ndc": product.ndc,
                    "manufacturer": product.manufacturer,
                    "lotNumber": stock.lot, "expirationDate": stock.expires,
                    "sourceQuantity": str(source.quantity),
                })
            claims = s.scalars(select(Claim).where(
                Claim.fill_id == fill.id).order_by(Claim.sequence, Claim.id)).all()
            labels = s.scalars(select(Label).where(
                Label.fill_id == fill.id).order_by(Label.bottle_number, Label.id)).all()
            bag = s.scalar(select(WillCall).where(WillCall.fill_id == fill.id))
            result["fills"].append({
                "id": fill.id, "fillNumber": fill.fill_number,
                "attempt": fill.attempt, "status": fill.status,
                "quantity": str(fill.quantity),
                "billedQuantity": str(fill.billed_quantity),
                "patientDiscardDate": fill.patient_discard_date,
                "dispensedInOriginalContainer": fill.dispensed_in_original_container,
                "sources": sources,
                "claims": [{"id": c.id, "payer": c.payer,
                            "sequence": c.sequence, "status": c.status,
                            "billedQuantity": str(c.billed_quantity)} for c in claims],
                "labels": [{"id": l.id, "bottleNumber": l.bottle_number,
                            "bottleCount": l.bottle_count,
                            "ndc": l.ndc, "quantity": str(l.quantity),
                            "total": str(l.total)} for l in labels],
                "willCall": ({"bagBarcode": bag.bag_barcode, "binName": bag.bin_name,
                              "status": bag.status} if bag else None),
            })
        return result

    def queue(self, actor: Actor, *, status: str | None = None,
              query: str = "", sort: str = "oldest", limit: int = 100) -> dict[str, Any]:
        if status is not None and status not in VALID_STATUSES:
            raise WorkflowError("Invalid prescription status")
        if sort not in {"oldest", "newest"}:
            raise WorkflowError("Prescription sort must be oldest or newest")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
            raise WorkflowError("Prescription queue limit must be 1 to 200")
        if not isinstance(query, str) or len(query) > 200:
            raise WorkflowError("Invalid prescription search query")
        cleaned = query.strip().casefold()
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            statement = select(Prescription).where(Prescription.site_id == actor.site_id)
            if status is not None:
                statement = statement.where(Prescription.status == status)
            rows = s.scalars(statement).all()
            selected = []
            for rx in rows:
                patient, provider, drug = self._related(s, actor, rx)
                haystack = (rx.rx_number, drug.name, patient.first_name,
                            patient.last_name, provider.first_name, provider.last_name)
                if cleaned and not any(cleaned in str(v).casefold() for v in haystack):
                    continue
                fills = s.scalars(select(Fill).where(Fill.prescription_id == rx.id)).all()
                updated = self._modified(s, rx, fills)
                selected.append((rx, patient, provider, drug, updated))
            selected.sort(key=lambda row: (_timestamp(row[4]), row[0].id),
                          reverse=(sort == "newest"))
            projected = [self._summary(*row) for row in selected[:limit]]
            return {"prescriptions": projected, "meta": {
                "query": query.strip(), "status": status, "sort": sort,
                "returned": len(projected), "limit": limit,
                "timeOrdering": "LATEST_RELATED_AUDIT_EVENT_NOT_RX_UPDATED_AT",
            }}

    def detail(self, actor: Actor, prescription_id: str) -> dict[str, Any]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rx = self.service._site(s, Prescription, prescription_id, actor)
            # Keep the existing Python contract and the newer nested projection
            # on one handler. Explicit fields prevent future private model
            # columns (especially the raw eRx message) leaking into either DTO.
            return {
                "id": rx.id, "site_id": rx.site_id, "rx_number": rx.rx_number,
                "patient_id": rx.patient_id, "prescriber_id": rx.prescriber_id,
                "drug_id": rx.drug_id, "sig": rx.sig, "quantity": str(rx.quantity),
                "refills_allowed": rx.refills_allowed, "refills_used": rx.refills_used,
                "status": rx.status, "version": rx.version,
                "expiration_date": rx.expiration_date,
                "do_not_fill_before": rx.do_not_fill_before,
                "written_date": rx.written_date, "source_type": rx.source_type,
                "electronic_message_id": rx.electronic_message_id,
                "electronic_source_recorded": rx.electronic_raw_message is not None,
                "prescribed_product_id": rx.prescribed_product_id,
                "product_selection_directive": rx.product_selection_directive,
                "prescription": self._project(s, actor, rx, include_fills=True),
                "warning": "SYNTHETIC_DEVELOPMENT_ONLY_NO_ELECTRONIC_MESSAGE_VALIDATION",
            }

    def audit(self, actor: Actor, prescription_id: str, limit: int = 200) -> dict[str, Any]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
            raise WorkflowError("Prescription audit limit must be 1 to 200")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rx = self.service._site(s, Prescription, prescription_id, actor)
            fill_ids = s.scalars(select(Fill.id).where(Fill.prescription_id == rx.id)).all()
            subject_ids = self._event_subjects(s, rx, list(fill_ids))
            events = s.scalars(select(Audit).where(
                Audit.site_id == actor.site_id,
                Audit.subject_id.in_(subject_ids))
                .order_by(Audit.created_at.desc(), Audit.id.desc()).limit(limit)).all()
            returned = []
            for event in events:
                author = s.get(Staff, event.actor_id)
                if author is None or author.site_id != actor.site_id:
                    raise WorkflowError("Prescription audit actor site mismatch")
                returned.append({
                    "id": event.id, "action": event.kind,
                    "entityId": event.subject_id, "actorId": author.id,
                    "actor": {"displayName": author.name, "role": author.role},
                    "occurredAt": _utc_string(event.created_at),
                    # Do not expand the free-text audit metadata into Rx/PHI
                    # snapshots; original audit JSON is retained at rest.
                })
            return {"events": returned,
                    "meta": {"limit": limit, "returned": len(returned),
                             "detailRedacted": True}}
