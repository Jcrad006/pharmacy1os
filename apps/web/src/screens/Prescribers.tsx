import { useEffect, useState, type FormEvent } from "react";
import { createPrescriber, getPrescribers } from "../api";
import type { DevUser, Prescriber } from "../types";
import { canWritePatients, formatPrescriberName } from "../workflow";

type DraftAddress = {
  label: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  isPrimary: boolean;
};

function emptyAddress(isPrimary = false): DraftAddress {
  return {
    label: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    isPrimary,
  };
}

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
  const [stateProviderId, setStateProviderId] = useState("");
  const [stateProviderIdState, setStateProviderIdState] = useState("");
  const [phone, setPhone] = useState("");
  const [fax, setFax] = useState("");
  const [addresses, setAddresses] = useState<DraftAddress[]>([]);

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

  function updateAddress(index: number, patch: Partial<DraftAddress>) {
    setAddresses((current) =>
      current.map((address, addressIndex) => {
        if (addressIndex !== index) {
          return patch.isPrimary ? { ...address, isPrimary: false } : address;
        }
        return { ...address, ...patch };
      }),
    );
  }

  function removeAddress(index: number) {
    setAddresses((current) => {
      const next = current.filter((_, addressIndex) => addressIndex !== index);
      if (next.length > 0 && !next.some((address) => address.isPrimary)) {
        next[0] = { ...next[0], isPrimary: true };
      }
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    onError(null);
    try {
      await createPrescriber(devUser, {
        firstName,
        lastName,
        dateOfBirth: dateOfBirth
          ? new Date(`${dateOfBirth}T00:00:00`).toISOString()
          : undefined,
        npi: npi || undefined,
        deaNumber: deaNumber || undefined,
        stateProviderId: stateProviderId || undefined,
        stateProviderIdState: stateProviderIdState || undefined,
        phone: phone || undefined,
        fax: fax || undefined,
        addresses: addresses.map((address) => ({
          label: address.label || undefined,
          addressLine1: address.addressLine1,
          addressLine2: address.addressLine2 || undefined,
          city: address.city,
          state: address.state,
          postalCode: address.postalCode,
          isPrimary: address.isPrimary,
        })),
      });
      setFirstName("");
      setLastName("");
      setDateOfBirth("");
      setNpi("");
      setDeaNumber("");
      setStateProviderId("");
      setStateProviderIdState("");
      setPhone("");
      setFax("");
      setAddresses([]);
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
          {results.map((provider) => {
            const primaryAddress =
              provider.addresses?.find((address) => address.isPrimary) ??
              provider.addresses?.[0];
            return (
              <article className="record-card provider-card" key={provider.id}>
                <strong>{formatPrescriberName(provider)}</strong>
                <span>DOB: {provider.dateOfBirth ? new Date(provider.dateOfBirth).toLocaleDateString() : "Not entered"}</span>
                <span>NPI: {provider.npi ?? "Not entered"}</span>
                <span>DEA: {provider.deaNumber ?? "Not entered"}</span>
                <span>
                  State Provider ID: {provider.stateProviderId ?? "Not entered"}
                  {provider.stateProviderIdState ? ` (${provider.stateProviderIdState})` : ""}
                </span>
                <span>Phone: {provider.phone ?? "Not entered"}</span>
                <span>Fax: {provider.fax ?? "Not entered"}</span>
                {primaryAddress && (
                  <span>
                    Primary address: {primaryAddress.addressLine1}
                    {primaryAddress.addressLine2 ? `, ${primaryAddress.addressLine2}` : ""},{" "}
                    {primaryAddress.city}, {primaryAddress.state} {primaryAddress.postalCode}
                  </span>
                )}
                {provider.addresses && provider.addresses.length > 1 && (
                  <span>{provider.addresses.length} stored addresses</span>
                )}
              </article>
            );
          })}
          {results.length === 0 && <p className="muted">No providers match those fields.</p>}
        </div>
      </section>

      <section className="panel provider-registration">
        <p className="eyebrow">Registration</p>
        <h2>New provider</h2>
        {!writable && <p className="permission-note">The selected role cannot register providers.</p>}
        <form className="stack-form" onSubmit={submit}>
          <label>Last name<input value={lastName} onChange={(e) => setLastName(e.target.value)} required disabled={!writable} /></label>
          <label>First name<input value={firstName} onChange={(e) => setFirstName(e.target.value)} required disabled={!writable} /></label>
          <label>Date of birth<input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} disabled={!writable} /></label>
          <label>NPI<input value={npi} onChange={(e) => setNpi(e.target.value)} disabled={!writable} /></label>
          <label>DEA number<input value={deaNumber} onChange={(e) => setDeaNumber(e.target.value)} disabled={!writable} /></label>
          <div className="provider-id-row">
            <label>State provider ID<input value={stateProviderId} onChange={(e) => setStateProviderId(e.target.value)} disabled={!writable} /></label>
            <label>Issuing state<input value={stateProviderIdState} maxLength={2} onChange={(e) => setStateProviderIdState(e.target.value.toUpperCase())} placeholder="NC" disabled={!writable} /></label>
          </div>
          <label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!writable} /></label>
          <label>Fax<input value={fax} onChange={(e) => setFax(e.target.value)} disabled={!writable} /></label>

          <div className="provider-address-heading">
            <div>
              <strong>Practice addresses</strong>
              <span>Store one or more provider locations.</span>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={!writable}
              onClick={() => setAddresses((current) => [...current, emptyAddress(current.length === 0)])}
            >
              Add address
            </button>
          </div>

          {addresses.map((address, index) => (
            <fieldset className="provider-address-block" key={index}>
              <legend>Address {index + 1}</legend>
              <label>Label<input value={address.label} onChange={(e) => updateAddress(index, { label: e.target.value })} placeholder="Main office" disabled={!writable} /></label>
              <label>Street address<input value={address.addressLine1} onChange={(e) => updateAddress(index, { addressLine1: e.target.value })} required disabled={!writable} /></label>
              <label>Address line 2<input value={address.addressLine2} onChange={(e) => updateAddress(index, { addressLine2: e.target.value })} placeholder="Suite / floor" disabled={!writable} /></label>
              <div className="provider-address-city-row">
                <label>City<input value={address.city} onChange={(e) => updateAddress(index, { city: e.target.value })} required disabled={!writable} /></label>
                <label>State<input value={address.state} maxLength={2} onChange={(e) => updateAddress(index, { state: e.target.value.toUpperCase() })} required disabled={!writable} /></label>
                <label>ZIP / postal code<input value={address.postalCode} onChange={(e) => updateAddress(index, { postalCode: e.target.value })} required disabled={!writable} /></label>
              </div>
              <div className="provider-address-actions">
                <label className="checkbox-label">
                  <input type="checkbox" checked={address.isPrimary} onChange={(e) => updateAddress(index, { isPrimary: e.target.checked })} disabled={!writable} />
                  Primary address
                </label>
                <button className="secondary-button" type="button" onClick={() => removeAddress(index)} disabled={!writable}>Remove</button>
              </div>
            </fieldset>
          ))}

          <button className="primary-button" type="submit" disabled={!writable || loading}>Register synthetic provider</button>
        </form>
      </section>
    </div>
  );
}
