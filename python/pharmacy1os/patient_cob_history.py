"""Patient-wide synthetic COB correction and rejection provenance; read-only.

A reconciliation aid, not proof of insurance payment, pharmacy dispensing,
or eligibility. Never includes member numbers, notes, DOB, or raw payer data.
All source records are site-scoped and hashed event evidence is verified.
"""
from __future__ import annotations

from sqlalchemy import func, select

from .claim_rebilling import SyntheticRebillLink
from .claim_transactions import _view
from .claim_transactions_models import SandboxClaimTransaction
from .cob_attempts import CobAttemptRegistry
from .models import Fill, Patient, Prescription
from .service import Actor, PharmacyService, WorkflowError


class PatientCobHistory:
    def __init__(self, service: PharmacyService):
        self.service = service

    def history(self, actor: Actor, patient_id: str, *, limit: int = 25,
                offset: int = 0) -> dict:
        if (not isinstance(limit, int) or isinstance(limit, bool)
                or not 1 <= limit <= 50):
            raise WorkflowError("Patient COB history limit must be 1-50")
        if (not isinstance(offset, int) or isinstance(offset, bool)
                or not 0 <= offset <= 10000):
            raise WorkflowError("Patient COB history offset must be 0-10000")
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            patient = self.service._site(s, Patient, patient_id, actor)
            scope = (Prescription.site_id == actor.site_id,
                     Prescription.patient_id == patient.id)
            total = s.scalar(select(func.count()).select_from(Fill)
                .join(Prescription, Fill.prescription_id == Prescription.id)
                .where(*scope)) or 0
            selection = s.execute(select(Fill, Prescription)
                .join(Prescription, Fill.prescription_id == Prescription.id)
                .where(*scope)
                .order_by(Prescription.rx_number, Fill.fill_number.desc(),
                          Fill.attempt.desc(), Fill.id.desc())
                .limit(limit + 1).offset(offset)).all()
            page = selection[:limit]
            # Every link involving this patient's Rx is validated, even when
            # its older fill is outside the current paginated page.
            all_links = s.scalars(select(SyntheticRebillLink)
                .join(Fill, SyntheticRebillLink.original_fill_id == Fill.id)
                .join(Prescription, Fill.prescription_id == Prescription.id)
                .where(SyntheticRebillLink.site_id == actor.site_id, *scope)).all()
            from_links: dict[str, SyntheticRebillLink] = {}
            to_links: dict[str, SyntheticRebillLink] = {}
            for link in all_links:
                old = s.get(Fill, link.original_fill_id)
                new = s.get(Fill, link.replacement_fill_id)
                if (old is None or new is None or new.prescription_id != old.prescription_id
                        or new.fill_number != old.fill_number
                        or new.attempt != old.attempt + 1
                        or old.status != "RETURNED"
                        or link.original_fill_id in from_links
                        or link.replacement_fill_id in to_links):
                    raise WorkflowError("Broken or duplicate patient synthetic rebill chain")
                from_links[old.id] = link
                to_links[new.id] = link
            rows = []
            for fill, rx in page:
                # The full versioned ledger validates every paid and reversed
                # synthetic attempt, including response hashes and ancestry.
                cob = CobAttemptRegistry(self.service)._history_tx(s, actor, fill.id)
                events = s.scalars(select(SandboxClaimTransaction).where(
                    SandboxClaimTransaction.site_id == actor.site_id,
                    SandboxClaimTransaction.fill_id == fill.id).order_by(
                    SandboxClaimTransaction.recorded_at,
                    SandboxClaimTransaction.id)).all()
                indexed = {ev.id: ev for ev in events}
                validated = {ev.id: _view(ev) for ev in events}
                rejections = {}
                for ev in events:
                    if ev.operation != "TEST_REJECT":
                        continue
                    view = validated[ev.id]
                    req, res = view["request"], view["response"]
                    codes = res.get("reject_codes")
                    if (ev.claim_id is not None or ev.original_transaction_id is not None
                            or ev.outcome != "REJECTED_SYNTHETIC"
                            or req.get("fill_id") != fill.id
                            or req.get("coverage_id") != ev.coverage_id
                            or req.get("payer_id") != ev.payer_id
                            or not isinstance(codes, list) or len(codes) != 1
                            or codes[0] != req.get("reject_code")):
                        raise WorkflowError("Mock rejection event ancestry is inconsistent")
                    rejections[ev.id] = {
                        "rejection_id": ev.id, "payer_id": ev.payer_id,
                        "coverage_id": ev.coverage_id,
                        "coverage_position": req.get("position"),
                        "reject_code": codes[0],
                        "resolution_id": None, "retry_id": None,
                        "status": "OPEN_TEST_REJECTION",
                        "recorded_at": ev.recorded_at.isoformat(),
                        "external_payer_rejection": False,
                    }
                # SQLite timestamps can tie; UUID sorting is not a causal
                # clock. Validate resolutions before retries regardless of
                # same-timestamp event ID ordering.
                linked_events = [ev for ev in events
                                 if ev.operation in ("TEST_RESOLVE", "TEST_RETRY")]
                linked_events.sort(key=lambda ev: 0 if ev.operation == "TEST_RESOLVE" else 1)
                for ev in linked_events:
                    ancestor = indexed.get(ev.original_transaction_id)
                    if (ancestor is None or ancestor.operation != "TEST_REJECT"
                            or ancestor.id not in rejections
                            or ev.claim_id is not None
                            or ev.payer_id != ancestor.payer_id
                            or ev.coverage_id != ancestor.coverage_id):
                        raise WorkflowError("Mock rejection resolution/retry is orphaned")
                    req = validated[ev.id]["request"]
                    entry = rejections[ancestor.id]
                    if ev.operation == "TEST_RESOLVE":
                        if (ev.outcome != "CLEARED_TEST_HOLD"
                                or req.get("original_transaction_id") != ancestor.id
                                or entry["resolution_id"] is not None):
                            raise WorkflowError("Duplicate or mislinked mock rejection resolution")
                        entry["resolution_id"] = ev.id
                        entry["status"] = "CLEARED_TEST_HOLD"
                    else:
                        if (ev.outcome != "RETRIED_SYNTHETIC"
                                or req.get("original_rejection_id") != ancestor.id
                                or req.get("resolution_id") != entry["resolution_id"]
                                or not isinstance(req.get("coverage_ids"), list)
                                or ancestor.coverage_id not in req["coverage_ids"]
                                or entry["retry_id"] is not None
                                or not cob["claim_positions"]):
                            raise WorkflowError("Mock retry was not preceded by a valid local resolution")
                        entry["retry_id"] = ev.id
                        entry["status"] = "RETRY_PREPARED_SYNTHETIC"
                # Same-time SQLite rows can sort by UUID, not creation order.
                # Independently check all retry prerequisites after scanning.
                for entry in rejections.values():
                    if entry["retry_id"] and not entry["resolution_id"]:
                        raise WorkflowError("Mock retry has no pharmacist resolution")
                invalid = [ev.operation for ev in events if ev.operation not in (
                    "BILL", "REVERSE", "TEST_REJECT", "TEST_RESOLVE", "TEST_RETRY")]
                if invalid:
                    raise WorkflowError("Unknown synthetic claim event in patient ledger")
                correction_count = sum(max(0, len(c["attempts"]) - 1)
                                       for c in cob["claim_positions"])
                rows.append({
                    "fill_id": fill.id, "prescription_id": rx.id,
                    "rx_number": rx.rx_number, "fill_number": fill.fill_number,
                    "attempt": fill.attempt, "fill_status": fill.status,
                    "physical_quantity": str(fill.quantity),
                    "payer_intended_quantity": str(fill.billed_quantity),
                    "claim_positions": cob["claim_positions"],
                    "active_local_paid_positions": cob["active_local_paid_positions"],
                    "payer_correction_count": correction_count,
                    "synthetic_test_rejections": list(rejections.values()),
                    "open_test_rejections": sum(
                        x["status"] == "OPEN_TEST_REJECTION" for x in rejections.values()),
                    "original_fill_id": (to_links[fill.id].original_fill_id
                                         if fill.id in to_links else None),
                    "replacement_fill_id": (from_links[fill.id].replacement_fill_id
                                            if fill.id in from_links else None),
                    "external_payer_contact": False,
                })
            return {
                "patient_id": patient.id,
                "patient_name": f"{patient.last_name}, {patient.first_name}",
                "total_fills": total, "limit": limit, "offset": offset,
                "next_offset": offset + limit if len(selection) > limit else None,
                "fills": rows,
                "summary": {
                    "open_test_rejections_in_page": sum(r["open_test_rejections"]
                                                        for r in rows),
                    "payer_corrections_in_page": sum(r["payer_correction_count"]
                                                    for r in rows),
                    "replacement_links_for_patient": len(all_links),
                },
                "warning": "SYNTHETIC_ONLY_NO_REAL_CLAIM_APPROVAL_OR_PAYMENT",
            }
