import { useEffect, useMemo, useState } from "react";
import {
  acknowledgeInventoryException,
  createInventoryLocation,
  createReceivingDiscrepancy,
  getFefoRecommendation,
  getInventoryDemands,
  getInventoryExceptions,
  getInventoryLocations,
  getInventoryPolicies,
  getInventoryProjection,
  getReceivingDiscrepancies,
  moveInventoryStock,
  resolveReceivingDiscrepancy,
  saveInventoryPolicy,
} from "../api";
import type {
  DevUser,
  InventoryBalance,
  InventoryDemand,
  InventoryException,
  InventoryLocation,
  InventoryLocationType,
  InventoryPolicy,
  InventoryStockState,
  ReceivingDiscrepancy,
  ReceivingDiscrepancyType,
} from "../types";
import { canCorrectInventory, canWriteInventory } from "../workflow";

const locationTypes: InventoryLocationType[] = [
  "SHELF", "BIN", "REFRIGERATOR", "FREEZER", "SAFE", "RECEIVING",
  "QUARANTINE", "RETURN_TO_VENDOR", "WILL_CALL", "OTHER",
];

const discrepancyTypes: ReceivingDiscrepancyType[] = [
  "SHORT_SHIPMENT", "OVERAGE", "WRONG_PRODUCT", "DAMAGED_PRODUCT",
  "LOT_EXPIRATION_MISMATCH", "INVOICE_MISMATCH", "DUPLICATE_SHIPMENT",
  "UNEXPECTED_PRODUCT", "OTHER",
];

