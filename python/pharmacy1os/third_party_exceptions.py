"""Site-wide, paginated synthetic Third Party operational exception queue.

Unlike a capped recent-events feed, pending mock holds and uncompleted local
rebill replacements are derived from *full* site-scoped provenance.  This
projection never sends claims, clears holds or dispenses physical stock.
"""
from __future__ import annotations

from datetime import datetime, timezone
from sqlalchemy import exists, select

from .claim_rebilling import SyntheticRebillLink
from .claim_transactions import _view
from .claim_transactions_models import SandboxClaimTransaction
from .cob_attempts import CobAttemptRegistry
from .insurance_models import PatientCoverage
from .models import Fill, Patient, Prescription
from .service import Actor, PharmacyService, WorkflowError


STATUSES = frozenset({
    "OPEN_TEST_REJECTION",
    "CLEARED_AWAITING_RETRY",
    "REPLACEMENT_RESCAN_REQUIRED",
    "REPLACEMENT_PHARMACIST_REVIEW",
    "RECONCILIATION_REQUIRED",
})


def _moment(value: datetime) -> float:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


class ThirdPartyExceptionQueue:
    def __init__(self, service: PharmacyService):
        self.service = service

    def snapshot(self, actor: Actor, *, status: str = "ALL",
                 limit: int = 25, offset: int = 0) -> dict:
        if not isinstance(status, str) or status not in STATUSES | {"ALL"}:
            raise WorkflowError("Unrecognized synthetic Third Party exception filter")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
            raise WorkflowError("Exception queue limit must be between 1 and 50")
        if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 10000:
            raise WorkflowError("Exception queue offset must be between 0 and 10000")

        # Each underlying category only needs offset + limit + 1 records:
        # even after global merge, an older record cannot appear on this page
        # if the same category has more than that many newer records.
        bound = offset + limit + 1
        with self.service.sessions() as s:
            self.service._authorized(s, actor, "read")
            retry_table = SandboxClaimTransaction.__table__.alias("completed_retry")
            unresolved = s.execute(select(
                SandboxClaimTransaction, Fill, Prescription, Patient
            ).join(Fill, SandboxClaimTransaction.fill_id == Fill.id)
             .join(Prescription, Fill.prescription_id == Prescription.id)
             .join(Patient, Prescription.patient_id == Patient.id)
             .where(
                 SandboxClaimTransaction.site_id == actor.site_id,
                 Prescription.site_id == actor.site_id,
                 Patient.site_id == actor.site_id,
                 SandboxClaimTransaction.operation == "TEST_REJECT",
                 ~exists(select(retry_table.c.id).where(
                     retry_table.c.site_id == actor.site_id,
                     retry_table.c.original_transaction_id == SandboxClaimTransaction.id,
                     retry_table.c.operation == "TEST_RETRY",
                 )),
             ).order_by(
                 SandboxClaimTransaction.recorded_at.desc(),
                 SandboxClaimTransaction.id.desc()).limit(bound)).all()
            ids = [tx.id for tx, *_ in unresolved]
            related = s.scalars(select(SandboxClaimTransaction).where(
                SandboxClaimTransaction.site_id == actor.site_id,
                SandboxClaimTransaction.original_transaction_id.in_(ids),
                SandboxClaimTransaction.operation.in_(("TEST_RESOLVE", "TEST_RETRY"))
            )).all() if ids else []
            by_reject: dict[str, dict[str, SandboxClaimTransaction]] = {}
            for event in related:
                _view(event)
                if event.original_transaction_id is None:
                    raise WorkflowError("Orphan test hold response ancestry")
                by_reject.setdefault(event.original_transaction_id, {})[event.operation] = event

            outstanding = []
            for tx, fill, rx, patient in unresolved:
                data = _view(tx)
                req = data["request"]
                if (tx.outcome != "REJECTED_SYNTHETIC"
                        or tx.original_transaction_id is not None
                        or tx.claim_id is not None
                        or req.get("fill_id") != fill.id
                        or req.get("coverage_id") != tx.coverage_id
                        or req.get("payer_id") != tx.payer_id):
                    raise WorkflowError("Synthetic test rejection evidence does not match its fill")
                coverage = s.scalar(select(PatientCoverage).where(
                    PatientCoverage.site_id == actor.site_id,
                    PatientCoverage.id == tx.coverage_id,
                    PatientCoverage.patient_id == rx.patient_id))
                links = by_reject.get(tx.id, {})
                resolution, retry = links.get("TEST_RESOLVE"), links.get("TEST_RETRY")
                if retry is not None:
                    # Concurrent reads may see a retry while scanning a prior
                    # snapshot. Never present a retried hold as still pending.
                    continue
                if resolution is not None:
                    rv = _view(resolution)
                    if (resolution.outcome != "CLEARED_TEST_HOLD"
                            or resolution.fill_id != fill.id
                            or resolution.coverage_id != tx.coverage_id
                            or resolution.payer_id != tx.payer_id
                            or resolution.claim_id is not None
                            or rv["request"].get("original_transaction_id") != tx.id):
                        raise WorkflowError("Test hold resolution has inconsistent ancestry")
                reconciled = (
                    fill.status == "PRODUCT_FILL" and rx.status == "PRODUCT_FILL"
                    and coverage is not None and coverage.payer_id == tx.payer_id
                    and coverage.position == req.get("position")
                )
                state = (
                    "RECONCILIATION_REQUIRED" if not reconciled
                    else "CLEARED_AWAITING_RETRY" if resolution is not None
                    else "OPEN_TEST_REJECTION"
                )
                if status != "ALL" and status != state:
                    continue
                outstanding.append({
                    "kind": "TEST_HOLD", "status": state,
                    "site_id": actor.site_id,
                    "event_id": tx.id, "fill_id": fill.id, "rx_number": rx.rx_number,
                    "patient_id": patient.id,
                    "patient_name": f"{patient.last_name}, {patient.first_name}",
                    "coverage_id": tx.coverage_id, "payer_id": tx.payer_id,
                    "coverage_position": req.get("position"),
                    "resolution_id": resolution.id if resolution is not None else None,
                    "reason_code": data["response"].get("reject_codes", [None])[0],
                    "recommended_action": (
                        "MANUAL_RECONCILIATION" if not reconciled
                        else "PHARMACIST_REVIEW_TEST_REJECTION" if resolution is None
                        else "CHECK_ALL_COB_HOLDS_BEFORE_RETRY"
                    ),
                    "recorded_at": tx.recorded_at.isoformat(),
                    "_sort": (_moment(tx.recorded_at), tx.id),
                })

            pending_rows = s.execute(select(
                SyntheticRebillLink, Fill, Prescription, Patient
            ).join(Fill, SyntheticRebillLink.replacement_fill_id == Fill.id)
             .join(Prescription, Fill.prescription_id == Prescription.id)
             .join(Patient, Prescription.patient_id == Patient.id)
             .where(
                 SyntheticRebillLink.site_id == actor.site_id,
                 Prescription.site_id == actor.site_id,
                 Patient.site_id == actor.site_id,
                 Fill.status.in_(("PRODUCT_FILL", "PHARMACIST_REVIEW")),
             ).order_by(
                 SyntheticRebillLink.created_at.desc(),
                 SyntheticRebillLink.id.desc()).limit(bound)).all()
            for link, replacement, rx, patient in pending_rows:
                old = s.get(Fill, link.original_fill_id)
                if (old is None or old.prescription_id != rx.id
                        or old.fill_number != replacement.fill_number
                        or old.attempt + 1 != replacement.attempt
                        or old.status != "RETURNED"):
                    raise WorkflowError("Synthetic replacement fill lineage requires reconciliation")
                history = CobAttemptRegistry(self.service)._history_tx(s, actor, old.id)
                positions = history["claim_positions"]
                from json import loads
                expected = loads(link.reversed_claim_ids_json)
                if (not positions or [p["claim_id"] for p in positions] != expected
                        or history["active_local_paid_positions"] != 0
                        or any(p["attempts"][-1]["reversal_transaction_id"] is None
                               for p in positions)):
                    raise WorkflowError("Replacement fill has incomplete previous payer reversals")
                state = ("REPLACEMENT_RESCAN_REQUIRED" if replacement.status == "PRODUCT_FILL"
                         else "REPLACEMENT_PHARMACIST_REVIEW")
                if status != "ALL" and status != state:
                    continue
                outstanding.append({
                    "kind": "REPLACEMENT_FILL", "status": state,
                    "site_id": actor.site_id,
                    "event_id": link.id, "fill_id": replacement.id,
                    "original_fill_id": old.id, "rx_number": rx.rx_number,
                    "patient_id": patient.id,
                    "patient_name": f"{patient.last_name}, {patient.first_name}",
                    "coverage_id": None, "payer_id": None, "coverage_position": None,
                    "resolution_id": None, "reason_code": None,
                    "recommended_action": (
                        "PHYSICAL_RESCAN_REQUIRED" if replacement.status == "PRODUCT_FILL"
                        else "PHARMACIST_FINAL_VERIFICATION_REQUIRED"
                    ),
                    "recorded_at": link.created_at.isoformat(),
                    "_sort": (_moment(link.created_at), link.id),
                })

            outstanding.sort(key=lambda item: item["_sort"], reverse=True)
            page = outstanding[offset:offset + limit]
            has_more = len(outstanding) > offset + limit
            for item in page:
                item.pop("_sort")
            return {
                "status_filter": status, "limit": limit, "offset": offset,
                "next_offset": offset + limit if has_more else None,
                "items": page,
                "returned": len(page),
                "counts_in_page": {
                    name: sum(item["status"] == name for item in page)
                    for name in sorted(STATUSES)
                },
                "warning": (
                    "SYNTHETIC_LOCAL_EXCEPTION_QUEUE_ONLY; statuses are site-scoped "
                    "development work items, not payer responses or dispense authorization"
                ),
            }
