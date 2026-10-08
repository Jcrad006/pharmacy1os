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


def create_app(service: PharmacyService | None = None, *, synthetic_enabled: bool = False) -> FastAPI:
    app = FastAPI(title="Pharmacy1OS Python migration — synthetic only", version="0.1.0")
    svc = service or PharmacyService(os.getenv("PHARMACY1OS_PY_DATABASE_URL", "sqlite+pysqlite:///pharmacy1os_demo.sqlite3"))

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
