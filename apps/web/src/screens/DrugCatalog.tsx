import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createMedication,
  createProduct,
  createProductExpiration,
  assignProductBarcode,
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

function money(value: string | number | null, fractionDigits = 2) {
  if (value === null) return "Not entered";
  const number = Number(value);
  if (!Number.isFinite(number)) return "Not entered";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(number);
}

function unitLabel(unit: Product["dispensingUnit"]) {
  if (unit === "EACH") return "each";
  if (unit === "GRAM") return "gram";
  if (unit === "MILLILITER") return "mL";
  return "unit";
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
  const [descriptor, setDescriptor] = useState("");
  const [packageDescription, setPackageDescription] = useState("");
  const [packageType, setPackageType] = useState("");
  const [unitsPerPackage, setUnitsPerPackage] = useState("");
  const [dispensingUnit, setDispensingUnit] =
    useState<Product["dispensingUnit"]>("EACH");
  const [unitPrice, setUnitPrice] = useState("");
  const [packagePrice, setPackagePrice] = useState("");

  const [selectedLotProductId, setSelectedLotProductId] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [receivedAt, setReceivedAt] = useState("");

  const [selectedExpirationProductId, setSelectedExpirationProductId] = useState("");
  const [expirationDate, setExpirationDate] = useState("");

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

      for (const [selected, clear] of [
        [selectedLotProductId, () => setSelectedLotProductId("")],
        [selectedExpirationProductId, () => setSelectedExpirationProductId("")],
      ] as const) {
        if (
          selected &&
          !next.some((medication) =>
            medication.products.some((product) => product.id === selected),
          )
        ) {
          clear();
        }
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
        descriptor,
        packageDescription: packageDescription || undefined,
        packageType,
        unitsPerPackage: Number(unitsPerPackage),
        dispensingUnit: dispensingUnit ?? "EACH",
        unitPrice: unitPrice === "" ? undefined : Number(unitPrice),
        packagePrice: packagePrice === "" ? undefined : Number(packagePrice),
      });

      setNdc("");
      setManufacturerName("");
      setManufacturerLabelerCode("");
      setDescriptor("");
      setPackageDescription("");
      setPackageType("");
      setUnitsPerPackage("");
      setDispensingUnit("EACH");
      setUnitPrice("");
      setPackagePrice("");
      setSelectedLotProductId(result.product.id);
      setSelectedExpirationProductId(result.product.id);

      const pendingBarcode = localStorage.getItem("pharmacy1os.pendingBarcode");
      if (pendingBarcode) {
        await assignProductBarcode(devUser, result.product.id, pendingBarcode, {
          isPrimary: true,
          note: "Assigned while creating a new product from Receiving.",
        });
        localStorage.removeItem("pharmacy1os.pendingBarcode");
      }

      setQuery("");
      await load("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create product.");
      setLoading(false);
    }
  }

  async function addLot(event: FormEvent) {
    event.preventDefault();
    if (!selectedLotProductId) return;

    setLoading(true);
    onError(null);

    try {
      await createProductLot(devUser, selectedLotProductId, {
        lotNumber,
        receivedAt: receivedAt
          ? new Date(`${receivedAt}T00:00:00Z`).toISOString()
          : undefined,
      });

      setLotNumber("");
      setReceivedAt("");
      setQuery("");
      await load("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to record lot.");
      setLoading(false);
    }
  }

  async function addExpiration(event: FormEvent) {
    event.preventDefault();
    if (!selectedExpirationProductId) return;

    setLoading(true);
    onError(null);

    try {
      await createProductExpiration(
        devUser,
        selectedExpirationProductId,
        new Date(`${expirationDate}T00:00:00Z`).toISOString(),
      );

      setExpirationDate("");
      setQuery("");
      await load("");
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to record expiration date.",
      );
      setLoading(false);
    }
  }

  async function assignBarcodeToProduct(productId: string) {
    const rawBarcode = window.prompt(
      "Scan or enter the barcode identifier to assign to this NDC.",
    );
    if (!rawBarcode?.trim()) return;

    setLoading(true);
    onError(null);
    try {
      await assignProductBarcode(devUser, productId, rawBarcode, {
        isPrimary: true,
        note: "Assigned from Drug / Product catalog.",
      });
      await load("");
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to assign barcode.",
      );
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
            {loading
              ? "Loading…"
              : `${medications.length} drug${medications.length === 1 ? "" : "s"}`}
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
          Hierarchy: Drug → NDC → Lots + Expiration Dates. Lot and expiration
          collections are stored independently under each NDC.
        </p>

        <div className="catalog-medication-list">
          {medications.map((medication) => (
            <article className="catalog-medication-card" key={medication.id}>
              <div className="catalog-medication-heading">
                <div>
                  <strong>
                    {medication.genericName} {medication.strength}
                  </strong>
                  <span>
                    {medication.dosageForm}
                    {medication.route ? ` · ${medication.route}` : ""}
                    {medication.brandName
                      ? ` · Brand: ${medication.brandName}`
                      : ""}
                  </span>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!writable}
                  onClick={() => setSelectedMedicationId(medication.id)}
                >
                  Add NDC
                </button>
              </div>

              {medication.products.length === 0 ? (
                <p className="muted">No NDC products stored yet.</p>
              ) : (
                <div className="catalog-product-list">
                  {medication.products.map((product) => (
                    <div className="catalog-product-card" key={product.id}>
                      <div className="catalog-product-heading">
                        <div>
                          <strong>{product.manufacturer.name}</strong>
                          <span className="mono">NDC {product.ndc}</span>
                          <span>{product.descriptor}</span>
                          <span>Dosage form: {medication.dosageForm}</span>
                          <span>
                            Stock package: {product.unitsPerPackage ?? "—"}{" "}
                            {unitLabel(product.dispensingUnit)}
                            {product.packageType ? ` per ${product.packageType}` : ""}
                          </span>
                          <span>
                            Unit price: {money(product.unitPrice, 4)} /{" "}
                            {unitLabel(product.dispensingUnit)}
                          </span>
                          <span>Package price: {money(product.packagePrice)}</span>
                          {product.packageDescription && (
                            <span>{product.packageDescription}</span>
                          )}
                        </div>
                        <div className="catalog-product-actions">
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={!writable}
                            onClick={() => setSelectedLotProductId(product.id)}
                          >
                            Add lot
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={!writable}
                            onClick={() => setSelectedExpirationProductId(product.id)}
                          >
                            Add expiration
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={!writable}
                            onClick={() => void assignBarcodeToProduct(product.id)}
                          >
                            Assign barcode
                          </button>
                        </div>
                      </div>

                      <div className="catalog-barcode-strip">
                        <strong>Registered barcodes</strong>
                        {product.barcodes.length === 0 ? (
                          <span className="muted">No barcode identifiers assigned.</span>
                        ) : (
                          <div className="catalog-barcode-list">
                            {product.barcodes.map((barcode) => (
                              <span className="barcode-chip" key={barcode.id}>
                                {barcode.type}: {barcode.identifier}
                                {barcode.isPrimary ? " · primary" : ""}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="catalog-ndc-children">
                        <div className="catalog-child-column">
                          <strong>Lots</strong>
                          {product.lots.length === 0 ? (
                            <p className="muted">No lots stored.</p>
                          ) : (
                            <ul className="catalog-child-list">
                              {product.lots.map((lot) => (
                                <li key={lot.id}>
                                  <span className="mono">{lot.lotNumber}</span>
                                  {lot.receivedAt && (
                                    <span>
                                      Received{" "}
                                      {new Date(lot.receivedAt).toLocaleDateString()}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        <div className="catalog-child-column">
                          <strong>Expiration dates</strong>
                          {product.expirations.length === 0 ? (
                            <p className="muted">No expiration dates stored.</p>
                          ) : (
                            <ul className="catalog-child-list">
                              {product.expirations.map((expiration) => {
                                const expired =
                                  new Date(expiration.expirationDate).getTime() <
                                  Date.now();
                                return (
                                  <li key={expiration.id}>
                                    <span>
                                      {new Date(
                                        expiration.expirationDate,
                                      ).toLocaleDateString()}
                                    </span>
                                    <span
                                      className={
                                        expired
                                          ? "catalog-lot-status expired"
                                          : "catalog-lot-status"
                                      }
                                    >
                                      {expired ? "Expired" : "Current"}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      </div>
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
              <input
                value={genericName}
                onChange={(e) => setGenericName(e.target.value)}
                required
                disabled={!writable}
              />
            </label>
            <label>
              Brand name (optional)
              <input
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                disabled={!writable}
              />
            </label>
            <label>
              Strength
              <input
                value={strength}
                onChange={(e) => setStrength(e.target.value)}
                placeholder="10 mg"
                required
                disabled={!writable}
              />
            </label>
            <label>
              Dosage form
              <input
                value={dosageForm}
                onChange={(e) => setDosageForm(e.target.value)}
                placeholder="tablet"
                required
                disabled={!writable}
              />
            </label>
            <label>
              Route
              <input
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                placeholder="oral"
                disabled={!writable}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={!writable || loading}
            >
              Add drug
            </button>
          </form>
        </section>

        <section className="panel">
          <p className="eyebrow">NDC product</p>
          <h2>Add NDC / manufacturer</h2>
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
              <input
                value={manufacturerName}
                onChange={(e) => setManufacturerName(e.target.value)}
                required
                disabled={!writable}
              />
            </label>
            <label>
              Manufacturer labeler code (optional)
              <input
                value={manufacturerLabelerCode}
                onChange={(e) => setManufacturerLabelerCode(e.target.value)}
                disabled={!writable}
              />
            </label>
            <label>
              NDC
              <input
                value={ndc}
                onChange={(e) => setNdc(e.target.value)}
                placeholder="00000-0000-00"
                required
                disabled={!writable}
              />
            </label>
            <label>
              NDC descriptor
              <input
                value={descriptor}
                onChange={(e) => setDescriptor(e.target.value)}
                placeholder="Lisinopril 10 mg tablet — 100 count bottle"
                required
                disabled={!writable}
              />
            </label>
            <label>
              Package type
              <input
                value={packageType}
                onChange={(e) => setPackageType(e.target.value)}
                placeholder="bottle, tube, box, vial..."
                required
                disabled={!writable}
              />
            </label>
            <label>
              Units per stock package
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={unitsPerPackage}
                onChange={(e) => setUnitsPerPackage(e.target.value)}
                placeholder="100"
                required
                disabled={!writable}
              />
            </label>
            <label>
              Dispensing unit
              <select
                value={dispensingUnit ?? "EACH"}
                onChange={(e) =>
                  setDispensingUnit(
                    e.target.value as Product["dispensingUnit"],
                  )
                }
                required
                disabled={!writable}
              >
                <option value="EACH">Each — tablet, capsule, unit-dose item</option>
                <option value="GRAM">Gram — cream, ointment, paste</option>
                <option value="MILLILITER">Milliliter — solution, suspension</option>
              </select>
            </label>
            <label>
              Price per unit (optional)
              <input
                type="number"
                min="0"
                step="0.000001"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                placeholder="0.03"
                disabled={!writable}
              />
            </label>
            <label>
              Price per stock package (optional)
              <input
                type="number"
                min="0"
                step="0.0001"
                value={packagePrice}
                onChange={(e) => setPackagePrice(e.target.value)}
                placeholder="3.00"
                disabled={!writable}
              />
            </label>
            <label>
              Package description (optional)
              <input
                value={packageDescription}
                onChange={(e) => setPackageDescription(e.target.value)}
                placeholder="Bottle of 100 tablets"
                disabled={!writable}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={!writable || loading || !selectedMedicationId}
            >
              Add NDC
            </button>
          </form>
        </section>

        <section className="panel">
          <p className="eyebrow">NDC child collection</p>
          <h2>Add lot</h2>
          <form className="stack-form" onSubmit={addLot}>
            <label>
              NDC product
              <select
                value={selectedLotProductId}
                onChange={(e) => setSelectedLotProductId(e.target.value)}
                required
                disabled={!writable}
              >
                <option value="">Select NDC</option>
                {products.map(({ medication, product }) => (
                  <option key={product.id} value={product.id}>
                    {productLabel(product, medication)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Lot number
              <input
                value={lotNumber}
                onChange={(e) => setLotNumber(e.target.value)}
                required
                disabled={!writable}
              />
            </label>
            <label>
              Received date (optional)
              <input
                type="date"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
                disabled={!writable}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={!writable || loading || !selectedLotProductId}
            >
              Record lot
            </button>
          </form>
        </section>

        <section className="panel">
          <p className="eyebrow">NDC child collection</p>
          <h2>Add expiration</h2>
          <form className="stack-form" onSubmit={addExpiration}>
            <label>
              NDC product
              <select
                value={selectedExpirationProductId}
                onChange={(e) => setSelectedExpirationProductId(e.target.value)}
                required
                disabled={!writable}
              >
                <option value="">Select NDC</option>
                {products.map(({ medication, product }) => (
                  <option key={product.id} value={product.id}>
                    {productLabel(product, medication)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Expiration date
              <input
                type="date"
                value={expirationDate}
                onChange={(e) => setExpirationDate(e.target.value)}
                required
                disabled={!writable}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={!writable || loading || !selectedExpirationProductId}
            >
              Record expiration
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
