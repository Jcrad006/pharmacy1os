"""FastAPI adapter for the new Python domain (synthetic-only, disabled by default).

Passing an x-demo-staff-id is impersonation, not authentication. NEVER enable
this adapter against patient data, shared networks, or a live pharmacy.
"""

import os
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from .models import Staff
from .service import AccessDenied, Actor, PharmacyService, WorkflowError
from .documents import DocumentService, decode_base64
from .inventory_ops import InventoryService
from .inventory_advanced import AdvancedInventoryService
from .lifecycle import LifecycleService
from .provider_api import make_provider_router
from .provider_directory import ProviderDirectory
from .scheduling import SchedulingService
from .scheduling_api import make_schedule_router
from .billing import BillingService
from .billing_api import make_billing_router
from .willcall import WillCallService
from .willcall_api import make_willcall_router
from .pos import PosService
from .pos_api import make_pos_router
from .patient_directory import PatientDirectory
from .patient_api import make_patient_router
from .exceptions import ExceptionService
from .exceptions_api import make_exceptions_router
from .date_rules import DateRulesService
from .date_rules_api import make_date_rules_router
from .communications import CommunicationService
from .communications_api import make_communications_router


class PatientIn(BaseModel):
    first: str
    last: str
    dob: str | None = None
    phone: str | None = None


class PrescriberIn(BaseModel):
    first: str
    last: str
    level: str
    npi: str | None = None


class DrugIn(BaseModel):
    name: str
    strength: str
    dosage_form: str
    controlled: bool = False


class ProductIn(BaseModel):
    drug_id: str
    ndc: str
    manufacturer: str
    description: str
    price: str = "0"


class BarcodeIn(BaseModel):
    product_id: str
    barcode: str


class ReceiveIn(BaseModel):
    barcode: str
    lot: str
    expires: str
    quantity: str


class RxIn(BaseModel):
    patient_id: str
    prescriber_id: str
    drug_id: str
    rx_number: str
    sig: str
    quantity: str
    refills: int = Field(default=0, ge=0)
    expiration_date: str | None = None
    do_not_fill_before: str | None = None


class FillIn(BaseModel):
    dispense_quantity: str | None = None


class SourceIn(BaseModel):
    barcode: str
    lot: str
    expires: str
    quantity: str


class PrepareIn(BaseModel):
    payers: list[str] = Field(default_factory=list, max_length=4)


class StageIn(BaseModel):
    bin_name: str
    bag_barcode: str


class SaleIn(BaseModel):
    identity_verified: bool
    signed: bool
    amount: str
    tender: str
    scanned_bag: str | None = None


class ReasonIn(BaseModel):
    reason: str


class IssueIn(BaseModel):
    severity: str
    code: str


class ResolutionIn(BaseModel):
    note: str



class SourceDocumentIn(BaseModel):
    base64_data: str
    mime_type: str
    source_type: str = "SCAN"
    filename: str | None = None


class AnnotationIn(BaseModel):
    text: str
    x: float
    y: float
    width: float
    height: float
    change: dict[str, str | None]


class HoldIn(BaseModel):
    stock_id: str
    quantity: str
    reason: str


class ResolveHoldIn(BaseModel):
    disposition: str
    reason: str


class AdjustmentIn(BaseModel):
    delta: str
    reason: str

class PurchaseOrderLineIn(BaseModel):
    product_id: str
    quantity: str


class PurchaseOrderIn(BaseModel):
    vendor: str
    reference: str
    lines: list[PurchaseOrderLineIn] = Field(min_length=1, max_length=100)


class PurchaseReceiptIn(BaseModel):
    lot: str
    expires: str
    quantity: str
    invoice: str


class TransferIn(BaseModel):
    stock_id: str
    destination_site_id: str
    quantity: str
    reason: str


class CycleCountEntryIn(BaseModel):
    stock_id: str
    counted_on_hand: str


class CycleReviewIn(BaseModel):
    approve: bool
    reason: str


class RecallIn(BaseModel):
    product_id: str
    reference: str
    reason: str
    lot: str | None = None