function qty(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function productLabel(balance: InventoryBalance) {
  const product = balance.product;
  return [
    product
      ? `${product.medication.genericName} ${product.medication.strength}`
      : balance.productId,
    product?.ndc ? `NDC ${product.ndc}` : null,
    balance.productLot?.lotNumber ? `Lot ${balance.productLot.lotNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function InventoryArchitecture({
  devUser,
  user,
  balances,
  onError,
  onInventoryChanged,
}: {
  devUser: string;
  user?: DevUser;
  balances: InventoryBalance[];
  onError: (message: string | null) => void;
  onInventoryChanged: () => Promise<void>;
}) {
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [policies, setPolicies] = useState<InventoryPolicy[]>([]);
  const [demands, setDemands] = useState<InventoryDemand[]>([]);
  const [exceptions, setExceptions] = useState<InventoryException[]>([]);
  const [discrepancies, setDiscrepancies] = useState<ReceivingDiscrepancy[]>([]);
  const [busy, setBusy] = useState(false);

  const [locationCode, setLocationCode] = useState("");
  const [locationName, setLocationName] = useState("");
  const [locationType, setLocationType] = useState<InventoryLocationType>("SHELF");
  const [defaultReceiving, setDefaultReceiving] = useState(false);
  const [defaultDispensing, setDefaultDispensing] = useState(false);

  const [moveBalanceId, setMoveBalanceId] = useState("");
  const [fromLocationId, setFromLocationId] = useState("");
  const [toLocationId, setToLocationId] = useState("");
  const [moveState, setMoveState] = useState<InventoryStockState>("AVAILABLE");
  const [moveQuantity, setMoveQuantity] = useState("");
  const [moveReason, setMoveReason] = useState("");

  const [minShelfLifeDays, setMinShelfLifeDays] = useState("30");
  const [expirationWarningDays, setExpirationWarningDays] = useState("90");
  const [staleReservationHours, setStaleReservationHours] = useState("24");
  const [staleTransferHours, setStaleTransferHours] = useState("48");
  const [poOverdueDays, setPoOverdueDays] = useState("3");
  const [preferredSupplier, setPreferredSupplier] = useState("");

  const [fefoProductId, setFefoProductId] = useState("");
  const [fefoQuantity, setFefoQuantity] = useState("");
  const [fefoResult, setFefoResult] =
    useState<Awaited<ReturnType<typeof getFefoRecommendation>> | null>(null);

  const [projectionBalanceId, setProjectionBalanceId] = useState("");
  const [projectionAt, setProjectionAt] = useState("");
  const [projection, setProjection] =
    useState<Awaited<ReturnType<typeof getInventoryProjection>> | null>(null);

  const [discrepancyType, setDiscrepancyType] =
    useState<ReceivingDiscrepancyType>("SHORT_SHIPMENT");
  const [discrepancyExpected, setDiscrepancyExpected] = useState("");
  const [discrepancyObserved, setDiscrepancyObserved] = useState("");
  const [discrepancyNote, setDiscrepancyNote] = useState("");
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");

  const writable = canWriteInventory(user);
  const correctable = canCorrectInventory(user);

  async function refresh() {
    if (!devUser) return;
    try {
      const [
        nextLocations,
        nextPolicies,
        nextDemands,
        nextExceptions,
        nextDiscrepancies,
      ] = await Promise.all([
        getInventoryLocations(devUser),
        getInventoryPolicies(devUser),
        getInventoryDemands(devUser),
        getInventoryExceptions(devUser),
        getReceivingDiscrepancies(devUser),
      ]);
      setLocations(nextLocations);
      setPolicies(nextPolicies);
      setDemands(nextDemands);
      setExceptions(nextExceptions);
      setDiscrepancies(nextDiscrepancies);

      const siteDefault = nextPolicies.find(
        (policy) => policy.policyKey === "SITE_DEFAULT",
      );
      if (siteDefault) {
        setMinShelfLifeDays(String(siteDefault.minShelfLifeDays));
        setExpirationWarningDays(String(siteDefault.expirationWarningDays));
        setStaleReservationHours(String(siteDefault.staleReservationHours));
        setStaleTransferHours(String(siteDefault.staleTransferHours));
        setPoOverdueDays(String(siteDefault.purchaseOrderOverdueDays));
        setPreferredSupplier(siteDefault.preferredSupplierName ?? "");
      }
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load inventory architecture controls.",
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, [devUser]);

  const productChoices = useMemo(() => {
    const seen = new Set<string>();
    return balances
      .filter((balance) => {
        if (seen.has(balance.productId)) return false;
        seen.add(balance.productId);
        return true;
      })
      .map((balance) => ({
        productId: balance.productId,
        label: productLabel(balance),
      }));
  }, [balances]);

  const selectedMoveBalance = balances.find(
    (balance) => balance.id === moveBalanceId,
  );
  const sourcePositions =
    selectedMoveBalance?.stockPositions?.filter(
      (position) =>
        position.state === moveState && Number(position.quantity) > 0,
    ) ?? [];

  async function createLocation() {
    if (!correctable || !locationCode.trim() || !locationName.trim()) return;
    setBusy(true);
    onError(null);
    try {
      await createInventoryLocation(devUser, {
        code: locationCode.trim(),
        name: locationName.trim(),
        type: locationType,
        isDefaultReceiving: defaultReceiving,
        isDefaultDispensing: defaultDispensing,
        isQuarantine: locationType === "QUARANTINE",
      });
      setLocationCode("");
      setLocationName("");
      setDefaultReceiving(false);
      setDefaultDispensing(false);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create location.");
    } finally {
      setBusy(false);
    }
  }

  async function moveStock() {
    const amount = Number(moveQuantity);
    if (
      !writable ||
      !moveBalanceId ||
      !fromLocationId ||
      !toLocationId ||
      fromLocationId === toLocationId ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !moveReason.trim()
    ) return;

    setBusy(true);
    onError(null);
    try {
      await moveInventoryStock(devUser, {
        inventoryBalanceId: moveBalanceId,
        fromLocationId,
        toLocationId,
        state: moveState,
        quantity: amount,
        reason: moveReason.trim(),
      });
      setMoveQuantity("");
      setMoveReason("");
      await Promise.all([refresh(), onInventoryChanged()]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to move stock.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSitePolicy() {
    if (!correctable) return;
    setBusy(true);
    onError(null);
    try {
      await saveInventoryPolicy(devUser, "SITE_DEFAULT", {
        scope: "SITE",
        minShelfLifeDays: Number(minShelfLifeDays),
        expirationWarningDays: Number(expirationWarningDays),
        staleReservationHours: Number(staleReservationHours),
        staleTransferHours: Number(staleTransferHours),
        purchaseOrderOverdueDays: Number(poOverdueDays),
        fefoEnabled: true,
        preferredSupplierName: preferredSupplier.trim() || null,
      });
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to save policy.");
    } finally {
      setBusy(false);
    }
  }

  async function runFefo() {
    const amount = Number(fefoQuantity);
    if (!fefoProductId || !Number.isFinite(amount) || amount <= 0) return;
    setBusy(true);
    onError(null);
    try {
      setFefoResult(
        await getFefoRecommendation(devUser, fefoProductId, amount),
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to calculate FEFO recommendation.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function runProjection() {
    if (!projectionBalanceId) return;
    setBusy(true);
    onError(null);
    try {
      setProjection(
        await getInventoryProjection(
          devUser,
          projectionBalanceId,
          projectionAt ? new Date(projectionAt).toISOString() : undefined,
        ),
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to reconstruct inventory balance.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge(exceptionId: string) {
    setBusy(true);
    try {
      await acknowledgeInventoryException(devUser, exceptionId);
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to acknowledge exception.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createDiscrepancy() {
    if (!writable) return;
    setBusy(true);
    onError(null);
    try {
      await createReceivingDiscrepancy(devUser, {
        type: discrepancyType,
        expectedQuantity: discrepancyExpected
          ? Number(discrepancyExpected)
          : undefined,
        observedQuantity: discrepancyObserved
          ? Number(discrepancyObserved)
          : undefined,
        note: discrepancyNote.trim() || undefined,
      });
      setDiscrepancyExpected("");
      setDiscrepancyObserved("");
      setDiscrepancyNote("");
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to open discrepancy.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resolveDiscrepancy() {
    if (!resolveId || !resolutionNote.trim()) return;
    setBusy(true);
    try {
      await resolveReceivingDiscrepancy(
        devUser,
        resolveId,
        resolutionNote.trim(),
      );
      setResolveId(null);
      setResolutionNote("");
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to resolve discrepancy.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel inventory-architecture-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Inventory architecture</p>
          <h2>Location, demand, policy & reconciliation controls</h2>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh controls
        </button>
      </div>

      <div className="inventory-architecture-grid">
        <article className="inventory-architecture-card">
          <h3>Physical locations</h3>
          <p className="catalog-help">
            Physical positions reconcile to on-hand quantity. Reservations are
            logical allocations; quarantine is a physical stock state.
          </p>
          <div className="architecture-location-list">
            {locations.map((location) => (
              <div key={location.id} className="architecture-location-row">
                <strong>{location.code}</strong>
                <span>{location.name}</span>
                <small>
                  {location.type.replaceAll("_", " ")}
                  {location.isDefaultReceiving ? " · receiving default" : ""}
                  {location.isDefaultDispensing ? " · dispensing default" : ""}
                  {location.isQuarantine ? " · quarantine" : ""}
                </small>
              </div>
            ))}
          </div>
          {correctable && (
            <div className="architecture-form">
              <input value={locationCode} onChange={(e) => setLocationCode(e.target.value)} placeholder="Code" />
              <input value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="Location name" />
              <select value={locationType} onChange={(e) => setLocationType(e.target.value as InventoryLocationType)}>
                {locationTypes.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
              </select>
              <label className="architecture-check"><input type="checkbox" checked={defaultReceiving} onChange={(e) => setDefaultReceiving(e.target.checked)} /> Default receiving</label>
              <label className="architecture-check"><input type="checkbox" checked={defaultDispensing} onChange={(e) => setDefaultDispensing(e.target.checked)} /> Default dispensing</label>
              <button type="button" className="primary-button" disabled={busy || !locationCode.trim() || !locationName.trim()} onClick={() => void createLocation()}>Add location</button>
            </div>
          )}
        </article>

        <article className="inventory-architecture-card">
          <h3>Move physical stock</h3>
          <div className="architecture-form">
            <select value={moveBalanceId} onChange={(e) => { setMoveBalanceId(e.target.value); setFromLocationId(""); }} disabled={!writable}>
              <option value="">Select inventory balance</option>
              {balances.map((balance) => <option key={balance.id} value={balance.id}>{productLabel(balance)}</option>)}
            </select>
            <select value={moveState} onChange={(e) => { setMoveState(e.target.value as InventoryStockState); setFromLocationId(""); }} disabled={!writable}>
              <option value="AVAILABLE">Available</option>
              <option value="QUARANTINED">Quarantined</option>
            </select>
            <select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} disabled={!writable}>
              <option value="">From location</option>
              {sourcePositions.map((position) => <option key={position.id} value={position.locationId}>{position.location.code} · {qty(position.quantity)}</option>)}
            </select>
            <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} disabled={!writable}>
              <option value="">To location</option>
              {locations.filter((location) => location.active).map((location) => <option key={location.id} value={location.id}>{location.code} · {location.name}</option>)}
            </select>
            <input type="number" min="0.001" step="0.001" value={moveQuantity} onChange={(e) => setMoveQuantity(e.target.value)} placeholder="Quantity" disabled={!writable} />
            <input value={moveReason} onChange={(e) => setMoveReason(e.target.value)} placeholder="Required reason" disabled={!writable} />
            <button type="button" className="secondary-button" disabled={busy || !writable || !moveBalanceId || !fromLocationId || !toLocationId || !moveQuantity || !moveReason.trim()} onClick={() => void moveStock()}>Move stock</button>
          </div>
        </article>

        <article className="inventory-architecture-card architecture-wide">
          <h3>Demand / backorder queue</h3>
          <div className="table-wrap">
            <table className="compact-table">
              <thead><tr><th>Status</th><th>Source</th><th>Medication</th><th>Required</th><th>Available</th><th>Needed by</th><th>Patient / Rx</th></tr></thead>
              <tbody>
                {demands.map((demand) => (
                  <tr key={demand.id}>
                    <td><strong>{demand.status}</strong></td>
                    <td>{demand.source}</td>
                    <td>{demand.medication.genericName} {demand.medication.strength}</td>
                    <td>{qty(demand.requiredQuantity)}</td>
                    <td>{qty(demand.availableQuantity)}</td>
                    <td>{demand.neededBy ? new Date(demand.neededBy).toLocaleString() : "—"}</td>
                    <td>
                      {demand.fill?.prescription?.patient
                        ? `${demand.fill.prescription.patient.lastName}, ${demand.fill.prescription.patient.firstName}`
                        : "Automatic / manual demand"}
                      <span className="cell-subtext">{demand.fill?.prescription?.rxNumber ?? ""}</span>
                    </td>
                  </tr>
                ))}
                {demands.length === 0 && <tr><td colSpan={7} className="empty-state">No inventory demand is currently recorded.</td></tr>}
              </tbody>
            </table>
          </div>
        </article>

        <article className="inventory-architecture-card">
          <h3>Site inventory policy</h3>
          <div className="architecture-form">
            <input type="number" min="0" value={minShelfLifeDays} onChange={(e) => setMinShelfLifeDays(e.target.value)} placeholder="Minimum shelf-life days" disabled={!correctable} />
            <input type="number" min="0" value={expirationWarningDays} onChange={(e) => setExpirationWarningDays(e.target.value)} placeholder="Expiration warning days" disabled={!correctable} />
            <input type="number" min="1" value={staleReservationHours} onChange={(e) => setStaleReservationHours(e.target.value)} placeholder="Stale reservation hours" disabled={!correctable} />
            <input type="number" min="1" value={staleTransferHours} onChange={(e) => setStaleTransferHours(e.target.value)} placeholder="Stale transfer hours" disabled={!correctable} />
            <input type="number" min="0" value={poOverdueDays} onChange={(e) => setPoOverdueDays(e.target.value)} placeholder="PO overdue days" disabled={!correctable} />
            <input value={preferredSupplier} onChange={(e) => setPreferredSupplier(e.target.value)} placeholder="Preferred supplier" disabled={!correctable} />
            {correctable && <button type="button" className="primary-button" disabled={busy} onClick={() => void saveSitePolicy()}>Save site policy</button>}
          </div>
          <p className="catalog-help">
            Product-specific reorder/target policies use the same policy API and override this baseline.
          </p>
        </article>

        <article className="inventory-architecture-card">
          <h3>FEFO planner</h3>
          <div className="architecture-form">
            <select value={fefoProductId} onChange={(e) => setFefoProductId(e.target.value)}>
              <option value="">Select product / NDC</option>
              {productChoices.map((product) => <option key={product.productId} value={product.productId}>{product.label}</option>)}
            </select>
            <input type="number" min="0.001" step="0.001" value={fefoQuantity} onChange={(e) => setFefoQuantity(e.target.value)} placeholder="Quantity needed" />
            <button type="button" className="secondary-button" disabled={busy || !fefoProductId || !fefoQuantity || Number(fefoQuantity) <= 0} onClick={() => void runFefo()}>Recommend lots</button>
          </div>
          {fefoResult && (
            <div className="architecture-result">
              <strong>{qty(fefoResult.recommendedQuantity)} recommended · {qty(fefoResult.shortageQuantity)} short</strong>
              <small>Minimum shelf life: {fefoResult.minShelfLifeDays} days</small>
              {fefoResult.picks.map((pick) => (
                <div key={pick.balanceId}>
                  Lot {pick.lotNumber} · Exp {new Date(pick.expirationDate).toLocaleDateString()} · {qty(pick.quantity)}
                  <span className="cell-subtext">{pick.locations.map((location) => `${location.code}: ${qty(location.quantity)}`).join(" · ")}</span>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="inventory-architecture-card">
          <h3>Historical balance projection</h3>
          <div className="architecture-form">
            <select value={projectionBalanceId} onChange={(e) => setProjectionBalanceId(e.target.value)}>
              <option value="">Select inventory balance</option>
              {balances.map((balance) => <option key={balance.id} value={balance.id}>{productLabel(balance)}</option>)}
            </select>
            <input type="datetime-local" value={projectionAt} onChange={(e) => setProjectionAt(e.target.value)} />
            <button type="button" className="secondary-button" disabled={busy || !projectionBalanceId} onClick={() => void runProjection()}>Reconstruct balance</button>
          </div>
          {projection && (
            <div className="architecture-result architecture-metrics">
              <span>On hand <strong>{qty(projection.onHandQuantity)}</strong></span>
              <span>Reserved <strong>{qty(projection.reservedQuantity)}</strong></span>
              <span>Quarantined <strong>{qty(projection.quarantinedQuantity)}</strong></span>
              <span>Available <strong>{qty(projection.availableQuantity)}</strong></span>
              <span>Recorded receipt cost <strong>$${Number(projection.recordedAcquisitionCost).toFixed(2)}</strong></span>
            </div>
          )}
        </article>

        <article className="inventory-architecture-card architecture-wide">
          <h3>Automated inventory exceptions</h3>
          <div className="table-wrap">
            <table className="compact-table">
              <thead><tr><th>Severity</th><th>Type</th><th>Finding</th><th>Status</th><th>Detected</th><th></th></tr></thead>
              <tbody>
                {exceptions.map((item) => (
                  <tr key={item.id}>
                    <td>{item.severity}</td>
                    <td>{item.type.replaceAll("_", " ")}</td>
                    <td><strong>{item.title}</strong><span className="cell-subtext">{item.detail}</span></td>
                    <td>{item.status}</td>
                    <td>{new Date(item.lastDetectedAt).toLocaleString()}</td>
                    <td>{item.status === "OPEN" && writable && <button type="button" className="secondary-button table-action" disabled={busy} onClick={() => void acknowledge(item.id)}>Acknowledge</button>}</td>
                  </tr>
                ))}
                {exceptions.length === 0 && <tr><td colSpan={6} className="empty-state">No automated inventory exceptions are currently detected.</td></tr>}
              </tbody>
            </table>
          </div>
        </article>

        <article className="inventory-architecture-card architecture-wide">
          <h3>Receiving discrepancies</h3>
          {writable && (
            <div className="architecture-form architecture-discrepancy-form">
              <select value={discrepancyType} onChange={(e) => setDiscrepancyType(e.target.value as ReceivingDiscrepancyType)}>
                {discrepancyTypes.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
              </select>
              <input type="number" min="0" step="0.001" value={discrepancyExpected} onChange={(e) => setDiscrepancyExpected(e.target.value)} placeholder="Expected qty" />
              <input type="number" min="0" step="0.001" value={discrepancyObserved} onChange={(e) => setDiscrepancyObserved(e.target.value)} placeholder="Observed qty" />
              <input value={discrepancyNote} onChange={(e) => setDiscrepancyNote(e.target.value)} placeholder="Receiving note" />
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void createDiscrepancy()}>Open discrepancy</button>
            </div>
          )}
          <div className="table-wrap">
            <table className="compact-table">
              <thead><tr><th>Status</th><th>Type</th><th>Expected</th><th>Observed</th><th>Note / resolution</th><th></th></tr></thead>
              <tbody>
                {discrepancies.map((item) => (
                  <tr key={item.id}>
                    <td>{item.status}</td>
                    <td>{item.type.replaceAll("_", " ")}</td>
                    <td>{qty(item.expectedQuantity)}</td>
                    <td>{qty(item.observedQuantity)}</td>
                    <td>{item.note ?? "—"}{item.resolutionNote && <span className="cell-subtext">Resolution: {item.resolutionNote}</span>}</td>
                    <td>{item.status === "OPEN" && correctable && <button type="button" className="secondary-button table-action" disabled={busy} onClick={() => { setResolveId(item.id); setResolutionNote(""); }}>Resolve</button>}</td>
                  </tr>
                ))}
                {discrepancies.length === 0 && <tr><td colSpan={6} className="empty-state">No receiving discrepancies are recorded.</td></tr>}
              </tbody>
            </table>
          </div>
          {resolveId && correctable && (
            <div className="inventory-operation-resolution">
              <label>
                Required resolution note
                <textarea rows={3} value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />
              </label>
              <div className="action-row">
                <button type="button" className="primary-button" disabled={busy || !resolutionNote.trim()} onClick={() => void resolveDiscrepancy()}>Resolve discrepancy</button>
                <button type="button" className="secondary-button" onClick={() => setResolveId(null)}>Cancel</button>
              </div>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
