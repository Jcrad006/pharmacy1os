import { useEffect, useMemo, useState } from "react";
import {
  cancelInventoryDemand,
  createInventoryDemand,
  createInventoryLocation,
  getInventoryBalanceAsOf,
  getInventoryDemands,
  getInventoryIntelligence,
  getInventoryLocations,
  getInventoryPolicies,
  getInventoryRecommendations,
  getMedications,
  getPurchaseOrders,
  getReceivingDiscrepancies,
  linkInventoryDemandToPurchaseOrder,
  moveInventoryLocation,
  putInventoryPolicy,
  reportReceivingDiscrepancy,
  resolveReceivingDiscrepancy,
} from "../api";
import type {
  DevUser,
  InventoryBalance,
  InventoryDemand,
  InventoryIntelligence,
  InventoryLocation,
  InventoryLocationType,
  InventoryPolicy,
  Medication,
  PurchaseOrder,
  ReceivingDiscrepancy,
  ReceivingDiscrepancyType,
} from "../types";
import { canCorrectInventory, canWriteInventory } from "../workflow";

const locationTypes: InventoryLocationType[] = [
  "DISPENSING",
  "RECEIVING",
  "REFRIGERATOR",
  "FREEZER",
  "SAFE",
  "QUARANTINE",
  "RETURN_TO_VENDOR",
  "OVERFLOW",
  "OTHER",
];

const discrepancyTypes: ReceivingDiscrepancyType[] = [
  "SHORT_SHIPMENT",
  "OVERAGE",
  "WRONG_PRODUCT",
  "DAMAGED_PRODUCT",
  "LOT_EXPIRATION_MISMATCH",
  "INVOICE_MISMATCH",
  "DUPLICATE_SHIPMENT",
  "UNPLANNED_RECEIPT",
  "OTHER",
];

