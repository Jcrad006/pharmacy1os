import { useEffect, useState, type FormEvent } from "react";
import { createPatient, getPatients } from "../api";
import type { DevUser, Patient } from "../types";
import { canWritePatients, formatPatientName } from "../workflow";

export function Patients({
  patients,
  devUser,
  user,
  loading,
  setLoading,
  onError,
  onCreated,
}: {
  patients: Patient[];
  devUser: string;
  user?: DevUser;
  loading: boolean;
  setLoading: (value: boolean) => void;
  onError: (message: string | null) => void;
  onCreated: () => Promise<void>;
}) {
  const [results, setResults] = useState(patients);
  const [searchLastName, setSearchLastName] = useState("");
  const [searchFirstName, setSearchFirstName] = useState("");
  const [searchDob, setSearchDob] = useState("");
  const [searchPhone, setSearchPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!searchLastName && !searchFirstName && !searchDob && !searchPhone) {
      setResults(patients);
    }
  }, [patients, searchLastName, searchFirstName, searchDob, searchPhone]);

  async function search(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true);
    onError(null);
    try {
      setResults(
        await getPatients(devUser, {
          lastName: searchLastName,
          firstName: searchFirstName,
          dateOfBirth: searchDob,
          phone: searchPhone,
        }),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to search patients.");
    } finally {
      setLoading(false);
    }
  }

  function clearSearch() {
    setSearchLastName("");
    setSearchFirstName("");
    setSearchDob("");
    setSearchPhone("");
    setResults(patients);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    onError(null);
    try {
      await createPatient(devUser, {
        firstName,
        lastName,
        dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00`).toISOString() : undefined,
        phone: phone || undefined,
        email: email || undefined,
      });
      setFirstName("");
      setLastName("");
      setDateOfBirth("");
      setPhone("");
      setEmail("");
      await onCreated();
      await search();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create patient.");
    } finally {
      setLoading(false);
    }
  }

  const writable = canWritePatients(user);

  return (
    <div className="split-layout directory-layout">
      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Patient directory</p><h2>Patients</h2></div>
          <span className="queue-count">{results.length} result{results.length === 1 ? "" : "s"}</span>
        </div>

        <form className="directory-search" onSubmit={search}>
          <label>Last name<input autoFocus value={searchLastName} onChange={(event) => setSearchLastName(event.target.value)} placeholder="Smith" /></label>
          <label>First name<input value={searchFirstName} onChange={(event) => setSearchFirstName(event.target.value)} placeholder="Jane" /></label>
          <label>Date of birth<input type="date" value={searchDob} onChange={(event) => setSearchDob(event.target.value)} /></label>
          <label>Phone<input value={searchPhone} onChange={(event) => setSearchPhone(event.target.value)} placeholder="3365551212" /></label>
          <div className="directory-search-actions">
            <button className="primary-button" type="submit" disabled={loading}>Search</button>
            <button className="secondary-button" type="button" onClick={clearSearch}>Clear</button>
          </div>
        </form>

        <div className="record-list">
          {results.map((patient) => (
            <article className="record-card" key={patient.id}>
              <strong>{formatPatientName(patient)}</strong>
              <span>DOB: {patient.dateOfBirth ? new Date(patient.dateOfBirth).toLocaleDateString() : "Not entered"}</span>
              <span>Phone: {patient.phone ?? "Not entered"}</span>
            </article>
          ))}
          {results.length === 0 && <p className="empty-state">No patients match those search fields.</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Registration</p>
        <h2>New patient</h2>
        {!writable && <p className="permission-note">The selected role cannot register patients.</p>}
        <form className="stack-form" onSubmit={submit}>
          <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} required disabled={!writable} /></label>
          <label>First name<input value={firstName} onChange={(event) => setFirstName(event.target.value)} required disabled={!writable} /></label>
          <label>Date of birth<input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} disabled={!writable} /></label>
          <label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} disabled={!writable} /></label>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!writable} /></label>
          <button className="primary-button" type="submit" disabled={!writable || loading}>Register synthetic patient</button>
        </form>
      </section>
    </div>
  );
}
