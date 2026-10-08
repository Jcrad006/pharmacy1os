from datetime import date
import pytest
from fastapi.testclient import TestClient
from pharmacy1os.patient_directory import PatientDirectory
from pharmacy1os.service import PharmacyService, WorkflowError, AccessDenied
from pharmacy1os.api import create_app

@pytest.fixture
def directory():
    svc=PharmacyService();svc.create_schema()
    a=svc.bootstrap_demo()["actors"]
    directory=PatientDirectory(svc)
    directory.create(a["TECHNICIAN"],"Taylor","Jones",dob="07/04/1988",phone="(919) 555-1010")
    directory.create(a["TECHNICIAN"],"Alex","Johnson",dob="1980-05-01",phone="919-555-1020")
    return svc,a,directory


def test_patient_filters_phone_dob_last_first(directory):
    svc,a,d=directory
    assert d.search(a["AUDITOR"],query="JONES, tay")[0]["first_name"]=="Taylor"
    assert d.search(a["TECHNICIAN"],phone="5551010",date_of_birth="1988-07-04")[0]["last_name"]=="Jones"
    assert len(d.search(a["TECHNICIAN"],query="91955510"))==2
    assert d.search(a["AUDITOR"],last_name="john",first_name="al")[0]["last_name"]=="Johnson"
    assert len(d.search(a["AUDITOR"],limit=1))==1


def test_invalid_date_and_site_prohibition(directory):
    svc,a,d=directory
    with pytest.raises(WorkflowError,match="calendar date"):
        d.create(a["TECHNICIAN"],"Bad","DOB",dob="02/30/2020")
    with pytest.raises(WorkflowError):d.search(a["AUDITOR"],date_of_birth="12/40/2000")
    with pytest.raises(WorkflowError):d.search(a["AUDITOR"],limit=0)
    second=svc.bootstrap_demo()["actors"]
    assert d.search(second["PHARMACIST"])==[]
    with pytest.raises(AccessDenied):d.create(a["AUDITOR"],"No","Write")


def test_normalized_patient_api(directory):
    svc,a,d=directory
    c=TestClient(create_app(svc,synthetic_enabled=True))
    tech={"x-demo-staff-id":a["TECHNICIAN"].id}
    reader={"x-demo-staff-id":a["AUDITOR"].id}
    assert len(c.get("/api/patients/search",headers=reader,params={"query":"jo"}).json()["patients"])==2
    created=c.post("/api/patients/normalized",headers=tech,json={
        "first_name":"Morgan","last_name":"Kelly","date_of_birth":"01/01/2000","phone":"555-0100"})
    assert created.status_code==201,created.text
    assert c.get("/api/patients/search",headers=reader,params={"phone":"5550100"}).json()["patients"][0]["id"]==created.json()["id"]
    denied=c.post("/api/patients/normalized",headers=reader,json={"first_name":"A","last_name":"B"})
    assert denied.status_code==403
