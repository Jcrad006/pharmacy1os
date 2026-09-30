import { useEffect, useState, type FormEvent } from "react";
import { createPrescriber, getPrescribers } from "../api";
import type {
  DevUser,
  Prescriber,
  PrescriberContactType,
  PrescriberIdentifierType,
} from "../types";
import {
  canWritePatients,
  formatPrescriberName,
  primaryProviderContact,
  primaryProviderIdentifier,
} from "../workflow";

type IdentifierDraft = {
  number: string;
  jurisdiction: string;
  isPrimary: boolean;
};

type ContactDraft = {
  label: string;
  value: string;
  extension: string;
  isPrimary: boolean;
};

type AddressDraft = {
  label: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  isPrimary: boolean;
};

function newIdentifier(): IdentifierDraft {
  return { number: "", jurisdiction: "", isPrimary: false };
}

function newContact(): ContactDraft {
  return { label: "", value: "", extension: "", isPrimary: false };
}

function newAddress(): AddressDraft {
  return {
    label: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    isPrimary: false,
  };
}

function updatePrimaryArray<T extends { isPrimary: boolean }>(
  items: T[],
  index: number,
  patch: Partial<T>,
): T[] {
  return items.map((item, itemIndex) => {
    if (itemIndex === index) return { ...item, ...patch };
    return patch.isPrimary ? { ...item, isPrimary: false } : item;
  });
}

