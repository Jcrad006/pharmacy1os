"""Prescriber professional identity, contact and site-scope regression coverage."""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from pharmacy1os.models import Audit, Site, Staff
from pharmacy1os.provider_directory import ProviderContact, ProviderDirectory, ProviderIdentifier
from pharmacy1os.service import AccessDenied, Actor, PharmacyService, WorkflowError


@pytest.fixture
def env(tmp_path):
    pharmacy = PharmacyService(f"sqlite+pysqlite:///{tmp_path / 'provider.db'}")
    pharmacy.create_schema()
    demo = pharmacy.bootstrap_demo()
    directory = ProviderDirectory(pharmacy)
    actors = demo["actors"]
    rx = pharmacy.add_prescriber(actors["TECHNICIAN"], "Amina", "Moore", "NP", "1234567893")
    yield pharmacy, directory, actors, rx
    pharmacy.engine.dispose()


def test_identifiers_can_hold_npi_multiple_dea_state_identifiers(env):
    _, directory, a, rx = env
    directory.add_identifier(a["PHARMACIST"], rx, "NPI", "1234567893", is_primary=True)
    directory.add_identifier(a["PHARMACIST"], rx, "DEA", "AB 1234567", "NC", True)
    directory.add_identifier(a["PHARMACIST"], rx, "DEA", "AB-7654321", "VA")
    directory.add_identifier(a["PHARMACIST"], rx, "STATE_ID", "NC-0123", "NC")
    details = directory.details(a["PHARMACIST"], rx)
    assert len(details["identifiers"]) == 4
    assert [x["number"] for x in details["identifiers"] if x["type"] == "DEA"] == ["AB 1234567", "AB-7654321"]
    assert len(directory.search(a["TECHNICIAN"], "AB1234567")) == 1
    assert len(directory.search(a["TECHNICIAN"], "Moore")) == 1


def test_subsequent_active_npi_is_uniquely_enforced(env):
    _, directory, actors, rx = env
    with pytest.raises(WorkflowError, match="conflicts with the existing provider identity"):
        directory.add_identifier(actors["PHARMACIST"], rx, "NPI", "9876543210")
    directory.add_identifier(actors["PHARMACIST"], rx, "NPI", "1234567893")
    with pytest.raises(WorkflowError, match="one active NPI"):
        directory.add_identifier(actors["PHARMACIST"], rx, "NPI", "9876543210")


def test_contacts_primary_per_kind_and_search(env):
    _, directory, a, rx = env
    first = directory.add_contact(a["TECHNICIAN"], rx, "PHONE", "919-555-0101", "Office", is_primary=True)
    second = directory.add_contact(a["TECHNICIAN"], rx, "PHONE", "919-555-0202", "Other", is_primary=True)
    directory.add_contact(a["TECHNICIAN"], rx, "FAX", "919-555-0999", is_primary=True)
    details = directory.details(a["TECHNICIAN"], rx)
    assert len(details["contacts"]) == 3
    assert sum(x["primary"] for x in details["contacts"] if x["kind"] == "PHONE") == 1
    assert next(x["id"] for x in details["contacts"] if x["primary"] and x["kind"] == "PHONE") == second
    assert directory.search(a["TECHNICIAN"], "5550202")[0]["id"] == rx
    assert directory.search(a["TECHNICIAN"], "5550999")[0]["id"] == rx


def test_multiple_addresses_and_primary_rotation(env):
    _, directory, a, rx = env
    directory.add_address(a["INTERN"], rx, "101 Main Street", "Durham", "NC", "27701", is_primary=True)
    second = directory.add_address(a["INTERN"], rx, "22 Elm Street", "Raleigh", "NC", "27601", is_primary=True)
    d = directory.details(a["INTERN"], rx)
    assert len(d["addresses"]) == 2
    assert next(x["id"] for x in d["addresses"] if x["primary"]) == second


def test_technician_cannot_modify_regulatory_identifiers(env):
    _, directory, a, rx = env
    with pytest.raises(AccessDenied):
        directory.add_identifier(a["TECHNICIAN"], rx, "DEA", "AB1234567")
    with pytest.raises(AccessDenied):
        directory.details(a["CASHIER"], rx)


def test_site_isolation_for_directory_writes_and_reads(env):
    pharmacy, directory, a, rx = env
    with pharmacy.sessions.begin() as session:
        site = Site(name="Synthetic Branch Pharmacy")
        session.add(site); session.flush()
        staff = Staff(site_id=site.id, name="Branch Pharmacist", role="PHARMACIST")
        session.add(staff); session.flush()
        other = Actor(staff.id, site.id, staff.role)
    with pytest.raises(WorkflowError):
        directory.add_identifier(other, rx, "NPI", "1234567893")
    with pytest.raises(WorkflowError):
        directory.add_contact(other, rx, "FAX", "9195557777")
    with pytest.raises(WorkflowError):
        directory.details(other, rx)
    assert not directory.search(other, "Moore")


def test_retired_identifiers_keep_auditable_history(env):
    pharmacy, directory, a, rx = env
    id = directory.add_identifier(a["PHARMACIST"], rx, "DEA", "AB1234567")
    directory.retire_identifier(a["PHARMACIST"], id, "Prescriber credential updated")
    assert not directory.details(a["PHARMACIST"], rx)["identifiers"][0]["active"]
    assert not directory.search(a["PHARMACIST"], "AB1234567")
    with pharmacy.sessions() as session:
        assert session.scalar(select(Audit).where(Audit.kind == "PROVIDER_IDENTIFIER_RETIRED")) is not None


def test_identifier_primary_replacement_maintains_one_primary(env):
    _, directory, a, rx = env
    first = directory.add_identifier(a["PHARMACIST"], rx, "DEA", "AA1111111", "NC", is_primary=True)
    second = directory.add_identifier(a["PHARMACIST"], rx, "DEA", "BB2222222", "NC", is_primary=True)
    ids = directory.details(a["PHARMACIST"], rx)["identifiers"]
    assert sum(x["primary"] for x in ids) == 1
    assert next(x["id"] for x in ids if x["primary"]) == second


def test_invalid_contacts_and_addresses_rejected(env):
    _, directory, a, rx = env
    with pytest.raises(WorkflowError):
        directory.add_contact(a["TECHNICIAN"], rx, "FAX", "bad number")
    with pytest.raises(WorkflowError):
        directory.add_address(a["TECHNICIAN"], rx, "", "Durham", "NC", "27701")
    with pytest.raises(WorkflowError):
        directory.add_identifier(a["PHARMACIST"], rx, "UNKNOWN", "12345")
