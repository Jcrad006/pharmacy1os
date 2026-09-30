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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(patients);
  const [searching, setSearching] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!query.trim()) {
      setResults(patients);
      return;
    }

    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await getPatients(devUser, query));
      } catch (error) {
        onError(error instanceof Error ? error.message : "Patient search failed.");
      } finally {
        setSearching(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [query, devUser, patients]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    onError(null);
    try {
      await createPatient(devUser, {
        firstName,
        lastName,
        dateOfBirth: dateOfBirth
          ? new Date(`${dateOfBirth}T00:00:00`).toISOString()
          : undefined,
        phone: phone || undefined,
        email: email || undefined,
      });
      setFirstName("");
      setLastName("");
      setDateOfBirth("");
      setPhone("");
      setEmail("");
      await onCreated();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create patient.");
    } finally {
      setLoading(false);
    }
  }

  const writable = canWritePatients(user);

  return (
    <div className="split-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Synthetic directory</p>
            <h2>Patients</h2>
          </div>
          <div className="directory-search-wrap">
            <input
              className="search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name or phone"
            />
            <span>{searching ? "Searching…" : `${results.length} shown`}</span>
          </div>
        </div>
        <p className="directory-help">
          Search is performed against the pharmacy database, not only the records already loaded in this screen.
        </p>
        <div className="record-list">
          {results.map((patient) => (
            <article className="record-card" key={patient.id}>
              <strong>{formatPatientName(patient)}</strong>
              <span>
                {patient.dateOfBirth
                  ? new Date(patient.dateOfBirth).toLocaleDateString()
                  : "DOB not entered"}
              </span>
              <span>{patient.phone ?? "No phone"}</span>
            </article>
          ))}
          {results.length === 0 && (
            <p className="muted">No patients match this search.</p>
          )}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Registration</p>
        <h2>New patient</h2>
        {!writable && (
          <p className="permission-note">
            The selected role cannot register patients.
          </p>
        )}
        <form className="stack-form" onSubmit={submit}>
          <label>
            First name
            <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required disabled={!writable} />
          </label>
          <label>
            Last name
            <input value={lastName} onChange={(event) => setLastName(event.target.value)} required disabled={!writable} />
          </label>
          <label>
            Date of birth
            <input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} disabled={!writable} />
          </label>
          <label>
            Phone
            <input value={phone} onChange={(event) => setPhone(event.target.value)} disabled={!writable} />
          </label>
          <label>
            Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!writable} />
          </label>
          <button className="primary-button" type="submit" disabled={!writable || loading}>
            Register synthetic patient
          </button>
        </form>
      </section>
    </div>
  );
}