function quantity(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function money(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

export function InventoryArchitecture({
  devUser,
  user,
  balances,
  onError,
  onChanged,
}: {
  devUser: string;
  user?: DevUser;
  balances: InventoryBalance[];
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [intelligence, setIntelligence] = useState<InventoryIntelligence | null>(
    null,
  );
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [policies, setPolicies] = useState<InventoryPolicy[]>([]);
  const [demands, setDemands] = useState<InventoryDemand[]>([]);
  const [discrepancies, setDiscrepancies] = useState<ReceivingDiscrepancy[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [busy, setBusy] = useState(false);

  const [locationCode, setLocationCode] = useState("");
  const [locationName, setLocationName] = useState("");
  const [locationType, setLocationType] =
    useState<InventoryLocationType>("DISPENSING");
  const [moveBalanceId, setMoveBalanceId] = useState("");
  const [moveFromId, setMoveFromId] = useState("");
  const [moveToId, setMoveToId] = useState("");
  const [moveQuantity, setMoveQuantity] = useState("");
  const [moveReason, setMoveReason] = useState("");

  const [recommendMedicationId, setRecommendMedicationId] = useState("");
  const [recommendQuantity, setRecommendQuantity] = useState("");
  const [recommendation, setRecommendation] = useState<Awaited<
    ReturnType<typeof getInventoryRecommendations>
  > | null>(null);

  const [manualDemandMedicationId, setManualDemandMedicationId] = useState("");
  const [manualDemandQuantity, setManualDemandQuantity] = useState("");
  const [manualDemandDue, setManualDemandDue] = useState("");
  const [manualDemandNote, setManualDemandNote] = useState("");
  const [linkDemandId, setLinkDemandId] = useState("");
  const [linkPoLineId, setLinkPoLineId] = useState("");
  const [linkQuantity, setLinkQuantity] = useState("");

  const [policyScope, setPolicyScope] = useState<"SITE" | "MEDICATION">("SITE");
  const [policyMedicationId, setPolicyMedicationId] = useState("");
  const [reorderPoint, setReorderPoint] = useState("");
  const [parLevel, setParLevel] = useState("");
  const [minShelfLifeDays, setMinShelfLifeDays] = useState("");
  const [expirationWarningDays, setExpirationWarningDays] = useState("90");
  const [preferredSupplier, setPreferredSupplier] = useState("");
  const [staleReservationHours, setStaleReservationHours] = useState("24");
  const [fefoEnabled, setFefoEnabled] = useState(true);
  const [requireTransferSecondCheck, setRequireTransferSecondCheck] =
    useState(false);

  const [discrepancyType, setDiscrepancyType] =
    useState<ReceivingDiscrepancyType>("SHORT_SHIPMENT");
  const [discrepancyPoLineId, setDiscrepancyPoLineId] = useState("");
  const [discrepancyExpected, setDiscrepancyExpected] = useState("");
  const [discrepancyObserved, setDiscrepancyObserved] = useState("");
  const [discrepancyDetail, setDiscrepancyDetail] = useState("");
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");

  const [asOfBalanceId, setAsOfBalanceId] = useState("");
  const [asOfTime, setAsOfTime] = useState("");
  const [asOfResult, setAsOfResult] = useState<Awaited<
    ReturnType<typeof getInventoryBalanceAsOf>
  > | null>(null);

  const writable = canWriteInventory(user);
  const correctable = canCorrectInventory(user);

  async function refresh() {
    if (!devUser) return;
    try {
      const [
        nextIntelligence,
        nextLocations,
        nextPolicies,
        nextDemands,
        nextDiscrepancies,
        nextOrders,
        nextMedications,
      ] = await Promise.all([
        getInventoryIntelligence(devUser),
        getInventoryLocations(devUser),
        getInventoryPolicies(devUser),
        getInventoryDemands(devUser),
        getReceivingDiscrepancies(devUser),
        getPurchaseOrders(devUser),
        getMedications(devUser),
      ]);
      setIntelligence(nextIntelligence);
      setLocations(nextLocations);
      setPolicies(nextPolicies);
      setDemands(nextDemands);
      setDiscrepancies(nextDiscrepancies);
      setPurchaseOrders(nextOrders);
      setMedications(nextMedications);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load inventory architecture data.",
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, [devUser]);

  const poLines = useMemo(
    () =>
      purchaseOrders.flatMap((order) =>
        order.lines.map((line) => ({ order, line })),
      ),
    [purchaseOrders],
  );

  const sourcePositions = useMemo(
    () =>
      locations.flatMap((location) =>
        (location.positions ?? [])
          .filter((position) => Number(position.quantity) > 0)
          .map((position) => ({
            location,
            position,
            balance: position.inventoryBalance,
          })),
      ),
    [locations],
  );

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    onError(null);
    try {
      const result = await fn();
      await Promise.all([refresh(), onChanged()]);
      return result;
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Inventory operation could not be completed.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function addLocation() {
    if (!locationCode.trim() || !locationName.trim()) return;
    const result = await run(() =>
      createInventoryLocation(devUser, {
        code: locationCode.trim(),
        name: locationName.trim(),
        type: locationType,
      }),
    );
    if (result) {
      setLocationCode("");
      setLocationName("");
    }
  }

  async function moveStock() {
    const amount = Number(moveQuantity);
    if (
      !moveBalanceId ||
      !moveFromId ||
      !moveToId ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !moveReason.trim()
    ) {
      return;
    }
    const result = await run(() =>
      moveInventoryLocation(devUser, {
        inventoryBalanceId: moveBalanceId,
        fromLocationId: moveFromId,
        toLocationId: moveToId,
        quantity: amount,
        reason: moveReason.trim(),
      }),
    );
    if (result) {
      setMoveBalanceId("");
      setMoveFromId("");
      setMoveToId("");
      setMoveQuantity("");
      setMoveReason("");
    }
  }

  async function recommend() {
    const amount = Number(recommendQuantity);
    if (
      !recommendMedicationId ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return;
    }
    setBusy(true);
    onError(null);
    try {
      setRecommendation(
        await getInventoryRecommendations(devUser, {
          medicationId: recommendMedicationId,
          quantity: amount,
        }),
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to rank FEFO stock.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createDemand() {
    const amount = Number(manualDemandQuantity);
    if (
      !manualDemandMedicationId ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return;
    }
    const result = await run(() =>
      createInventoryDemand(devUser, {
        medicationId: manualDemandMedicationId,
        quantityRequired: amount,
        dueAt: manualDemandDue
          ? new Date(manualDemandDue).toISOString()
          : null,
        note: manualDemandNote.trim() || undefined,
        reason: "MANUAL",
      }),
    );
    if (result) {
      setManualDemandQuantity("");
      setManualDemandDue("");
      setManualDemandNote("");
    }
  }

  async function linkDemand() {
    const amount = Number(linkQuantity);
    if (
      !linkDemandId ||
      !linkPoLineId ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return;
    }
    const result = await run(() =>
      linkInventoryDemandToPurchaseOrder(devUser, linkDemandId, {
        purchaseOrderLineId: linkPoLineId,
        quantityPlanned: amount,
      }),
    );
    if (result) {
      setLinkDemandId("");
      setLinkPoLineId("");
      setLinkQuantity("");
    }
  }

  async function savePolicy() {
    if (policyScope === "MEDICATION" && !policyMedicationId) return;
    const key =
      policyScope === "SITE"
        ? "SITE"
        : `MEDICATION:${policyMedicationId}`;
    await run(() =>
      putInventoryPolicy(devUser, key, {
        medicationId:
          policyScope === "MEDICATION" ? policyMedicationId : null,
        reorderPoint: reorderPoint ? Number(reorderPoint) : null,
        parLevel: parLevel ? Number(parLevel) : null,
        minShelfLifeDays: minShelfLifeDays
          ? Number(minShelfLifeDays)
          : null,
        expirationWarningDays: Number(expirationWarningDays || 90),
        fefoEnabled,
        preferredSupplierName: preferredSupplier.trim() || null,
        requireTransferSecondCheck,
        staleReservationHours: Number(staleReservationHours || 24),
      }),
    );
  }

  async function reportDiscrepancy() {
    if (!discrepancyDetail.trim()) return;
    const result = await run(() =>
      reportReceivingDiscrepancy(devUser, {
        purchaseOrderLineId: discrepancyPoLineId || null,
        type: discrepancyType,
        expectedQuantity: discrepancyExpected
          ? Number(discrepancyExpected)
          : null,
        observedQuantity: discrepancyObserved
          ? Number(discrepancyObserved)
          : null,
        detail: discrepancyDetail.trim(),
      }),
    );
    if (result) {
      setDiscrepancyPoLineId("");
      setDiscrepancyExpected("");
      setDiscrepancyObserved("");
      setDiscrepancyDetail("");
    }
  }

  async function resolveDiscrepancy(
    status: "RESOLVED" | "DISMISSED",
  ) {
    if (!resolveId || !resolutionNote.trim()) return;
    const result = await run(() =>
      resolveReceivingDiscrepancy(devUser, resolveId, {
        status,
        resolutionNote: resolutionNote.trim(),
      }),
    );
    if (result) {
      setResolveId(null);
      setResolutionNote("");
    }
  }

  async function reconstruct() {
    if (!asOfBalanceId || !asOfTime) return;
    setBusy(true);
    onError(null);
    try {
      setAsOfResult(
        await getInventoryBalanceAsOf(
          devUser,
          asOfBalanceId,
          new Date(asOfTime).toISOString(),
        ),
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to reconstruct historical inventory.",
      );
    } finally {
      setBusy(false);
    }
  }

  const activeDemands = demands.filter((demand) =>
    ["OPEN", "PARTIALLY_SATISFIED"].includes(demand.status),
  );
  const openDiscrepancies = discrepancies.filter(
    (item) => item.status === "OPEN",
  );

  return (
    <section className="inventory-architecture-stack">
      <section className="panel inventory-architecture-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Inventory intelligence</p>
            <h2>Projection, exception & valuation layer</h2>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh intelligence
          </button>
        </div>

        <div className="inventory-intelligence-cards">
          <div>
            <span>Projected inventory value</span>
            <strong>{money(intelligence?.inventoryValue)}</strong>
          </div>
          <div>
            <span>Open demand</span>
            <strong>{activeDemands.length}</strong>
          </div>
          <div>
            <span>Open discrepancies</span>
            <strong>{openDiscrepancies.length}</strong>
          </div>
          <div>
            <span>Derived exceptions</span>
            <strong>{intelligence?.exceptions.length ?? 0}</strong>
          </div>
        </div>

        <div className="table-wrap">
          <table className="compact-table">
            <thead>
              <tr>
                <th>Exception</th>
                <th>Severity</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {(intelligence?.exceptions ?? []).slice(0, 50).map((item, index) => (
                <tr key={`${item.kind}-${index}`}>
                  <td>{item.kind.replaceAll("_", " ")}</td>
                  <td>
                    <strong>{item.severity}</strong>
                  </td>
                  <td className="mono">
                    {JSON.stringify(
                      Object.fromEntries(
                        Object.entries(item).filter(
                          ([key]) => !["kind", "severity"].includes(key),
                        ),
                      ),
                    )}
                  </td>
                </tr>
              ))}
              {(intelligence?.exceptions.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={3} className="empty-state">
                    No derived inventory exceptions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel inventory-architecture-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Physical storage</p>
            <h2>Locations & internal stock moves</h2>
          </div>
        </div>

        <div className="inventory-location-grid">
          {locations.map((location) => (
            <div className="inventory-location-card" key={location.id}>
              <strong>{location.code} · {location.name}</strong>
              <span>{location.type.replaceAll("_", " ")}</span>
              <small>
                {(location.positions ?? []).reduce(
                  (sum, position) => sum + Number(position.quantity),
                  0,
                ).toLocaleString()} positioned units
              </small>
            </div>
          ))}
        </div>

        {correctable && (
          <div className="inventory-operation-form">
            <label>
              Location code
              <input
                value={locationCode}
                onChange={(event) => setLocationCode(event.target.value)}
                placeholder="BIN-A14"
              />
            </label>
            <label>
              Name
              <input
                value={locationName}
                onChange={(event) => setLocationName(event.target.value)}
                placeholder="Fast-mover shelf A14"
              />
            </label>
            <label>
              Type
              <select
                value={locationType}
                onChange={(event) =>
                  setLocationType(event.target.value as InventoryLocationType)
                }
              >
                {locationTypes.map((type) => (
                  <option key={type} value={type}>
                    {type.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !locationCode.trim() || !locationName.trim()}
                onClick={() => void addLocation()}
              >
                Add location
              </button>
            </div>
          </div>
        )}

        {writable && (
          <div className="inventory-operation-form">
            <label className="wide">
              Stock at source location
              <select
                value={`${moveBalanceId}|${moveFromId}`}
                onChange={(event) => {
                  const [balanceId, locationId] = event.target.value.split("|");
                  setMoveBalanceId(balanceId ?? "");
                  setMoveFromId(locationId ?? "");
                }}
              >
                <option value="|">Select positioned stock</option>
                {sourcePositions.map(({ location, position, balance }) => (
                  <option
                    key={position.id}
                    value={`${position.inventoryBalanceId}|${location.id}`}
                  >
                    {balance?.product?.medication.genericName ?? position.inventoryBalanceId}
                    {" · "}{location.code}
                    {" · "}{quantity(position.quantity)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Destination location
              <select
                value={moveToId}
                onChange={(event) => setMoveToId(event.target.value)}
              >
                <option value="">Select destination</option>
                {locations
                  .filter((location) => location.id !== moveFromId && location.active)
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.code} · {location.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Quantity
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={moveQuantity}
                onChange={(event) => setMoveQuantity(event.target.value)}
              />
            </label>
            <label className="wide">
              Reason
              <input
                value={moveReason}
                onChange={(event) => setMoveReason(event.target.value)}
                placeholder="Restock dispensing shelf from overflow"
              />
            </label>
            <div className="wide">
              <button
                type="button"
                className="primary-button"
                disabled={
                  busy ||
                  !moveBalanceId ||
                  !moveFromId ||
                  !moveToId ||
                  !moveQuantity ||
                  !moveReason.trim()
                }
                onClick={() => void moveStock()}
              >
                Move physical stock
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel inventory-architecture-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">FEFO / demand</p>
            <h2>Pick intelligence & shortage planning</h2>
          </div>
        </div>

        <div className="inventory-operation-form">
          <label>
            Medication
            <select
              value={recommendMedicationId}
              onChange={(event) => setRecommendMedicationId(event.target.value)}
            >
              <option value="">Select medication</option>
              {medications.map((medication) => (
                <option key={medication.id} value={medication.id}>
                  {medication.genericName} {medication.strength}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity needed
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={recommendQuantity}
              onChange={(event) => setRecommendQuantity(event.target.value)}
            />
          </label>
          <div className="wide">
            <button
              type="button"
              className="primary-button"
              disabled={busy || !recommendMedicationId || !recommendQuantity}
              onClick={() => void recommend()}
            >
              Recommend FEFO stock
            </button>
          </div>
        </div>

        {recommendation && (
          <div className="table-wrap">
            <table className="compact-table">
              <thead>
                <tr>
                  <th>NDC</th>
                  <th>Lot</th>
                  <th>Expiration</th>
                  <th>Available</th>
                  <th>Suggested</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {recommendation.recommendation.map((item) => (
                  <tr key={item.balanceId}>
                    <td>{item.product.ndc}</td>
                    <td>{item.lot.lotNumber}</td>
                    <td>
                      {new Date(item.expiration.expirationDate).toLocaleDateString()}
                    </td>
                    <td>{quantity(item.availableQuantity)}</td>
                    <td><strong>{quantity(item.suggestedQuantity)}</strong></td>
                    <td>
                      {item.locations
                        .filter((location) => Number(location.quantity) > 0)
                        .map((location) => `${location.code} (${quantity(location.quantity)})`)
                        .join(", ") || "Unpositioned"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {Number(recommendation.shortageQuantity) > 0 && (
              <p className="permission-note">
                Short by {quantity(recommendation.shortageQuantity)} units.
              </p>
            )}
          </div>
        )}

        <div className="table-wrap">
          <table className="compact-table">
            <thead>
              <tr>
                <th>Medication</th>
                <th>Reason</th>
                <th>Required</th>
                <th>Satisfied</th>
                <th>Due</th>
                <th>Supply link</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeDemands.map((demand) => (
                <tr key={demand.id}>
                  <td>
                    {demand.medication.genericName} {demand.medication.strength}
                  </td>
                  <td>{demand.reason.replaceAll("_", " ")}</td>
                  <td>{quantity(demand.quantityRequired)}</td>
                  <td>{quantity(demand.quantitySatisfied)}</td>
                  <td>
                    {demand.dueAt
                      ? new Date(demand.dueAt).toLocaleString()
                      : "—"}
                  </td>
                  <td>
                    {(demand.supplyLinks ?? []).map((link) => (
                      <span className="cell-subtext" key={link.id}>
                        {link.purchaseOrderLine.purchaseOrder.orderNumber}:{" "}
                        {quantity(link.quantityReceived)} /{" "}
                        {quantity(link.quantityPlanned)}
                      </span>
                    ))}
                  </td>
                  <td>
                    {writable && (
                      <button
                        className="secondary-button table-action"
                        type="button"
                        onClick={() => void run(() => cancelInventoryDemand(devUser, demand.id))}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {activeDemands.length === 0 && (
                <tr><td colSpan={7} className="empty-state">No open inventory demand.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {writable && (
          <>
            <div className="inventory-operation-form">
              <label>
                Manual demand medication
                <select
                  value={manualDemandMedicationId}
                  onChange={(event) =>
                    setManualDemandMedicationId(event.target.value)
                  }
                >
                  <option value="">Select medication</option>
                  {medications.map((medication) => (
                    <option key={medication.id} value={medication.id}>
                      {medication.genericName} {medication.strength}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Quantity required
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={manualDemandQuantity}
                  onChange={(event) => setManualDemandQuantity(event.target.value)}
                />
              </label>
              <label>
                Due date/time
                <input
                  type="datetime-local"
                  value={manualDemandDue}
                  onChange={(event) => setManualDemandDue(event.target.value)}
                />
              </label>
              <label>
                Note
                <input
                  value={manualDemandNote}
                  onChange={(event) => setManualDemandNote(event.target.value)}
                />
              </label>
              <div className="wide">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !manualDemandMedicationId || !manualDemandQuantity}
                  onClick={() => void createDemand()}
                >
                  Create demand
                </button>
              </div>
            </div>

            <div className="inventory-operation-form">
              <label>
                Demand
                <select
                  value={linkDemandId}
                  onChange={(event) => setLinkDemandId(event.target.value)}
                >
                  <option value="">Select demand</option>
                  {activeDemands.map((demand) => (
                    <option key={demand.id} value={demand.id}>
                      {demand.medication.genericName} ·{" "}
                      {quantity(
                        Number(demand.quantityRequired) -
                          Number(demand.quantitySatisfied),
                      )} remaining
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Purchase-order line
                <select
                  value={linkPoLineId}
                  onChange={(event) => setLinkPoLineId(event.target.value)}
                >
                  <option value="">Select PO line</option>
                  {poLines.map(({ order, line }) => (
                    <option key={line.id} value={line.id}>
                      {order.orderNumber} · {line.product.medication.genericName} ·{" "}
                      {quantity(
                        Number(line.quantityOrdered) -
                          Number(line.quantityReceived),
                      )} outstanding
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Planned quantity
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={linkQuantity}
                  onChange={(event) => setLinkQuantity(event.target.value)}
                />
              </label>
              <div>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || !linkDemandId || !linkPoLineId || !linkQuantity}
                  onClick={() => void linkDemand()}
                >
                  Link demand to PO
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="panel inventory-architecture-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Inventory policy</p>
            <h2>Reorder, FEFO, shelf-life & control rules</h2>
          </div>
        </div>

        {correctable && (
          <div className="inventory-operation-form">
            <label>
              Scope
              <select
                value={policyScope}
                onChange={(event) =>
                  setPolicyScope(event.target.value as "SITE" | "MEDICATION")
                }
              >
                <option value="SITE">Site default</option>
                <option value="MEDICATION">Medication override</option>
              </select>
            </label>
            {policyScope === "MEDICATION" && (
              <label>
                Medication
                <select
                  value={policyMedicationId}
                  onChange={(event) =>
                    setPolicyMedicationId(event.target.value)
                  }
                >
                  <option value="">Select medication</option>
                  {medications.map((medication) => (
                    <option key={medication.id} value={medication.id}>
                      {medication.genericName} {medication.strength}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Reorder point
              <input value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} type="number" min="0" />
            </label>
            <label>
              Par level
              <input value={parLevel} onChange={(e) => setParLevel(e.target.value)} type="number" min="0" />
            </label>
            <label>
              Minimum shelf life (days)
              <input value={minShelfLifeDays} onChange={(e) => setMinShelfLifeDays(e.target.value)} type="number" min="0" />
            </label>
            <label>
              Expiration warning (days)
              <input value={expirationWarningDays} onChange={(e) => setExpirationWarningDays(e.target.value)} type="number" min="0" />
            </label>
            <label>
              Stale reservation (hours)
              <input value={staleReservationHours} onChange={(e) => setStaleReservationHours(e.target.value)} type="number" min="1" />
            </label>
            <label>
              Preferred supplier
              <input value={preferredSupplier} onChange={(e) => setPreferredSupplier(e.target.value)} />
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={fefoEnabled} onChange={(e) => setFefoEnabled(e.target.checked)} />
              Use FEFO
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={requireTransferSecondCheck} onChange={(e) => setRequireTransferSecondCheck(e.target.checked)} />
              Require second-person transfer verification
            </label>
            <div className="wide">
              <button
                type="button"
                className="primary-button"
                disabled={busy || (policyScope === "MEDICATION" && !policyMedicationId)}
                onClick={() => void savePolicy()}
              >
                Save inventory policy
              </button>
            </div>
          </div>
        )}

        <div className="table-wrap">
          <table className="compact-table">
            <thead>
              <tr>
                <th>Policy</th>
                <th>Reorder</th>
                <th>Par</th>
                <th>Min shelf</th>
                <th>FEFO</th>
                <th>Supplier</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td>{policy.policyKey}</td>
                  <td>{quantity(policy.reorderPoint)}</td>
                  <td>{quantity(policy.parLevel)}</td>
                  <td>{policy.minShelfLifeDays ?? "—"}</td>
                  <td>{policy.fefoEnabled ? "Yes" : "No"}</td>
                  <td>{policy.preferredSupplierName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel inventory-architecture-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Receiving controls</p>
            <h2>Discrepancies & reconciliation</h2>
          </div>
        </div>

        {writable && (
          <div className="inventory-operation-form">
            <label>
              Type
              <select
                value={discrepancyType}
                onChange={(event) =>
                  setDiscrepancyType(
                    event.target.value as ReceivingDiscrepancyType,
                  )
                }
              >
                {discrepancyTypes.map((type) => (
                  <option key={type} value={type}>
                    {type.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Purchase-order line
              <select
                value={discrepancyPoLineId}
                onChange={(event) =>
                  setDiscrepancyPoLineId(event.target.value)
                }
              >
                <option value="">Not linked / free receiving</option>
                {poLines.map(({ order, line }) => (
                  <option key={line.id} value={line.id}>
                    {order.orderNumber} · {line.product.medication.genericName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Expected quantity
              <input type="number" min="0" value={discrepancyExpected} onChange={(e) => setDiscrepancyExpected(e.target.value)} />
            </label>
            <label>
              Observed quantity
              <input type="number" min="0" value={discrepancyObserved} onChange={(e) => setDiscrepancyObserved(e.target.value)} />
            </label>
            <label className="wide">
              Detail
              <textarea rows={2} value={discrepancyDetail} onChange={(e) => setDiscrepancyDetail(e.target.value)} />
            </label>
            <div className="wide">
              <button type="button" className="secondary-button" disabled={busy || !discrepancyDetail.trim()} onClick={() => void reportDiscrepancy()}>
                Report discrepancy
              </button>
            </div>
          </div>
        )}

        <div className="table-wrap">
          <table className="compact-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Type</th>
                <th>Expected / observed</th>
                <th>Detail</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {discrepancies.map((item) => (
                <tr key={item.id}>
                  <td>{item.status}</td>
                  <td>{item.type.replaceAll("_", " ")}</td>
                  <td>{quantity(item.expectedQuantity)} / {quantity(item.observedQuantity)}</td>
                  <td>{item.detail}</td>
                  <td>
                    {correctable && item.status === "OPEN" && (
                      <button type="button" className="secondary-button table-action" onClick={() => { setResolveId(item.id); setResolutionNote(""); }}>
                        Resolve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {discrepancies.length === 0 && (
                <tr><td colSpan={5} className="empty-state">No receiving discrepancies.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {resolveId && correctable && (
          <div className="inventory-operation-resolution">
            <label>
              Resolution note
              <textarea rows={3} value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />
            </label>
            <div className="action-row">
              <button className="primary-button" type="button" disabled={!resolutionNote.trim() || busy} onClick={() => void resolveDiscrepancy("RESOLVED")}>
                Resolve
              </button>
              <button className="secondary-button" type="button" disabled={!resolutionNote.trim() || busy} onClick={() => void resolveDiscrepancy("DISMISSED")}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel inventory-architecture-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Historical projection</p>
            <h2>Inventory balance as of date/time</h2>
          </div>
        </div>
        <div className="inventory-operation-form">
          <label>
            Inventory balance
            <select value={asOfBalanceId} onChange={(e) => setAsOfBalanceId(e.target.value)}>
              <option value="">Select balance</option>
              {balances.map((balance) => (
                <option key={balance.id} value={balance.id}>
                  {balance.product?.medication.genericName ?? balance.productId} ·{" "}
                  {balance.productLot?.lotNumber ?? balance.productLotId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Date/time
            <input type="datetime-local" value={asOfTime} onChange={(e) => setAsOfTime(e.target.value)} />
          </label>
          <div className="wide">
            <button type="button" className="primary-button" disabled={busy || !asOfBalanceId || !asOfTime} onClick={() => void reconstruct()}>
              Reconstruct balance
            </button>
          </div>
        </div>
        {asOfResult && (
          <div className="inventory-intelligence-cards">
            <div><span>On hand</span><strong>{quantity(asOfResult.snapshot.onHandQuantity)}</strong></div>
            <div><span>Reserved</span><strong>{quantity(asOfResult.snapshot.reservedQuantity)}</strong></div>
            <div><span>Quarantined</span><strong>{quantity(asOfResult.snapshot.quarantinedQuantity)}</strong></div>
            <div><span>Available</span><strong>{quantity(asOfResult.snapshot.availableQuantity)}</strong></div>
          </div>
        )}
      </section>
    </section>
  );
}
