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
  const [searching, setSearching] = useState(false);
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
    setSearching(true);
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
      onError(error instanceof Error ? error.message : "Provider search failed.");
    } finally {
      setSearching(false);
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
    <div className="split-layout">
      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Provider directory</p><h2>Providers</h2></div>
          <span className="queue-count">{searching ? "Searching…" : `${results.length} shown`}</span>
        </div>

        <form className="directory-structured-search" onSubmit={search}>
          <label>Last name<input autoFocus value={searchLastName} onChange={(e) => setSearchLastName(e.target.value)} placeholder="Smith" /></label>
          <label>First name<input value={searchFirstName} onChange={(e) => setSearchFirstName(e.target.value)} placeholder="Jane" /></label>
          <label>Date of birth<input type="date" value={searchDob} onChange={(e) => setSearchDob(e.target.value)} /></label>
          <label>Phone<input value={searchPhone} onChange={(e) => setSearchPhone(e.target.value)} placeholder="3365551212" /></label>
          <div className="directory-search-actions">
            <button className="primary-button" type="submit" disabled={searching}>Search</button>
            <button className="secondary-button" type="button" onClick={clearSearch}>Clear</button>
          </div>
        </form>

        <p className="directory-help">
          Results are sorted Last name, First name. Phone search ignores punctuation.
        </p>

        <div className="record-list">
          {results.map((provider) => (
            <article className="record-card" key={provider.id}>
              <strong>{formatPrescriberName(provider)}</strong>
              <span>DOB: {provider.dateOfBirth ? new Date(provider.dateOfBirth).toLocaleDateString() : "Not entered"}</span>
              <span>Phone: {provider.phone ?? "Not entered"}</span>
              <span>NPI: {provider.npi ?? "Not entered"}</span>
            </article>
          ))}
          {results.length === 0 && <p className="muted">No providers match those fields.</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Registration</p>
        <h2>New provider</h2>
        {!writable && <p className="permission-note">The selected role cannot register providers.</p>}
        <form className="stack-form" onSubmit={submit}>
          <label>Last name<input value={lastName} onChange={(e) => setLastName(e.target.value)} required disabled={!writable} /></label>
          <label>First name<input value={firstName} onChange={(e) => setFirstName(e.target.value)} required disabled={!writable} /></label>
          <label>Date of birth<input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} disabled={!writable} /></label>
          <label>NPI<input value={npi} onChange={(e) => setNpi(e.target.value)} disabled={!writable} /></label>
          <label>DEA number<input value={deaNumber} onChange={(e) => setDeaNumber(e.target.value)} disabled={!writable} /></label>
          <label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!writable} /></label>
          <label>Fax<input value={fax} onChange={(e) => setFax(e.target.value)} disabled={!writable} /></label>
          <button className="primary-button" type="submit" disabled={!writable || loading}>Register synthetic provider</button>
        </form>
      </section>
    </div>
  );
}
