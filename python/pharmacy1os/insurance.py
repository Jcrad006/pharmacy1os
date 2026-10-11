"""Synthetic payer master and patient insurance coverage.

No eligibility verification, claim switch, sequential COB adjudication, or legal
billing semantics. Covered payer selections only produce simulated claims.
"""
from __future__ import annotations
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .insurance_models import InsurancePayer, PatientCoverage, ClaimCoverageSnapshot
from .models import Claim, Fill, Patient, Prescription
from .service import Actor, PharmacyService, WorkflowError

STRATEGIES = {
    "MAJORITY_SOURCE", "REQUIRE_MANUAL_SELECTION",
    "SINGLE_SOURCE_ONLY", "PAYER_CONFIGURED",
}
RELATIONSHIPS = {"SELF", "SPOUSE", "CHILD", "OTHER"}


def _text(value: Any, label: str, maximum: int, *, optional: bool = False) -> str | None:
    if optional and value is None:
        return None
    cleaned = value.strip() if isinstance(value, str) else ""
    if not cleaned and optional:
        return None
    if not cleaned or len(cleaned) > maximum:
        raise WorkflowError(f"{label} must contain 1–{maximum} characters")
    return cleaned


def _day(value: Any, name: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) != 10:
        raise WorkflowError(f"{name} must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise WorkflowError(f"Invalid {name}") from exc
    if parsed.isoformat() != value:
        raise WorkflowError(f"{name} must be YYYY-MM-DD")
    return value


def _mask(value: str) -> str:
    # Short synthetic identifiers must never be returned in full.
    if len(value) <= 4:
        return "*" * len(value)
    return "*" * (len(value) - 4) + value[-4:]


def _payer_view(row: InsurancePayer) -> dict[str, Any]:
    return {
        "id": row.id, "name": row.name, "bin": row.bin, "pcn": row.pcn,
        "default_group_id": row.default_group_id, "claim_standard": row.claim_standard,
        "billing_ndc_strategy": row.billing_ndc_strategy, "active": row.active,
    }


def _coverage_view(row: PatientCoverage, payer: InsurancePayer) -> dict[str, Any]:
    return {
        "id": row.id, "patient_id": row.patient_id, "payer_id": row.payer_id,
        "payer_name": payer.name, "payer_active": payer.active,
        "position": row.position, "member_id_masked": _mask(row.member_id),
        "person_code": row.person_code, "group_id": row.group_id,
        "relationship": row.relationship, "cardholder_name": row.cardholder_name,
        "cardholder_date_of_birth": row.cardholder_date_of_birth,
        "effective_date": row.effective_date, "termination_date": row.termination_date,
        "active": row.active,
    }


def _active_claim_blocks_change(s: Session, site_id: str, patient_id: str) -> bool:
    """Coverage cannot change while a paid synthetic claim remains unreversed."""
    return s.scalar(select(Claim.id).join(Fill, Claim.fill_id == Fill.id)
        .join(Prescription, Fill.prescription_id == Prescription.id)
        .where(Prescription.site_id == site_id, Prescription.patient_id == patient_id,
               Claim.status == "PAID_SYNTHETIC").limit(1)) is not None


def require_coverages(s: Session, actor: Actor, rx: Prescription,
                      coverage_ids: list[str], *, on: date | None = None
                      ) -> list[tuple[PatientCoverage, InsurancePayer]]:
    """Validate exact 1–4 ordered coverage positions and all site/date constraints."""
    if not isinstance(coverage_ids, list) or not 1 <= len(coverage_ids) <= 4:
        raise WorkflowError("One to four linked patient coverages are required")
    if len(set(coverage_ids)) != len(coverage_ids):
        raise WorkflowError("Duplicate insurance coverage in coordination-of-benefits list")
    at = (on or date.today()).isoformat()
    resolved: list[tuple[PatientCoverage, InsurancePayer]] = []
    for position, coverage_id in enumerate(coverage_ids, 1):
        if not isinstance(coverage_id, str):
            raise WorkflowError("Coverage identifiers must be strings")
        coverage = s.scalar(select(PatientCoverage).where(
            PatientCoverage.id == coverage_id,
            PatientCoverage.site_id == actor.site_id,
            PatientCoverage.patient_id == rx.patient_id).with_for_update())
        if coverage is None:
            raise WorkflowError("Coverage does not belong to this patient and pharmacy site")
        if coverage.position != position:
            raise WorkflowError("COB coverage order must match positions 1 through N")
        if not coverage.active:
            raise WorkflowError("Inactive patient coverage cannot be billed")
        if coverage.effective_date and at < coverage.effective_date:
            raise WorkflowError("Patient coverage is not yet effective")
        if coverage.termination_date and at > coverage.termination_date:
            raise WorkflowError("Patient coverage has terminated")
        payer = s.scalar(select(InsurancePayer).where(
            InsurancePayer.id == coverage.payer_id,
            InsurancePayer.site_id == actor.site_id))
        if payer is None or not payer.active:
            raise WorkflowError("Inactive or missing payer cannot be used for COB")
        if payer.billing_ndc_strategy != "MAJORITY_SOURCE":
            raise WorkflowError("Payer billing strategy lacks an implemented sandbox adapter")
        resolved.append((coverage, payer))
    if len({p.id for _, p in resolved}) != len(resolved):
        raise WorkflowError("Repeated payer across COB positions requires separately validated rules")
    return resolved


def snapshot_paid_coverage(s: Session, actor: Actor, fill: Fill, claim: Claim,
                           selected: tuple[PatientCoverage, InsurancePayer]) -> None:
    coverage, payer = selected
    s.add(ClaimCoverageSnapshot(
        site_id=actor.site_id, claim_id=claim.id, fill_id=fill.id,
        coverage_id=coverage.id, payer_id=payer.id,
        coverage_position=coverage.position, payer_name_snapshot=payer.name,
        member_id_snapshot=coverage.member_id, group_id_snapshot=coverage.group_id,
        person_code_snapshot=coverage.person_code,
        claim_standard_snapshot=payer.claim_standard,
        billing_strategy_snapshot=payer.billing_ndc_strategy,
        intended_quantity_snapshot=str(fill.billed_quantity),
        physical_quantity_snapshot=str(fill.quantity),
    ))


class InsuranceDirectory:
    def __init__(self, service: PharmacyService):
        self.service = service

    def list_payers(self, actor: Actor) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            rows = s.scalars(select(InsurancePayer).where(
                InsurancePayer.site_id == actor.site_id)
                .order_by(InsurancePayer.active.desc(), InsurancePayer.name)).all()
            return [_payer_view(row) for row in rows]

    def create_payer(self, actor: Actor, name: str, *,
                     bin: str | None = None, pcn: str | None = None,
                     default_group_id: str | None = None,
                     claim_standard: str = "D0",
                     billing_ndc_strategy: str = "MAJORITY_SOURCE") -> str:
        payer_name = _text(name, "Payer name", 120)
        if claim_standard not in {"D0", "F6"} or billing_ndc_strategy not in STRATEGIES:
            raise WorkflowError("Invalid payer claim standard or billing strategy")
        bin_value = _text(bin, "BIN", 12, optional=True)
        if bin_value is not None and (not bin_value.isascii() or not bin_value.isdigit()
                                      or len(bin_value) != 6):
            raise WorkflowError("BIN must be exactly six ASCII digits")
        pcn_value = _text(pcn, "PCN", 40, optional=True)
        default_group = _text(default_group_id, "Group", 100, optional=True)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            if s.scalar(select(InsurancePayer.id).where(
                InsurancePayer.site_id == actor.site_id,
                InsurancePayer.name == payer_name)):
                raise WorkflowError("A payer of that name exists at this pharmacy site")
            row = InsurancePayer(site_id=actor.site_id, name=payer_name,
                bin=bin_value, pcn=pcn_value, default_group_id=default_group,
                claim_standard=claim_standard, billing_ndc_strategy=billing_ndc_strategy)
            s.add(row); s.flush()
            self.service._audit(s, actor, "INSURANCE_PAYER_CREATED", row.id, {
                "name": payer_name, "claim_standard": claim_standard,
                "billing_ndc_strategy": billing_ndc_strategy,
            })
            return row.id

    def set_payer_active(self, actor: Actor, payer_id: str,
                         active: bool, reason: str) -> None:
        note = _text(reason, "Payer state reason", 1000)
        if not isinstance(active, bool):
            raise WorkflowError("Payer active state must be boolean")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            payer = s.scalar(select(InsurancePayer).where(
                InsurancePayer.id == payer_id, InsurancePayer.site_id == actor.site_id
            ).with_for_update())
            if payer is None:
                raise WorkflowError("Payer not found at pharmacy site")
            if payer.active == active:
                raise WorkflowError("Payer active state is unchanged")
            # Any patient with active claims on this payer must first reverse them.
            rows = s.scalars(select(PatientCoverage).where(
                PatientCoverage.site_id == actor.site_id,
                PatientCoverage.payer_id == payer.id)).all()
            if any(_active_claim_blocks_change(s, actor.site_id, item.patient_id) for item in rows):
                raise WorkflowError("Active paid synthetic claims block payer changes")
            payer.active = active
            self.service._audit(s, actor, "INSURANCE_PAYER_STATUS_CHANGED", payer.id,
                {"active": active, "reason": note})

    def list_coverages(self, actor: Actor, patient_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            self.service._site(s, Patient, patient_id, actor)
            rows = s.scalars(select(PatientCoverage).where(
                PatientCoverage.site_id == actor.site_id,
                PatientCoverage.patient_id == patient_id)
                .order_by(PatientCoverage.position)).all()
            return [_coverage_view(row, s.get(InsurancePayer, row.payer_id))
                    for row in rows]

    def upsert_coverage(self, actor: Actor, patient_id: str, position: int,
                        payer_id: str, member_id: str, *,
                        person_code: str | None = None,
                        group_id: str | None = None,
                        relationship: str = "SELF",
                        cardholder_name: str | None = None,
                        cardholder_date_of_birth: str | None = None,
                        effective_date: str | None = None,
                        termination_date: str | None = None) -> str:
        if isinstance(position, bool) or not isinstance(position, int) or not 1 <= position <= 4:
            raise WorkflowError("Coverage position must be between 1 and 4")
        if relationship not in RELATIONSHIPS:
            raise WorkflowError("Invalid coverage relationship")
        member = _text(member_id, "Member ID", 150)
        person = _text(person_code, "Person code", 30, optional=True)
        group = _text(group_id, "Coverage group ID", 100, optional=True)
        cardholder = _text(cardholder_name, "Cardholder name", 200, optional=True)
        birthday = _day(cardholder_date_of_birth, "Cardholder birth date")
        effective = _day(effective_date, "Effective date")
        termination = _day(termination_date, "Termination date")
        if birthday and birthday > date.today().isoformat():
            raise WorkflowError("Cardholder birth date cannot be in the future")
        if effective and termination and termination < effective:
            raise WorkflowError("Coverage termination precedes effective date")
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            self.service._site(s, Patient, patient_id, actor)
            payer = s.scalar(select(InsurancePayer).where(
                InsurancePayer.id == payer_id,
                InsurancePayer.site_id == actor.site_id).with_for_update())
            if payer is None or not payer.active:
                raise WorkflowError("An active payer at the pharmacy site is required")
            if _active_claim_blocks_change(s, actor.site_id, patient_id):
                raise WorkflowError("Active paid synthetic claims block patient coverage edits")
            row = s.scalar(select(PatientCoverage).where(
                PatientCoverage.patient_id == patient_id,
                PatientCoverage.site_id == actor.site_id,
                PatientCoverage.position == position).with_for_update())
            before_payer_id = row.payer_id if row else None
            before_active = row.active if row else None
            if row is None:
                row = PatientCoverage(site_id=actor.site_id, patient_id=patient_id,
                    payer_id=payer_id, position=position, member_id=member,
                    created_by_id=actor.id)
                s.add(row)
            row.payer_id, row.member_id = payer_id, member
            row.person_code, row.group_id = person, group
            row.relationship, row.cardholder_name = relationship, cardholder
            row.cardholder_date_of_birth = birthday
            row.effective_date, row.termination_date = effective, termination
            row.active = True
            s.flush()
            # Never include member number, group, DOB, or person code in audit metadata.
            self.service._audit(s, actor, "PATIENT_COVERAGE_POSITION_SET", row.id, {
                "patient_id": patient_id, "position": position, "payer_id": payer_id,
                "replaced_payer_id": before_payer_id, "previously_active": before_active,
            })
            return row.id

    def deactivate_coverage(self, actor: Actor, patient_id: str,
                            position: int, reason: str) -> None:
        note = _text(reason, "Coverage cancellation reason", 1000)
        with self.service.sessions.begin() as s:
            self.service._authorized(s, actor, "correct")
            self.service._site(s, Patient, patient_id, actor)
            row = s.scalar(select(PatientCoverage).where(
                PatientCoverage.site_id == actor.site_id,
                PatientCoverage.patient_id == patient_id,
                PatientCoverage.position == position).with_for_update())
            if row is None or not row.active:
                raise WorkflowError("Active coverage position not found for patient")
            if _active_claim_blocks_change(s, actor.site_id, patient_id):
                raise WorkflowError("Active paid synthetic claims block coverage deletion")
            row.active = False
            self.service._audit(s, actor, "PATIENT_COVERAGE_DEACTIVATED", row.id,
                {"patient_id": patient_id, "position": position, "reason": note})

    def fill_claim_history(self, actor: Actor, fill_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            fill = s.get(Fill, fill_id)
            if fill is None:
                raise WorkflowError("Fill not found")
            self.service._site(s, Prescription, fill.prescription_id, actor)
            rows = s.scalars(select(ClaimCoverageSnapshot).where(
                ClaimCoverageSnapshot.site_id == actor.site_id,
                ClaimCoverageSnapshot.fill_id == fill_id)
                .order_by(ClaimCoverageSnapshot.coverage_position)).all()
            return [{
                "claim_id": item.claim_id, "payer_id": item.payer_id,
                "coverage_id": item.coverage_id, "position": item.coverage_position,
                "payer_name": item.payer_name_snapshot,
                "member_id_masked": _mask(item.member_id_snapshot),
                "claim_standard": item.claim_standard_snapshot,
                "billing_ndc_strategy": item.billing_strategy_snapshot,
                "intended_quantity": item.intended_quantity_snapshot,
                "physical_quantity": item.physical_quantity_snapshot,
                "warning": "SYNTHETIC_CLAIM_SNAPSHOT_NO_ELIGIBILITY_OR_LIVE_COB",
            } for item in rows]