def create_app(service: PharmacyService | None = None, *, synthetic_enabled: bool = False) -> FastAPI:
    app = FastAPI(title="Pharmacy1OS Python migration — synthetic only", version="0.1.0")
    svc = service or PharmacyService(os.getenv("PHARMACY1OS_PY_DATABASE_URL", "sqlite+pysqlite:///pharmacy1os_demo.sqlite3"))
    docs = DocumentService.from_demo_env(svc)
    stock_ops = InventoryService(svc)
    advanced_ops = AdvancedInventoryService(svc)
    lifecycle = LifecycleService(svc)

    @app.middleware("http")
    async def guarded(request, call_next):
        if request.url.path != "/health" and not synthetic_enabled:
            from starlette.responses import JSONResponse
            return JSONResponse({"detail": "Python migration API disabled: no production authentication"}, status_code=503)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(WorkflowError)
    async def invalid_workflow(_request, exc: WorkflowError):
        from starlette.responses import JSONResponse
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(AccessDenied)
    async def denied(_request, _exc: AccessDenied):
        from starlette.responses import JSONResponse
        return JSONResponse({"detail": "Access denied"}, status_code=403)

    @app.exception_handler(IntegrityError)
    async def constraint(_request, _exc: IntegrityError):
        from starlette.responses import JSONResponse
        return JSONResponse({"detail": "Duplicate or invalid database record"}, status_code=409)

    def staff_actor(x_demo_staff_id: Annotated[str | None, Header()] = None) -> Actor:
        if not x_demo_staff_id:
            raise HTTPException(403, "Development actor required")
        with svc.sessions() as s:
            user = s.get(Staff, x_demo_staff_id)
            if user is None or not user.active:
                raise HTTPException(403, "Unknown or inactive development actor")
            return Actor(id=user.id, site_id=user.site_id, role=user.role)

    DemoActor = Annotated[Actor, Depends(staff_actor)]
    app.include_router(make_provider_router(ProviderDirectory(svc), staff_actor))
    app.include_router(make_schedule_router(SchedulingService(svc), staff_actor))
    app.include_router(make_billing_router(BillingService(svc), staff_actor))
    app.include_router(make_willcall_router(WillCallService(svc), staff_actor))
    app.include_router(make_pos_router(PosService(svc), staff_actor))
    app.include_router(make_patient_router(PatientDirectory(svc), staff_actor))
    app.include_router(make_exceptions_router(ExceptionService(svc), staff_actor))
    app.include_router(make_date_rules_router(DateRulesService(svc), staff_actor))
    app.include_router(make_communications_router(CommunicationService(svc, docs), staff_actor))

    @app.get("/health")
    def health():
        return {"status": "ok", "synthetic_only": True, "enabled": synthetic_enabled}

    @app.get("/api/queue")
    def queue(actor: DemoActor, q: str = ""):
        return svc.queue(actor, q)

    @app.get("/api/audit")
    def audit(actor: DemoActor):
        return svc.audit_log(actor)

    @app.post("/api/patients")
    def add_patient(payload: PatientIn, actor: DemoActor):
        return {"id": svc.add_patient(actor, **payload.model_dump())}

    @app.post("/api/prescribers")
    def add_prescriber(payload: PrescriberIn, actor: DemoActor):
        return {"id": svc.add_prescriber(actor, **payload.model_dump())}

    @app.post("/api/drugs")
    def add_drug(payload: DrugIn, actor: DemoActor):
        return {"id": svc.add_drug(actor, **payload.model_dump())}

    @app.post("/api/products")
    def add_product(payload: ProductIn, actor: DemoActor):
        return {"id": svc.add_product(actor, **payload.model_dump())}

    @app.post("/api/barcodes")
    def register_barcode(payload: BarcodeIn, actor: DemoActor):
        return {"id": svc.register_barcode(actor, **payload.model_dump())}

    @app.post("/api/receiving")
    def receive(payload: ReceiveIn, actor: DemoActor):
        return {"id": svc.receive(actor, **payload.model_dump())}

    @app.post("/api/prescriptions")
    def new_rx(payload: RxIn, actor: DemoActor):
        return {"id": svc.add_prescription(actor, **payload.model_dump())}

    @app.post("/api/prescriptions/{rx_id}/dur")
    def advance_to_dur(rx_id: str, actor: DemoActor):
        svc.advance_to_dur(actor, rx_id)
        return {"ok": True}

    @app.post("/api/prescriptions/{rx_id}/issues")
    def add_issue(rx_id: str, payload: IssueIn, actor: DemoActor):
        return {"id": svc.add_dur_issue(actor, rx_id, **payload.model_dump())}

    @app.post("/api/issues/{issue_id}/resolve")
    def resolve_issue(issue_id: str, payload: ResolutionIn, actor: DemoActor):
        svc.resolve_dur(actor, issue_id, payload.note)
        return {"ok": True}

    @app.post("/api/prescriptions/{rx_id}/fills")
    def start_fill(rx_id: str, payload: FillIn, actor: DemoActor):
        return {"id": svc.start_fill(actor, rx_id, payload.dispense_quantity)}

    @app.post("/api/fills/{fill_id}/sources")
    def scan(fill_id: str, payload: SourceIn, actor: DemoActor):
        svc.scan_source(actor, fill_id, **payload.model_dump())
        return {"ok": True}

    @app.post("/api/fills/{fill_id}/prepare")
    def prepare(fill_id: str, payload: PrepareIn, actor: DemoActor):
        return {"labels": svc.prepare_for_review(actor, fill_id, payload.payers)}

    @app.post("/api/fills/{fill_id}/verify")
    def verify(fill_id: str, actor: DemoActor):
        svc.verify(actor, fill_id)
        return {"ok": True}

    @app.post("/api/fills/{fill_id}/stage")
    def stage(fill_id: str, payload: StageIn, actor: DemoActor):
        svc.stage_will_call(actor, fill_id, **payload.model_dump())
        return {"ok": True}

    @app.post("/api/fills/{fill_id}/sell")
    def sell(fill_id: str, payload: SaleIn, actor: DemoActor):
        svc.sell(actor, fill_id, **payload.model_dump())
        return {"ok": True}

    @app.post("/api/fills/{fill_id}/return-to-stock")
    def return_to_stock(fill_id: str, payload: ReasonIn, actor: DemoActor):
        svc.return_to_stock(actor, fill_id, payload.reason)
        return {"ok": True}

    @app.post("/api/prescriptions/{rx_id}/hold")
    def hold_rx(rx_id: str, payload: ReasonIn, actor: DemoActor):
        lifecycle.hold(actor, rx_id, payload.reason)
        return {"ok": True}

    @app.post("/api/prescriptions/{rx_id}/resume")
    def resume_rx(rx_id: str, payload: ReasonIn, actor: DemoActor):
        lifecycle.resume(actor, rx_id, payload.reason)
        return {"ok": True}

    @app.post("/api/prescriptions/{rx_id}/cancel")
    def cancel_rx(rx_id: str, payload: ReasonIn, actor: DemoActor):
        lifecycle.cancel(actor, rx_id, payload.reason)
        return {"ok": True}

    @app.get("/api/prescriptions/{rx_id}/documents")
    def documents(rx_id: str, actor: DemoActor):
        return {"documents": docs.list_sources(actor, rx_id)}

    @app.post("/api/prescriptions/{rx_id}/documents/original")
    def document_upload(rx_id: str, payload: SourceDocumentIn, actor: DemoActor):
        return {"document": docs.create_source(actor, rx_id, decode_base64(payload.base64_data),
               payload.mime_type, payload.source_type, payload.filename)}

    @app.post("/api/prescriptions/{rx_id}/documents/electronic-render")
    def electronic_render(rx_id: str, actor: DemoActor, message_id: str = "SYNTHETIC"):
        return {"document": docs.render_erx(actor, rx_id, message_id)}

    @app.get("/api/documents/{document_id}/content")
    def document_content(document_id: str, actor: DemoActor):
        from fastapi import Response
        bytes_, mime = docs.read_source(actor, document_id)
        # Attachment, rather than a live inline SVG, avoids active content in this demo API.
        return Response(bytes_, media_type=mime,
               headers={"Content-Disposition": "attachment; filename=prescription-source",
                        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})

    @app.get("/api/documents/{document_id}/annotations")
    def annotations(document_id: str, actor: DemoActor):
        return {"annotations": docs.list_annotations(actor, document_id)}

    @app.post("/api/documents/{document_id}/annotations")
    def annotate(document_id: str, payload: AnnotationIn, actor: DemoActor):
        return {"id": docs.annotate(actor, document_id, **payload.model_dump())}

    @app.post("/api/annotations/{annotation_id}/supersede")
    def supersede(annotation_id: str, document_id: str, payload: AnnotationIn, actor: DemoActor):
        return {"id": docs.annotate(actor, document_id, **payload.model_dump(), supersedes_id=annotation_id)}

    @app.get("/api/documents/integrity/problems")
    def integrity(actor: DemoActor):
        return {"problems": docs.verify_integrity(actor)}

    @app.get("/api/inventory/stock/{stock_id}/ledger")
    def inventory_ledger(stock_id: str, actor: DemoActor):
        return {"movements": stock_ops.ledger(actor, stock_id)}

    @app.get("/api/inventory/holds")
    def inventory_holds(actor: DemoActor):
        return {"holds": stock_ops.active_holds(actor)}

    @app.post("/api/inventory/holds")
    def quarantine(payload: HoldIn, actor: DemoActor):
        return {"id": stock_ops.create_hold(actor, **payload.model_dump())}

    @app.post("/api/inventory/holds/{hold_id}/resolve")
    def resolve_hold(hold_id: str, payload: ResolveHoldIn, actor: DemoActor):
        stock_ops.resolve_hold(actor, hold_id, **payload.model_dump())
        return {"ok": True}

    @app.post("/api/inventory/stock/{stock_id}/adjust")
    def adjust_inventory(stock_id: str, payload: AdjustmentIn, actor: DemoActor):
        stock_ops.adjust(actor, stock_id, **payload.model_dump())
        return {"ok": True}

    @app.get("/api/inventory/sites")
    def inventory_sites(actor: DemoActor):
        from sqlalchemy import select
        from .models import Site
        with svc.sessions() as session:
            svc._authorized(session, actor, "read")
            return [{"id": row.id, "name": row.name} for row in
                    session.scalars(select(Site).order_by(Site.name)).all()]

    @app.get("/api/inventory/purchase-orders")
    def purchase_orders(actor: DemoActor):
        return {"orders": advanced_ops.purchase_orders(actor)}

    @app.post("/api/inventory/purchase-orders")
    def create_purchase_order(payload: PurchaseOrderIn, actor: DemoActor):
        return {"id": advanced_ops.create_purchase_order(actor, payload.vendor,
                payload.reference, [line.model_dump() for line in payload.lines])}

    @app.post("/api/inventory/purchase-orders/lines/{line_id}/receive")
    def receive_purchase_order(line_id: str, payload: PurchaseReceiptIn, actor: DemoActor):
        return {"id": advanced_ops.receive_purchase_order(actor, line_id, **payload.model_dump())}

    @app.post("/api/inventory/purchase-orders/{order_id}/cancel")
    def cancel_purchase_order(order_id: str, payload: ReasonIn, actor: DemoActor):
        advanced_ops.cancel_purchase_order(actor, order_id, payload.reason)
        return {"ok": True}

    @app.get("/api/inventory/transfers")
    def transfers(actor: DemoActor):
        return {"transfers": advanced_ops.transfers(actor)}

    @app.post("/api/inventory/transfers")
    def ship_transfer(payload: TransferIn, actor: DemoActor):
        return {"id": advanced_ops.ship_transfer(actor, **payload.model_dump())}

    @app.post("/api/inventory/transfers/{transfer_id}/receive")
    def receive_transfer(transfer_id: str, actor: DemoActor):
        return {"stock_id": advanced_ops.receive_transfer(actor, transfer_id)}

    @app.post("/api/inventory/transfers/{transfer_id}/cancel")
    def cancel_transfer(transfer_id: str, payload: ReasonIn, actor: DemoActor):
        advanced_ops.cancel_transfer(actor, transfer_id, payload.reason)
        return {"ok": True}

    @app.get("/api/inventory/cycle-counts")
    def cycle_counts(actor: DemoActor):
        return {"counts": advanced_ops.cycle_counts(actor)}

    @app.post("/api/inventory/cycle-counts")
    def create_cycle_count(actor: DemoActor):
        return {"id": advanced_ops.create_cycle_count(actor)}

    @app.post("/api/inventory/cycle-counts/{session_id}/lines")
    def record_cycle_count(session_id: str, payload: CycleCountEntryIn, actor: DemoActor):
        return {"id": advanced_ops.record_count(actor, session_id, **payload.model_dump())}

    @app.post("/api/inventory/cycle-counts/{session_id}/submit")
    def submit_cycle_count(session_id: str, actor: DemoActor):
        advanced_ops.submit_cycle_count(actor, session_id)
        return {"ok": True}

    @app.post("/api/inventory/cycle-counts/{session_id}/review")
    def review_cycle_count(session_id: str, payload: CycleReviewIn, actor: DemoActor):
        advanced_ops.review_cycle_count(actor, session_id, **payload.model_dump())
        return {"ok": True}

    @app.get("/api/inventory/recalls")
    def recalls(actor: DemoActor):
        return {"recalls": advanced_ops.recalls(actor)}

    @app.post("/api/inventory/recalls")
    def open_recall(payload: RecallIn, actor: DemoActor):
        return {"id": advanced_ops.open_recall(actor, **payload.model_dump())}

    @app.post("/api/inventory/recalls/{recall_id}/close")
    def close_recall(recall_id: str, payload: ReasonIn, actor: DemoActor):
        advanced_ops.close_recall(actor, recall_id, payload.reason)
        return {"ok": True}

    return app


def main() -> None:
    import uvicorn
    if os.getenv("PHARMACY1OS_SYNTHETIC_DEMO") != "1":
        raise SystemExit("Refusing to start: set PHARMACY1OS_SYNTHETIC_DEMO=1 for isolated synthetic testing")
    url = os.getenv("PHARMACY1OS_PY_DATABASE_URL", "sqlite+pysqlite:///pharmacy1os_demo.sqlite3")
    if not url.startswith("sqlite+pysqlite:///"):
        raise SystemExit("Demo API only supports isolated SQLite. PostgreSQL migration is not yet ready.")
    svc = PharmacyService(url)
    svc.create_schema()
    uvicorn.run(create_app(svc, synthetic_enabled=True), host="127.0.0.1", port=8008)


if __name__ == "__main__":
    main()
