import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  assignReceivingBarcode,
  correctReceivingBarcode,
  getInventoryLocations,
  getMedications,
  receiveInventoryStock,
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
  InventoryLocation,
} from "../types";
import { canCorrectInventory, canWriteInventory } from "../workflow";

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
  const [correctionProductId, setCorrectionProductId] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionWarning, setCorrectionWarning] = useState<string | null>(null);
  const [receiveQuantity, setReceiveQuantity] = useState("");
  const [receiveSource, setReceiveSource] = useState("");
  const [receiveReference, setReceiveReference] = useState("");
  const [receiveLocationId, setReceiveLocationId] = useState("");
  const [receiveUnitCost, setReceiveUnitCost] = useState("");
  const [receiveIdempotencyKey, setReceiveIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writable = canWriteInventory(user);
  const correctable = canCorrectInventory(user);

  useEffect(() => {
    if (!devUser) return;
    void Promise.all([getMedications(devUser), getInventoryLocations(devUser)])
      .then(([items, nextLocations]) => {
        setMedications(items.filter((item) => item.active));
        setLocations(nextLocations.filter((location) => location.active));
        const preferred =
          nextLocations.find((location) => location.type === "RECEIVING") ??
          nextLocations.find((location) => location.type === "DISPENSING") ??
          nextLocations[0];
        if (preferred) setReceiveLocationId(preferred.id);
      })
      .catch((error) =>
        onError(
          error instanceof Error
            ? error.message
            : "Unable to load receiving configuration.",
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
        setCorrectionProductId("");
        setCorrectionReason("");
        setCorrectionWarning(null);
        setReceiptMessage(null);
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

  async function receiveKnownStock() {
    if (!result || result.status !== "KNOWN" || !result.product) return;

    const quantity = Number(receiveQuantity);
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !result.parsed.lotNumber ||
      !result.parsed.expirationDate
    ) {
      return;
    }

    setBusy(true);
    onError(null);
    try {
      const received = await receiveInventoryStock(devUser, {
        rawBarcode,
        quantity,
        source: receiveSource.trim() || undefined,
        reference: receiveReference.trim() || undefined,
        locationId: receiveLocationId || undefined,
        unitCost: receiveUnitCost ? Number(receiveUnitCost) : undefined,
        idempotencyKey: receiveIdempotencyKey,
      });

      setReceiptMessage(
        `Received ${quantity} ${result.product.dispensingUnit ?? "units"}. On hand: ${received.balance.onHandQuantity}; available: ${received.balance.availableQuantity}.`,
      );
      setReceiveQuantity("");
      setReceiveReference("");
      setReceiveUnitCost("");
      setReceiveIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to receive inventory.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function correctKnownAssignment() {
    if (
      !result ||
      result.status !== "KNOWN" ||
      !result.barcode ||
      !correctionProductId ||
      !correctionReason.trim()
    ) {
      return;
    }

    setBusy(true);
    onError(null);
    try {
      const corrected = await correctReceivingBarcode(
        devUser,
        result.barcode.id,
        {
          productId: correctionProductId,
          reason: correctionReason.trim(),
          rawBarcode,
        },
      );

      setCorrectionWarning(corrected.safetyReview.message);
      const refreshed = await scanReceivingBarcode(devUser, rawBarcode);
      setResult(refreshed);
      setCorrectionProductId("");
      setCorrectionReason("");
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to correct barcode assignment.",
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
    setCorrectionProductId("");
    setCorrectionReason("");
    setCorrectionWarning(null);
    setReceiveQuantity("");
    setReceiveSource("");
    setReceiveReference("");
    setReceiveUnitCost("");
    setReceiveIdempotencyKey(crypto.randomUUID());
    setReceiptMessage(null);
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

              <div className="receiving-stock-entry">
                <div>
                  <p className="eyebrow">Receive quantity</p>
                  <h3>Add physical stock to inventory</h3>
                  <p className="catalog-help">
                    Receiving creates on-hand inventory for this exact NDC, lot,
                    and expiration. A lot/expiration barcode is required.
                  </p>
                </div>
                <div className="receiving-stock-grid">
                  <label>
                    Quantity ({result.product.dispensingUnit ?? "units"})
                    <input
                      type="number"
                      min="0.001"
                      step="0.001"
                      value={receiveQuantity}
                      onChange={(event) => setReceiveQuantity(event.target.value)}
                      disabled={!writable || busy}
                      placeholder="Example: 500"
                    />
                  </label>
                  <label>
                    Source / vendor
                    <input
                      value={receiveSource}
                      onChange={(event) => setReceiveSource(event.target.value)}
                      disabled={!writable || busy}
                      placeholder="Optional"
                    />
                  </label>
                  <label>
                    Invoice / reference
                    <input
                      value={receiveReference}
                      onChange={(event) => setReceiveReference(event.target.value)}
                      disabled={!writable || busy}
                      placeholder="Optional"
                    />
                  </label>
                  <label>
                    Physical location
                    <select
                      value={receiveLocationId}
                      onChange={(event) => setReceiveLocationId(event.target.value)}
                      disabled={!writable || busy}
                    >
                      <option value="">Automatic receiving location</option>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.code} · {location.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Unit acquisition cost
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={receiveUnitCost}
                      onChange={(event) => setReceiveUnitCost(event.target.value)}
                      disabled={!writable || busy}
                      placeholder="Optional per-unit cost"
                    />
                  </label>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    !writable ||
                    busy ||
                    !result.parsed.lotNumber ||
                    !result.parsed.expirationDate ||
                    !receiveQuantity ||
                    !Number.isFinite(Number(receiveQuantity)) ||
                    Number(receiveQuantity) <= 0
                  }
                  onClick={() => void receiveKnownStock()}
                >
                  Receive into inventory
                </button>
                {(!result.parsed.lotNumber || !result.parsed.expirationDate) && (
                  <p className="permission-note">
                    This scan does not contain both lot and expiration. Scan the
                    traceability barcode before posting received quantity.
                  </p>
                )}
                {receiptMessage && (
                  <p className="receiving-success">{receiptMessage}</p>
                )}
              </div>

              {correctable && result.barcode && (
                <div className="receiving-correction">
                  <div>
                    <p className="eyebrow">Pharmacist safety correction</p>
                    <h3>Correct barcode assignment</h3>
                    <p className="catalog-help">
                      Use only when this barcode was previously linked to the wrong
                      Drug/NDC. A reason is required and the original assignment is
                      preserved in the audit trail.
                    </p>
                  </div>

                  <label>
                    Correct product / NDC
                    <select
                      value={correctionProductId}
                      onChange={(event) =>
                        setCorrectionProductId(event.target.value)
                      }
                      disabled={busy}
                    >
                      <option value="">Select corrected NDC</option>
                      {products
                        .filter(({ product }) => product.id !== result.product?.id)
                        .map(({ medication, product }) => (
                          <option key={product.id} value={product.id}>
                            {productLabel(medication, product)}
                          </option>
                        ))}
                    </select>
                  </label>

                  <label>
                    Correction reason
                    <textarea
                      rows={3}
                      value={correctionReason}
                      onChange={(event) =>
                        setCorrectionReason(event.target.value)
                      }
                      placeholder="Example: Technician linked this GTIN to the wrong lisinopril manufacturer/NDC during receiving."
                      disabled={busy}
                    />
                  </label>

                  <button
                    className="danger-button"
                    type="button"
                    disabled={
                      busy ||
                      !correctionProductId ||
                      !correctionReason.trim()
                    }
                    onClick={() =>
                      window.confirm(
                        "Correct this barcode-to-product assignment? This action is audited and affects future scans.",
                      ) && void correctKnownAssignment()
                    }
                  >
                    Correct barcode assignment
                  </button>

                  {correctionWarning && (
                    <p className="clinical-gate-warning">
                      {correctionWarning}
                    </p>
                  )}
                </div>
              )}
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
