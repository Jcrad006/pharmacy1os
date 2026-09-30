import { useEffect, useState, type FormEvent } from "react";
import { createPrescriber, getPrescribers } from "../api";
import type { DevUser, Prescriber } from "../types";
import { canWritePatients, formatPrescriberName } from "../workflow";

export function Prescribers({
  prescribers,
  devUser,
  user,
  loading,
  setLoading,
  onError,
  onCreated,
}: {
  prescribers: Prescriber[];
  devUser: string;
  user?: DevUser;
  loading: boolean;
  setLoading: (value: boolean) => void;
  onError: (message: string | null) => void;
  onCreated: () => Promise<void>;
}) {
  const [results, setResults] = useState(prescribers);
  const [searchLastName, setSearchLastName] = useState("");
  const [searchFirstName, setSearchFirstName] = useState("");
  const [searchDob, setSearchDob] = useState("");
  const [searchPhone, setSearchPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [npi, setNpi] = useState("");
  const [deaNumber, setDeaNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [fax, setFax] = useState("");

  useEffect(() => {
    if (!searchLastName && !searchFirstName && !searchDob && !searchPhone) {
      setResults(prescribers);
    }
  }, [prescribers, searchLastName, searchFirstName, searchDob, searchPhone]);

  async function search(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true);
    onError(null);
    try {
      setResults(
        await getPrescribers(devUser, {
          lastName: searchLastName,
          firstName: searchFirstName,
          dateOfBirth: searchDob,
          phone: searchPhone,
        }),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to search providers.");
    } finally {
      setLoading(false);
    }
  }

  function clearSearch() {
    setSearchLastName("");
    setSearchFirstName("");
    setSearchDob("");
    setSearchPhone("");
    setResults(prescribers);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    onError(null);
    try {
      await createPrescriber(devUser, {
        firstName,
        lastName,
        dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00`).toISOString() : undefined,
        npi: npi || undefined,
        deaNumber: deaNumber || undefined,
        phone: phone || undefined,
        fax: fax || undefined,
      });
      setFirstName("");
      setLastName("");
      setDateOfBirth("");
      setNpi("");
      setDeaNumber("");
      setPhone("");
      setFax("");
      await onCreated();
      await search();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create provider.");
    } finally {
      setLoading(false);
    }
  }

  const writable = canWritePatients(user);

  return (
    <div className="split-layout directory-layout">
      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Provider directory</p><h2>Providers</h2></div>
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
          {results.map((prescriber) => (
            <article className="record-card" key={prescriber.id}>
              <strong>{formatPrescriberName(prescriber)}</strong>
              <span>DOB: {prescriber.dateOfBirth ? new Date(prescriber.dateOfBirth).toLocaleDateString() : "Not entered"}</span>
              <span>Phone: {prescriber.phone ?? "Not entered"}</span>
              <span>NPI: {prescriber.npi ?? "Not entered"}</span>
            </article>
          ))}
          {results.length === 0 && <p className="empty-state">No providers match those search fields.</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Registration</p>
        <h2>New provider</h2>
        {!writable && <p className="permission-note">The selected role cannot register providers.</p>}
        <form className="stack-form" onSubmit={submit}>
          <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} required disabled={!writable} /></label>
          <label>First name<input value={firstName} onChange={(event) => setFirstName(event.target.value)} required disabled={!writable} /></label>
          <label>Date of birth<input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} disabled={!writable} /></label>
          <label>NPI<input value={npi} onChange={(event) => setNpi(event.target.value)} disabled={!writable} /></label>
          <label>DEA number<input value={deaNumber} onChange={(event) => setDeaNumber(event.target.value)} disabled={!writable} /></label>
          <label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} disabled={!writable} /></label>
          <label>Fax<input value={fax} onChange={(event) => setFax(event.target.value)} disabled={!writable} /></label>
          <button className="primary-button" type="submit" disabled={!writable || loading}>Register synthetic provider</button>
        </form>
      </section>
    </div>
  );
}
