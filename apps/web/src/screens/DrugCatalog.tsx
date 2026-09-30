import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createMedication,
  createProduct,
  createProductLot,
  getMedications,
} from "../api";
import type { DevUser, Medication, Product } from "../types";
import { canWriteInventory } from "../workflow";

function medicationLabel(medication: Medication) {
  return [
    medication.genericName,
    medication.strength,
    medication.dosageForm,
    medication.route,
  ]
    .filter(Boolean)
    .join(" · ");
}

function productLabel(product: Product, medication?: Medication) {
  const medicationPart = medication
    ? `${medication.genericName} ${medication.strength}`
    : "Product";
  return `${medicationPart} · ${product.manufacturer.name} · ${product.ndc}`;
}

export function DrugCatalog({
  devUser,
  user,
  onError,
}: {
  devUser: string;
  user?: DevUser;
  onError: (message: string | null) => void;
}) {
  const [medications, setMedications] = useState<Medication[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const [genericName, setGenericName] = useState("");
  const [brandName, setBrandName] = useState("");
  const [strength, setStrength] = useState("");
  const [dosageForm, setDosageForm] = useState("");
  const [route, setRoute] = useState("");

  const [selectedMedicationId, setSelectedMedicationId] = useState("");
  const [ndc, setNdc] = useState("");
  const [manufacturerName, setManufacturerName] = useState("");
  const [manufacturerLabelerCode, setManufacturerLabelerCode] = useState("");
  const [labelName, setLabelName] = useState("");
  const [packageDescription, setPackageDescription] = useState("");

  const [selectedProductId, setSelectedProductId] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [receivedAt, setReceivedAt] = useState("");

  const writable = canWriteInventory(user);

  const products = useMemo(
    () =>
      medications.flatMap((medication) =>
        medication.products.map((product) => ({
          medication,
          product,
        })),
      ),
    [medications],
  );

  async function load(search = query) {
    if (!devUser) return;
    setLoading(true);
    onError(null);
    try {
      const next = await getMedications(devUser, search);
      setMedications(next);

      if (
        selectedMedicationId &&
        !next.some((medication) => medication.id === selectedMedicationId)
      ) {
        setSelectedMedicationId("");
      }

      if (
        selectedProductId &&
        !next.some((medication) =>
          medication.products.some((product) => product.id === selectedProductId),
        )
      ) {
        setSelectedProductId("");
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to load drug catalog.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load("");
  }, [devUser]);

  async function search(event: FormEvent) {
    event.preventDefault();
    await load(query);
  }

  async function addMedication(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    onError(null);

    try {
      const result = await createMedication(devUser, {
        genericName,
        brandName: brandName || undefined,
        strength,
        dosageForm,
        route: route || undefined,
      });

      setGenericName("");
      setBrandName("");
      setStrength("");
      setDosageForm("");
      setRoute("");
      setSelectedMedicationId(result.medication.id);
      setQuery("");
      await load("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create drug.");
      setLoading(false);
    }
  }

  async function addProduct(event: FormEvent) {
    event.preventDefault();
    if (!selectedMedicationId) return;

    setLoading(true);
    onError(null);

    try {
      const result = await createProduct(devUser, selectedMedicationId, {
        ndc,
        manufacturerName,
        manufacturerLabelerCode: manufacturerLabelerCode || undefined,
        labelName: labelName || undefined,
        packageDescription: packageDescription || undefined,
      });

      setNdc("");
      setManufacturerName("");
      setManufacturerLabelerCode("");
      setLabelName("");
      setPackageDescription("");
      setSelectedProductId(result.product.id);
      setQuery("");
      await load("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create product.");
      setLoading(false);
    }
  }

  async function addLot(event: FormEvent) {
    event.preventDefault();
    if (!selectedProductId) return;

    setLoading(true);
    onError(null);

    try {
      await createProductLot(devUser, selectedProductId, {
        lotNumber,
        expirationDate: new Date(`${expirationDate}T00:00:00Z`).toISOString(),
        receivedAt: receivedAt
          ? new Date(`${receivedAt}T00:00:00Z`).toISOString()
          : undefined,
      });

      setLotNumber("");
      setExpirationDate("");
      setReceivedAt("");
      setQuery("");
      await load("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to record lot.");
      setLoading(false);
    }
  }

  return (
    <div className="catalog-layout">
      <section className="panel catalog-browser">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Drug / product master</p>
            <h2>Catalog</h2>
          </div>
          <span className="queue-count">
            {loading ? "Loading…" : `${medications.length} drug${medications.length === 1 ? "" : "s"}`}
          </span>
        </div>

        <form className="catalog-search" onSubmit={search}>
          <input
            autoFocus
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Drug, brand, manufacturer, NDC, or lot number"
          />
          <button className="primary-button" type="submit" disabled={loading}>
            Search
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => {
              setQuery("");
              void load("");
            }}
          >
            Clear
          </button>
        </form>

        <p className="catalog-help">
          NDC search ignores punctuation. Lot-number search is normalized while the original
          lot number is preserved for display.
        </p>

        <div className="catalog-medication-list">
          {medications.map((medication) => (
            <article className="catalog-medication-card" key={medication.id}>
              <div className="catalog-medication-heading">
                <div>
                  <strong>{medication.genericName} {medication.strength}</strong>
                  <span>
                    {medication.dosageForm}
                    {medication.route ? ` · ${medication.route}` : ""}
                    {medication.brandName ? ` · Brand: ${medication.brandName}` : ""}
                  </span>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!writable}
                  onClick={() => setSelectedMedicationId(medication.id)}
                >
                  Add product
                </button>
              </div>

              {medication.products.length === 0 ? (
                <p className="muted">No manufacturer/NDC products stored yet.</p>
              ) : (
                <div className="catalog-product-list">
                  {medication.products.map((product) => (
                    <div className="catalog-product-card" key={product.id}>
                      <div className="catalog-product-heading">
                        <div>
                          <strong>{product.manufacturer.name}</strong>
                          <span className="mono">NDC {product.ndc}</span>
                          {product.labelName && <span>{product.labelName}</span>}
                          {product.packageDescription && (
                            <span>{product.packageDescription}</span>
                          )}
                        </div>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={!writable}
                          onClick={() => setSelectedProductId(product.id)}
                        >
                          Add lot
                        </button>
                      </div>

                      {product.lots.length === 0 ? (
                        <p className="muted">No lots stored for this NDC at this site.</p>
                      ) : (
                        <div className="table-wrap catalog-lot-table">
                          <table className="compact-table">
                            <thead>
                              <tr>
                                <th>Lot</th>
                                <th>Expiration</th>
                                <th>Received</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {product.lots.map((lot) => {
                                const expired =
                                  new Date(lot.expirationDate).getTime() < Date.now();
                                return (
                                  <tr key={lot.id}>
                                    <td className="mono">{lot.lotNumber}</td>
                                    <td>
                                      {new Date(lot.expirationDate).toLocaleDateString()}
                                    </td>
                                    <td>
                                      {lot.receivedAt
                                        ? new Date(lot.receivedAt).toLocaleDateString()
                                        : "—"}
                                    </td>
                                    <td>
                                      <span
                                        className={
                                          expired
                                            ? "catalog-lot-status expired"
                                            : "catalog-lot-status"
                                        }
                                      >
                                        {expired ? "Expired" : "Current"}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}

          {medications.length === 0 && (
            <p className="empty-state">No catalog records match this search.</p>
          )}
        </div>
      </section>

      <div className="catalog-entry-stack">
        <section className="panel">
          <p className="eyebrow">Drug concept</p>
          <h2>Add drug</h2>
          {!writable && (
            <p className="permission-note">
              The selected role cannot modify drug/product master data.
            </p>
          )}
          <form className="stack-form" onSubmit={addMedication}>
            <label>
              Generic name
              <input value={genericName} onChange={(e) => setGenericName(e.target.value)} required disabled={!writable} />
            </label>
            <label>
              Brand name (optional)
              <input value={brandName} onChange={(e) => setBrandName(e.target.value)} disabled={!writable} />
            </label>
            <label>
              Strength
              <input value={strength} onChange={(e) => setStrength(e.target.value)} placeholder="10 mg" required disabled={!writable} />
            </label>
            <label>
              Dosage form
              <input value={dosageForm} onChange={(e) => setDosageForm(e.target.value)} placeholder="tablet" required disabled={!writable} />
            </label>
            <label>
              Route
              <input value={route} onChange={(e) => setRoute(e.target.value)} placeholder="oral" disabled={!writable} />
            </label>
            <button className="primary-button" type="submit" disabled={!writable || loading}>
              Add drug
            </button>
          </form>
        </section>

        <section className="panel">
          <p className="eyebrow">Commercial product</p>
          <h2>Add manufacturer / NDC</h2>
          <form className="stack-form" onSubmit={addProduct}>
            <label>
              Drug
              <select
                value={selectedMedicationId}
                onChange={(e) => setSelectedMedicationId(e.target.value)}
                required
                disabled={!writable}
              >
                <option value="">Select drug</option>
                {medications.map((medication) => (
                  <option key={medication.id} value={medication.id}>
                    {medicationLabel(medication)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Manufacturer
              <input value={manufacturerName} onChange={(e) => setManufacturerName(e.target.value)} required disabled={!writable} />
            </label>
            <label>
              Manufacturer labeler code (optional)
              <input value={manufacturerLabelerCode} onChange={(e) => setManufacturerLabelerCode(e.target.value)} disabled={!writable} />
            </label>
            <label>
              NDC
              <input value={ndc} onChange={(e) => setNdc(e.target.value)} placeholder="00000-0000-00" required disabled={!writable} />
            </label>
            <label>
              Label/product name (optional)
              <input value={labelName} onChange={(e) => setLabelName(e.target.value)} disabled={!writable} />
            </label>
            <label>
              Package description (optional)
              <input value={packageDescription} onChange={(e) => setPackageDescription(e.target.value)} placeholder="Bottle of 100 tablets" disabled={!writable} />
            </label>
            <button className="primary-button" type="submit" disabled={!writable || loading || !selectedMedicationId}>
              Add product
            </button>
          </form>
        </section>

        <section className="panel">
          <p className="eyebrow">Traceable package lot</p>
          <h2>Add lot / expiration</h2>
          <form className="stack-form" onSubmit={addLot}>
            <label>
              Manufacturer / NDC product
              <select
                value={selectedProductId}
                onChange={(e) => setSelectedProductId(e.target.value)}
                required
                disabled={!writable}
              >
                <option value="">Select product</option>
                {products.map(({ medication, product }) => (
                  <option key={product.id} value={product.id}>
                    {productLabel(product, medication)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Lot number
              <input value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} required disabled={!writable} />
            </label>
            <label>
              Expiration date
              <input type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} required disabled={!writable} />
            </label>
            <label>
              Received date (optional)
              <input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} disabled={!writable} />
            </label>
            <button className="primary-button" type="submit" disabled={!writable || loading || !selectedProductId}>
              Record lot
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
