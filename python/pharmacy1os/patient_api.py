"""FastAPI adapters for synthetic Python patient directory lookup."""
from __future__ import annotations
from typing import Callable
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from .patient_directory import PatientDirectory
from .service import Actor

class PatientDirectoryIn(BaseModel):
    first_name: str
    last_name: str
    date_of_birth: str | None = None
    phone: str | None = None
    email: str | None = None

def make_patient_router(directory: PatientDirectory, actor_dependency: Callable[..., Actor]) -> APIRouter:
    router = APIRouter(prefix="/api/patients", tags=["synthetic-patients"])

    @router.get("")
    def original_patient_list(
            actor: Actor = Depends(actor_dependency),
            query: str = "",
            first_name: str = Query("", alias="firstName"),
            last_name: str = Query("", alias="lastName"),
            date_of_birth: str | None = Query(None, alias="dateOfBirth"),
            phone: str = ""):
        """Original Fastify GET /patients semantics, wrapped in the Python /api namespace."""
        matches = directory.search(actor, query=query, first_name=first_name,
            last_name=last_name, date_of_birth=date_of_birth, phone=phone)
        return {"patients": [{
            "id": p["id"], "siteId": p["site_id"],
            "firstName": p["first_name"], "lastName": p["last_name"],
            "dateOfBirth": p["date_of_birth"], "phone": p["phone"],
            "email": p["email"],
        } for p in matches]}

    @router.get("/search")
    def search(query: str = "", first_name: str = "", last_name: str = "",
               date_of_birth: str | None = None, phone: str = "", limit: int = 100,
               actor: Actor = Depends(actor_dependency)):
        return {"patients": directory.search(actor, query=query, first_name=first_name,
                   last_name=last_name, date_of_birth=date_of_birth,
                   phone=phone, limit=limit)}

    @router.post("/normalized", status_code=201)
    def add_patient(payload: PatientDirectoryIn, actor: Actor = Depends(actor_dependency)):
        return {"id": directory.create(actor, payload.first_name, payload.last_name,
                    dob=payload.date_of_birth, phone=payload.phone,
                    email=payload.email)}

    return router