function removeAndRepairPrimary<T extends { isPrimary: boolean }>(
  items: T[],
  index: number,
): T[] {
  const next = items.filter((_, itemIndex) => itemIndex !== index);
  if (next.length > 0 && !next.some((item) => item.isPrimary)) {
    next[0] = { ...next[0]!, isPrimary: true };
  }
  return next;
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
  const [practiceLevel, setPracticeLevel] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [npi, setNpi] = useState("");
  const [deaNumbers, setDeaNumbers] = useState<IdentifierDraft[]>([]);
  const [stateIds, setStateIds] = useState<IdentifierDraft[]>([]);
  const [phones, setPhones] = useState<ContactDraft[]>([]);
  const [faxes, setFaxes] = useState<ContactDraft[]>([]);
  const [addresses, setAddresses] = useState<AddressDraft[]>([]);

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

  function identifierInputs(
    items: IdentifierDraft[],
    setItems: (items: IdentifierDraft[]) => void,
    type: PrescriberIdentifierType,
  ) {
    return items.map((item, index) => (
      <fieldset className="provider-subrecord" key={index}>
        <legend>{type === "DEA" ? "DEA" : "State Provider ID"} {index + 1}</legend>
        <label>
          Number
          <input
            value={item.number}
            onChange={(event) =>
              setItems(updatePrimaryArray(items, index, { number: event.target.value }))
            }
            required
          />
        </label>
        <label>
          {type === "DEA" ? "State / jurisdiction" : "Issuing state"}
          <input
            value={item.jurisdiction}
            maxLength={2}
            onChange={(event) =>
              setItems(
                updatePrimaryArray(items, index, {
                  jurisdiction: event.target.value.toUpperCase(),
                }),
              )
            }
            placeholder="NC"
            required={type === "STATE_ID"}
          />
        </label>
        <div className="provider-subrecord-actions">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={item.isPrimary}
              onChange={(event) =>
                setItems(
                  updatePrimaryArray(items, index, {
                    isPrimary: event.target.checked,
                  }),
                )
              }
            />
            Primary {type === "DEA" ? "DEA" : "state ID"}
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setItems(removeAndRepairPrimary(items, index))}
          >
            Remove
          </button>
        </div>
      </fieldset>
    ));
  }

  function contactInputs(
    items: ContactDraft[],
    setItems: (items: ContactDraft[]) => void,
    type: PrescriberContactType,
  ) {
    return items.map((item, index) => (
      <fieldset className="provider-subrecord" key={index}>
        <legend>{type === "PHONE" ? "Phone" : "Fax"} {index + 1}</legend>
        <label>
          Label
          <input
            value={item.label}
            onChange={(event) =>
              setItems(updatePrimaryArray(items, index, { label: event.target.value }))
            }
            placeholder={type === "PHONE" ? "Main office / direct / mobile" : "Main fax"}
          />
        </label>
        <label>
          Number
          <input
            value={item.value}
            onChange={(event) =>
              setItems(updatePrimaryArray(items, index, { value: event.target.value }))
            }
            required
          />
        </label>
        {type === "PHONE" && (
          <label>
            Extension
            <input
              value={item.extension}
              onChange={(event) =>
                setItems(
                  updatePrimaryArray(items, index, { extension: event.target.value }),
                )
              }
            />
          </label>
        )}
        <div className="provider-subrecord-actions">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={item.isPrimary}
              onChange={(event) =>
                setItems(
                  updatePrimaryArray(items, index, {
                    isPrimary: event.target.checked,
                  }),
                )
              }
            />
            Primary {type === "PHONE" ? "phone" : "fax"}
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setItems(removeAndRepairPrimary(items, index))}
          >
            Remove
          </button>
        </div>
      </fieldset>
    ));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    onError(null);
    try {
      const identifiers = [
        ...(npi.trim()
          ? [
              {
                type: "NPI" as const,
                number: npi.trim(),
                isPrimary: true,
              },
            ]
          : []),
        ...deaNumbers
          .filter((item) => item.number.trim())
          .map((item) => ({
            type: "DEA" as const,
            number: item.number.trim(),
            jurisdiction: item.jurisdiction.trim() || undefined,
            isPrimary: item.isPrimary,
          })),
        ...stateIds
          .filter((item) => item.number.trim())
          .map((item) => ({
            type: "STATE_ID" as const,
            number: item.number.trim(),
            jurisdiction: item.jurisdiction.trim(),
            isPrimary: item.isPrimary,
          })),
      ];

      const contacts = [
        ...phones
          .filter((item) => item.value.trim())
          .map((item) => ({
            type: "PHONE" as const,
            label: item.label.trim() || undefined,
            value: item.value.trim(),
            extension: item.extension.trim() || undefined,
            isPrimary: item.isPrimary,
          })),
        ...faxes
          .filter((item) => item.value.trim())
          .map((item) => ({
            type: "FAX" as const,
            label: item.label.trim() || undefined,
            value: item.value.trim(),
            isPrimary: item.isPrimary,
          })),
      ];

      await createPrescriber(devUser, {
        firstName,
        lastName,
        practiceLevel,
        dateOfBirth: dateOfBirth
          ? new Date(`${dateOfBirth}T00:00:00`).toISOString()
          : undefined,
        identifiers,
        contacts,
        addresses: addresses
          .filter((item) =>
            [item.addressLine1, item.city, item.state, item.postalCode].some((value) =>
              value.trim(),
            ),
          )
          .map((item) => ({
            label: item.label.trim() || undefined,
            addressLine1: item.addressLine1.trim(),
            addressLine2: item.addressLine2.trim() || undefined,
            city: item.city.trim(),
            state: item.state.trim(),
            postalCode: item.postalCode.trim(),
            isPrimary: item.isPrimary,
          })),
      });

      setFirstName("");
      setLastName("");
      setPracticeLevel("");
      setDateOfBirth("");
      setNpi("");
      setDeaNumbers([]);
      setStateIds([]);
      setPhones([]);
      setFaxes([]);
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
    <div className="split-layout provider-directory-layout">
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

        <div className="record-list provider-record-list">
          {results.map((provider) => {
            const npiValue = primaryProviderIdentifier(provider, "NPI");
            const dea = primaryProviderIdentifier(provider, "DEA");
            const stateId = primaryProviderIdentifier(provider, "STATE_ID");
            const phone = primaryProviderContact(provider, "PHONE");
            const fax = primaryProviderContact(provider, "FAX");
            const address =
              provider.addresses.find((item) => item.isPrimary) ?? provider.addresses[0];

            return (
              <article className="record-card provider-card" key={provider.id}>
                <strong>{formatPrescriberName(provider)}</strong>
                <span>NPI: {npiValue?.number ?? "Not entered"}</span>
                <span>DEA: {dea ? `${dea.number}${dea.jurisdiction ? ` (${dea.jurisdiction})` : ""}` : "Not entered"}</span>
                <span>State ID: {stateId ? `${stateId.number} (${stateId.jurisdiction})` : "Not entered"}</span>
                <span>Primary phone: {phone?.value ?? "Not entered"}{phone?.extension ? ` ext ${phone.extension}` : ""}</span>
                <span>Primary fax: {fax?.value ?? "Not entered"}</span>
                <span>{provider.contacts.filter((item) => item.type === "PHONE").length} phone(s) · {provider.contacts.filter((item) => item.type === "FAX").length} fax(es) · {provider.addresses.length} address(es)</span>
                {address && <span>Primary location: {address.addressLine1}, {address.city}, {address.state} {address.postalCode}</span>}
              </article>
            );
          })}
          {results.length === 0 && <p className="muted">No providers match those fields.</p>}
        </div>
      </section>

      <section className="panel provider-registration">
        <p className="eyebrow">Provider identity</p>
        <h2>New provider</h2>
        {!writable && <p className="permission-note">The selected role cannot register providers.</p>}
        <form className="stack-form" onSubmit={submit}>
          <label>Last name<input value={lastName} onChange={(e) => setLastName(e.target.value)} required disabled={!writable} /></label>
          <label>First name<input value={firstName} onChange={(e) => setFirstName(e.target.value)} required disabled={!writable} /></label>
          <label>
            Practice level / credential
            <input
              list="provider-practice-levels"
              value={practiceLevel}
              onChange={(e) => setPracticeLevel(e.target.value.toUpperCase())}
              placeholder="MD, DO, NP, PA, DDS..."
              required
              disabled={!writable}
            />
            <datalist id="provider-practice-levels">
              <option value="MD" />
              <option value="DO" />
              <option value="NP" />
              <option value="PA" />
              <option value="DDS" />
              <option value="DMD" />
              <option value="DPM" />
              <option value="CNM" />
              <option value="OD" />
            </datalist>
          </label>
          <label>Date of birth<input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} disabled={!writable} /></label>

          <div className="provider-section-heading"><strong>Identifiers</strong><span>Identifiers belong to this provider identity.</span></div>
          <label>NPI<input value={npi} onChange={(e) => setNpi(e.target.value)} disabled={!writable} /></label>

          <div className="provider-add-row">
            <strong>DEA registrations</strong>
            <button type="button" className="secondary-button" onClick={() => setDeaNumbers((items) => [...items, { ...newIdentifier(), isPrimary: items.length === 0 }])} disabled={!writable}>Add DEA</button>
          </div>
          {identifierInputs(deaNumbers, setDeaNumbers, "DEA")}

          <div className="provider-add-row">
            <strong>State Provider IDs</strong>
            <button type="button" className="secondary-button" onClick={() => setStateIds((items) => [...items, { ...newIdentifier(), isPrimary: items.length === 0 }])} disabled={!writable}>Add State ID</button>
          </div>
          {identifierInputs(stateIds, setStateIds, "STATE_ID")}

          <div className="provider-section-heading"><strong>Contacts</strong><span>Store as many phone and fax numbers as needed.</span></div>
          <div className="provider-add-row">
            <strong>Phone numbers</strong>
            <button type="button" className="secondary-button" onClick={() => setPhones((items) => [...items, { ...newContact(), isPrimary: items.length === 0 }])} disabled={!writable}>Add phone</button>
          </div>
          {contactInputs(phones, setPhones, "PHONE")}

          <div className="provider-add-row">
            <strong>Fax numbers</strong>
            <button type="button" className="secondary-button" onClick={() => setFaxes((items) => [...items, { ...newContact(), isPrimary: items.length === 0 }])} disabled={!writable}>Add fax</button>
          </div>
          {contactInputs(faxes, setFaxes, "FAX")}

          <div className="provider-section-heading"><strong>Practice locations</strong><span>Multiple offices can be attached to the same provider.</span></div>
          <div className="provider-add-row">
            <strong>Addresses</strong>
            <button type="button" className="secondary-button" onClick={() => setAddresses((items) => [...items, { ...newAddress(), isPrimary: items.length === 0 }])} disabled={!writable}>Add address</button>
          </div>
          {addresses.map((item, index) => (
            <fieldset className="provider-subrecord" key={index}>
              <legend>Address {index + 1}</legend>
              <label>Label<input value={item.label} onChange={(e) => setAddresses(updatePrimaryArray(addresses, index, { label: e.target.value }))} placeholder="Main clinic" /></label>
              <label>Street address<input value={item.addressLine1} onChange={(e) => setAddresses(updatePrimaryArray(addresses, index, { addressLine1: e.target.value }))} required /></label>
              <label>Address line 2<input value={item.addressLine2} onChange={(e) => setAddresses(updatePrimaryArray(addresses, index, { addressLine2: e.target.value }))} /></label>
              <div className="provider-address-city-row">
                <label>City<input value={item.city} onChange={(e) => setAddresses(updatePrimaryArray(addresses, index, { city: e.target.value }))} required /></label>
                <label>State<input value={item.state} maxLength={2} onChange={(e) => setAddresses(updatePrimaryArray(addresses, index, { state: e.target.value.toUpperCase() }))} required /></label>
                <label>ZIP / postal code<input value={item.postalCode} onChange={(e) => setAddresses(updatePrimaryArray(addresses, index, { postalCode: e.target.value }))} required /></label>
              </div>
              <div className="provider-subrecord-actions">
                <label className="checkbox-label">
                  <input type="checkbox" checked={item.isPrimary} onChange={(e) => setAddresses(updatePrimaryArray(addresses, index, { isPrimary: e.target.checked }))} />
                  Primary address
                </label>
                <button type="button" className="secondary-button" onClick={() => setAddresses(removeAndRepairPrimary(addresses, index))}>Remove</button>
              </div>
            </fieldset>
          ))}

          <button className="primary-button" type="submit" disabled={!writable || loading}>Register synthetic provider</button>
        </form>
      </section>
    </div>
  );
}
