import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  assignReceivingBarcode,
  getMedications,
  scanReceivingBarcode,
} from "../api";
import type {
  DevUser,
  Medication,
  ParsedBarcode,
  Product,
  ProductBarcode,
  ProductExpiration,
  ProductLot,
} from "../types";
import { canWriteInventory } from "../workflow";

type ReceivingResult = {
  status: "KNOWN" | "UNKNOWN";
  parsed: ParsedBarcode;
  barcode: ProductBarcode | null;
  product: (Product & { medication: Medication }) | null;
  traceability:
    | { lot: ProductLot | null; expiration: ProductExpiration | null }
    | null;
};

function productLabel(medication: Medication, product: Product) {
  return `${medication.genericName} ${medication.strength} ${medication.dosageForm} · ${product.manufacturer.name} · NDC ${product.ndc}`;
}

export function Receiving({
  devUser,
  user,
  onError,
  onOpenCatalog,
}: {
  devUser: string;
  user?: DevUser;
  onError: (message: string | null) => void;
  onOpenCatalog: () => void;
}) {
  const [rawBarcode, setRawBarcode] = useState("");
  const [result, setResult] = useState<ReceivingResult | null>(null);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const writable = canWriteInventory(user);

  useEffect(() => {
    if (!devUser) return;
    void getMedications(devUser)
      .then((items) => setMedications(items.filter((item) => item.active)))
      .catch((error) =>
        onError(
          error instanceof Error
            ? error.message
            : "Unable to load Drug/Product catalog.",
        ),
      );
  }, [devUser]);

  const products = useMemo(
    () =>
      medications.flatMap((medication) =>
        medication.products
          .filter((product) => product.active)
          .map((product) => ({ medication, product })),
      ),
    [medications],
  );

  async function scan(event: FormEvent) {
    event.preventDefault();
    if (!rawBarcode.trim()) return;

    setBusy(true);
    onError(null);
    try {
      const next = await scanReceivingBarcode(devUser, rawBarcode);
      setResult(next);
      if (next.status === "KNOWN" && next.product) {
        setSelectedProductId(next.product.id);
      }
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to process receiving scan.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function assignToExisting() {
    if (!result || result.status !== "UNKNOWN" || !selectedProductId) return;

    setBusy(true);
    onError(null);
    try {
      const assigned = await assignReceivingBarcode(
        devUser,
        rawBarcode,
        selectedProductId,
        { isPrimary: true, note: "Assigned during inventory receiving." },
      );

      setResult({
        status: "KNOWN",
        parsed: assigned.parsed,
        barcode: assigned.barcode,
        product: assigned.product,
        traceability: assigned.traceability,
      });
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to assign barcode.",
      );
    } finally {
      setBusy(false);
    }
  }

  function createNewProduct() {
    localStorage.setItem("pharmacy1os.pendingBarcode", rawBarcode);
    onOpenCatalog();
  }

  function reset() {
    setRawBarcode("");
    setResult(null);
    setSelectedProductId("");
    onError(null);
  }

  return (
    <div className="receiving-layout">
      <section className="panel receiving-scan-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Inventory receiving</p>
            <h2>Scan incoming stock</h2>
          </div>
        </div>

        {!writable && (
          <p className="permission-note">
            The selected role cannot modify receiving/product records.
          </p>
        )}

        <form className="receiving-scan-form" onSubmit={scan}>
          <label>
            Raw barcode / scanner input
            <textarea
              autoFocus
              rows={2}
              value={rawBarcode}
              onChange={(event) => setRawBarcode(event.target.value)}
              placeholder="Scan GS1 DataMatrix, GS1-128, GTIN, UPC, or another registered identifier"
              disabled={!writable || busy}
              required
            />
          </label>
          <div className="action-row">
            <button
              className="primary-button"
              type="submit"
              disabled={!writable || busy || !rawBarcode.trim()}
            >
              {busy ? "Processing…" : "Process scan"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={reset}
            >
              Clear
            </button>
          </div>
        </form>

        <p className="catalog-help">
          Product identity is matched through the barcode registry. GS1 lot and
          expiration values are treated as variable package data, not as the
          permanent product barcode.
        </p>
      </section>

      {result && (
        <section
          className={
            result.status === "KNOWN"
              ? "panel receiving-result receiving-known"
              : "panel receiving-result receiving-unknown"
          }
        >
          <p className="eyebrow">
            {result.status === "KNOWN" ? "Recognized stock" : "Unknown barcode"}
          </p>

          {result.status === "KNOWN" && result.product ? (
            <>
              <h2>
                {result.product.medication.genericName}{" "}
                {result.product.medication.strength}
              </h2>
              <div className="receiving-result-grid">
                <div><span>Dosage form</span><strong>{result.product.medication.dosageForm}</strong></div>
                <div><span>Manufacturer</span><strong>{result.product.manufacturer.name}</strong></div>
                <div><span>NDC</span><strong>{result.product.ndc}</strong></div>
                <div><span>Descriptor</span><strong>{result.product.descriptor}</strong></div>
                <div><span>Barcode type</span><strong>{result.parsed.type}</strong></div>
                <div><span>Identifier</span><strong>{result.parsed.identifier}</strong></div>
                <div><span>Lot from scan</span><strong>{result.parsed.lotNumber ?? "Not encoded"}</strong></div>
                <div>
                  <span>Expiration from scan</span>
                  <strong>
                    {result.parsed.expirationDate
                      ? new Date(result.parsed.expirationDate).toLocaleDateString()
                      : "Not encoded"}
                  </strong>
                </div>
              </div>
              <p className="receiving-success">
                Barcode recognized. Parsed lot/expiration data has been registered
                under this NDC when present.
              </p>
            </>
          ) : (
            <>
              <h2>Barcode is not yet assigned to a product</h2>
              <div className="receiving-result-grid">
                <div><span>Detected type</span><strong>{result.parsed.type}</strong></div>
                <div><span>Stable identifier</span><strong>{result.parsed.identifier}</strong></div>
                <div><span>Lot from scan</span><strong>{result.parsed.lotNumber ?? "Not encoded"}</strong></div>
                <div>
                  <span>Expiration from scan</span>
                  <strong>
                    {result.parsed.expirationDate
                      ? new Date(result.parsed.expirationDate).toLocaleDateString()
                      : "Not encoded"}
                  </strong>
                </div>
              </div>

              <div className="receiving-assignment">
                <label>
                  Assign to existing NDC
                  <select
                    value={selectedProductId}
                    onChange={(event) => setSelectedProductId(event.target.value)}
                    disabled={!writable || busy}
                  >
                    <option value="">Select existing product</option>
                    {products.map(({ medication, product }) => (
                      <option key={product.id} value={product.id}>
                        {productLabel(medication, product)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="action-row">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!writable || busy || !selectedProductId}
                    onClick={() => void assignToExisting()}
                  >
                    Assign barcode to selected NDC
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!writable || busy}
                    onClick={createNewProduct}
                  >
                    Create new Drug / NDC in F7
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
