import { useMemo, useState, type FormEvent } from "react";
import { createPrescriber } from "../api";
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
  const [query, setQuery] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [npi, setNpi] = useState("");
  const [deaNumber, setDeaNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [fax, setFax] = useState("");

  const filtered = useMemo(() => {
    const needle = query.toLowerCase().trim();
    if (!needle) return prescribers;
    return prescribers.filter((prescriber) =>
      [prescriber.firstName, prescriber.lastName, prescriber.npi ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [prescribers, query]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    onError(null);
    try {
      await createPrescriber(devUser, {
        firstName,
        lastName,
        npi: npi || undefined,
        deaNumber: deaNumber || undefined,
        phone: phone || undefined,
        fax: fax || undefined,
      });
      setFirstName("");
      setLastName("");
      setNpi("");
      setDeaNumber("");
      setPhone("");
      setFax("");
      await onCreated();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create prescriber.");
    } finally {
      setLoading(false);
    }
  }

  const writable = canWritePatients(user);

  return (
    <div className="split-layout">
      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Synthetic directory</p><h2>Prescribers</h2></div>
          <input className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search prescribers" />
        </div>
        <div className="record-list">
          {filtered.map((prescriber) => (
            <article className="record-card" key={prescriber.id}>
              <strong>{formatPrescriberName(prescriber)}</strong>
              <span>NPI: {prescriber.npi ?? "Not entered"}</span>
              <span>{prescriber.phone ?? "No phone"}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Registration</p>
        <h2>New prescriber</h2>
        {!writable && <p className="permission-note">The selected role cannot register prescribers.</p>}
        <form className="stack-form" onSubmit={submit}>
          <label>First name<input value={firstName} onChange={(event) => setFirstName(event.target.value)} required disabled={!writable} /></label>
          <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} required disabled={!writable} /></label>
          <label>NPI<input value={npi} onChange={(event) => setNpi(event.target.value)} disabled={!writable} /></label>
          <label>DEA number<input value={deaNumber} onChange={(event) => setDeaNumber(event.target.value)} disabled={!writable} /></label>
          <label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} disabled={!writable} /></label>
          <label>Fax<input value={fax} onChange={(event) => setFax(event.target.value)} disabled={!writable} /></label>
          <button className="primary-button" type="submit" disabled={!writable || loading}>Register synthetic prescriber</button>
        </form>
      </section>
    </div>
  );
}
