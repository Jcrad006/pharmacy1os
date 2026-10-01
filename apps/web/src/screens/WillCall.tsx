import { useEffect, useRef, useState } from "react";
import {
  checkoutPos,
  getWillCallHistory,
  quotePosCheckout,
  rebagWillCallPackage,
  relocateWillCallPackage,
  returnFillToStock,
  scanWillCallBarcode,
  stageWillCallPackage,
} from "../api";
import type {
  DevUser,
  PaymentMethod,
  PickupFulfillmentMode,
  PickupIdentityMethod,
  PosQuote,
  PrescriptionQueueItem,
  WillCallEvent,
  WillCallPackage,
} from "../types";
import {
  canProcess,
  canSell,
  formatPatientName,
  readyFill,
} from "../workflow";

type CheckoutState = {
  fillId: string;
  quote: PosQuote;
  method: PaymentMethod;
  amount: string;
  reference: string;
  pickupFulfillmentMode: PickupFulfillmentMode;
  bagBarcode: string;
  recipientName: string;
  relationship: string;
  identityMethod: PickupIdentityMethod;
  identityValue: string;
  signatureName: string;
};

type StagingMode = "STAGE" | "RELOCATE" | "REBAG";

type StagingState = {
  fillId: string;
  mode: StagingMode;
  bagBarcode: string;
  locationBarcode: string;
};

type HistoryState = {
  fillId: string;
  events: WillCallEvent[];
};

function money(value: string | number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : "$0.00";
}

function basisLabel(basis: PosQuote["lines"][number]["priceBasis"]) {
  if (basis === "THIRD_PARTY") return "Final patient responsibility";
  if (basis === "COMPLETION_ALREADY_BILLED") {
    return "Already billed on primary fill";
  }
  return "Cash price";
}

function readyAge(value: Date | null) {
  if (!value) return "—";
  const ms = Math.max(0, Date.now() - value.getTime());
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "Less than 1 hour";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function historyLabel(event: WillCallEvent) {
  if (event.eventType === "STAGED") return "Staged";
  if (event.eventType === "RELOCATED") return "Moved";
  if (event.eventType === "REBAGGED") return "Bag replaced";
  if (event.eventType === "PICKED_UP") return "Picked up";
  return "Returned to stock";
}

export function WillCall({
  prescriptions,
  devUser,
  user,
  loading,
  onOpen,
  onMutated,
  onError,
}: {
  prescriptions: PrescriptionQueueItem[];
  devUser: string;
  user?: DevUser;
  loading: boolean;
  onOpen: (id: string) => void;
  onMutated: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [checkout, setCheckout] = useState<CheckoutState | null>(null);
  const [staging, setStaging] = useState<StagingState | null>(null);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [scanBarcode, setScanBarcode] = useState("");
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [locationScanPackages, setLocationScanPackages] = useState<
    WillCallPackage[]
  >([]);

  const workstationScanRef = useRef<HTMLInputElement>(null);
  const stagingBagRef = useRef<HTMLInputElement>(null);
  const stagingLocationRef = useRef<HTMLInputElement>(null);

  function focusWorkstationScanner() {
    window.setTimeout(() => workstationScanRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!checkout && !staging) {
      focusWorkstationScanner();
    }
  }, [checkout, staging]);

  useEffect(() => {
    if (!staging) return;
    window.setTimeout(() => {
      if (staging.mode === "RELOCATE") {
        stagingLocationRef.current?.focus();
      } else {
        stagingBagRef.current?.focus();
      }
    }, 0);
  }, [staging?.fillId, staging?.mode]);

  async function completeStaging() {
    if (!staging) return;

    setCheckoutBusy(true);
    onError(null);
    try {
      if (staging.mode === "STAGE") {
        const result = await stageWillCallPackage(devUser, staging.fillId, {
          bagBarcode: staging.bagBarcode.trim() || null,
          locationBarcode: staging.locationBarcode.trim() || null,
        });
        await onMutated(
          `Will Call package staged as ${result.package.bagBarcode} in ${result.package.location.code}.`,
        );
      } else if (staging.mode === "REBAG") {
        const nextBag = staging.bagBarcode.trim();
        if (!nextBag) {
          onError("Scan the replacement bag barcode.");
          return;
        }
        const result = await rebagWillCallPackage(
          devUser,
          staging.fillId,
          nextBag,
        );
        await onMutated(
          `Bag replaced. Current bag is ${result.package.bagBarcode}.`,
        );
      } else {
        const nextLocation = staging.locationBarcode.trim();
        if (!nextLocation) {
          onError("Scan the destination Will Call bin/location barcode.");
          return;
        }
        const result = await relocateWillCallPackage(devUser, staging.fillId, {
          locationBarcode: nextLocation,
        });
        await onMutated(
          `Will Call package moved to ${result.package.location.code}.`,
        );
      }

      setStaging(null);
      setHistory(null);
      setScanMessage(null);
      setLocationScanPackages([]);
      focusWorkstationScanner();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to update the Will Call package.",
      );
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function beginCheckout(
    rx: PrescriptionQueueItem,
    pickupFulfillmentMode: PickupFulfillmentMode,
    scannedBagBarcode = "",
  ) {
    const fill = readyFill(rx.fills);
    if (!fill) return;
    if (
      pickupFulfillmentMode === "WILL_CALL" &&
      (!fill.willCallPackage || fill.willCallPackage.status !== "STAGED")
    ) {
      onError("Stage the prescription in a Will Call location before checkout.");
      return;
    }
    if (pickupFulfillmentMode === "IMMEDIATE" && fill.willCallPackage) {
      onError(
        "This prescription is already staged in Will Call. Use the staged bag checkout instead.",
      );
      return;
    }

    setCheckoutBusy(true);
    onError(null);
    try {
      const quote = await quotePosCheckout(
        devUser,
        [fill.id],
        pickupFulfillmentMode,
      );
      const due = String(quote.totalDue);
      setCheckout({
        fillId: fill.id,
        quote,
        method: "CARD",
        amount: Number(due).toFixed(2),
        reference: "",
        pickupFulfillmentMode,
        bagBarcode: scannedBagBarcode,
        recipientName: formatPatientName(rx.patient),
        relationship: "Self",
        identityMethod: rx.patient.dateOfBirth
          ? "DATE_OF_BIRTH"
          : "KNOWN_PATIENT",
        identityValue: "",
        signatureName: "",
      });
      setStaging(null);
      setScanMessage(null);
      setLocationScanPackages([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to quote pickup.");
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function handleWorkstationScan() {
    const barcode = scanBarcode.trim();
    if (!barcode) return;

    setCheckoutBusy(true);
    onError(null);
    setScanMessage(null);
    setLocationScanPackages([]);
    try {
      const result = await scanWillCallBarcode(devUser, barcode);
      setScanBarcode("");

      if (result.scanType === "BAG") {
        const scannedPackage = result.packages[0];
        const rx = prescriptions.find(
          (item) => readyFill(item.fills)?.id === scannedPackage?.fillId,
        );
        if (!rx || !scannedPackage) {
          onError(
            "The bag is staged, but its Ready prescription is not present in the current Will Call view.",
          );
          focusWorkstationScanner();
          return;
        }
        setCheckoutBusy(false);
        await beginCheckout(rx, "WILL_CALL", barcode.toUpperCase());
        return;
      }

      setLocationScanPackages(result.packages);
      setScanMessage(
        `Location scan found ${result.packages.length} staged prescription${result.packages.length === 1 ? "" : "s"}.`,
      );
      focusWorkstationScanner();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to resolve the Will Call barcode.",
      );
      focusWorkstationScanner();
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function toggleHistory(fillId: string) {
    if (history?.fillId === fillId) {
      setHistory(null);
      focusWorkstationScanner();
      return;
    }
    setCheckoutBusy(true);
    onError(null);
    try {
      const events = await getWillCallHistory(devUser, fillId);
      setHistory({ fillId, events });
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load Will Call history.",
      );
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function completeCheckout() {
    if (!checkout) return;
    const totalDue = Number(checkout.quote.totalDue);
    const tenderAmount = Number(checkout.amount);

    if (
      checkout.pickupFulfillmentMode === "WILL_CALL" &&
      !checkout.bagBarcode.trim()
    ) {
      onError("Scan or enter the Will Call bag barcode.");
      return;
    }
    if (!checkout.recipientName.trim()) {
      onError("Enter the name of the person receiving the prescription.");
      return;
    }
    if (
      checkout.identityMethod === "DATE_OF_BIRTH" &&
      !checkout.identityValue.trim()
    ) {
      onError("Enter the patient's date of birth to verify pickup identity.");
      return;
    }
    if (!checkout.signatureName.trim()) {
      onError("A pickup signature is required.");
      return;
    }
    if (totalDue > 0 && (!Number.isFinite(tenderAmount) || tenderAmount <= 0)) {
      onError("Enter a valid payment amount.");
      return;
    }

    setCheckoutBusy(true);
    onError(null);
    try {
      const result = await checkoutPos(devUser, {
        fillIds: [checkout.fillId],
        tenders:
          totalDue > 0
            ? [
                {
                  method: checkout.method,
                  amount: checkout.amount,
                  reference: checkout.reference.trim() || null,
                },
              ]
            : [],
        pickupPackages:
          checkout.pickupFulfillmentMode === "WILL_CALL"
            ? [
                {
                  fillId: checkout.fillId,
                  bagBarcode: checkout.bagBarcode,
                },
              ]
            : [],
        pickupFulfillmentMode: checkout.pickupFulfillmentMode,
        pickup: {
          recipientName: checkout.recipientName,
          relationship: checkout.relationship.trim() || null,
          identityMethod: checkout.identityMethod,
          identityValue: checkout.identityValue.trim() || null,
          signatureMethod: "ELECTRONIC_TYPED",
          signatureName: checkout.signatureName,
        },
        idempotencyKey:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `pos-${checkout.fillId}-${Date.now()}`,
      });

      const change = Number(result.transaction.changeDue);
      const changeText = change > 0 ? ` Change due ${money(change)}.` : "";
      setCheckout(null);
      setHistory(null);
      await onMutated(
        `Pickup completed. Receipt ${result.transaction.receiptNumber}.${changeText}`,
      );
      focusWorkstationScanner();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to complete pickup.");
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function returnToStock(rx: PrescriptionQueueItem) {
    const fill = readyFill(rx.fills);
    if (!fill) return;

    setCheckoutBusy(true);
    try {
      await returnFillToStock(devUser, fill.id);
      if (checkout?.fillId === fill.id) setCheckout(null);
      if (staging?.fillId === fill.id) setStaging(null);
      if (history?.fillId === fill.id) setHistory(null);
      await onMutated(
        "Prescription returned to stock and removed from Will Call. Any active paid claim was reversed before the stock return.",
      );
      focusWorkstationScanner();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to return fill to stock.");
    } finally {
      setCheckoutBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Ready for pickup</p>
          <h2>Will Call / POS</h2>
        </div>
        <span className="queue-count">
          {prescriptions.length} prescription{prescriptions.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="detail-card">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Scanner ready</p>
            <h3>Scan bag or Will Call bin</h3>
          </div>
          <span className="status">F3 scan-first</span>
        </div>
        <div className="form-grid">
          <label>
            Will Call barcode
            <input
              ref={workstationScanRef}
              value={scanBarcode}
              onChange={(event) => setScanBarcode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleWorkstationScan();
                }
              }}
              placeholder="Scan staged bag or bin barcode"
              autoComplete="off"
            />
          </label>
        </div>
        {scanMessage && <p className="muted">{scanMessage}</p>}
        {locationScanPackages.length > 0 && (
          <div className="will-call-grid">
            {locationScanPackages.map((item) => {
              const rx = prescriptions.find(
                (candidate) => readyFill(candidate.fills)?.id === item.fillId,
              );
              return (
                <div className="detail-card" key={item.id}>
                  <div>
                    <strong>{rx ? formatPatientName(rx.patient) : item.fillId}</strong>
                    <p className="muted">
                      {rx
                        ? `${rx.medicationName} ${rx.strength ?? ""}`
                        : `Fill ${item.fillId}`}
                    </p>
                    <span className="mono">{item.bagBarcode}</span>
                  </div>
                  {rx && (
                    <div className="action-row">
                      <button
                        className="primary-button"
                        disabled={checkoutBusy || loading}
                        onClick={() =>
                          void beginCheckout(rx, "WILL_CALL", item.bagBarcode)
                        }
                      >
                        Open Pickup
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="will-call-grid">
        {prescriptions.map((rx) => {
          const fill = readyFill(rx.fills);
          const readySince = fill?.filledAt ? new Date(fill.filledAt) : null;
          const willCallPackage = fill?.willCallPackage ?? null;
          const activeCheckout =
            fill && checkout?.fillId === fill.id ? checkout : null;
          const activeStaging =
            fill && staging?.fillId === fill.id ? staging : null;
          const activeHistory =
            fill && history?.fillId === fill.id ? history.events : null;
          const quoteLine = activeCheckout?.quote.lines[0];

          return (
            <article className="will-call-card" key={rx.id}>
              <div className="will-call-main">
                <div>
                  <span className="mono">{rx.rxNumber ?? "Pending Rx"}</span>
                  <h3>{formatPatientName(rx.patient)}</h3>
                  <p>{rx.medicationName} {rx.strength ?? ""}</p>
                </div>
                <span className="status status-ready">
                  {willCallPackage?.status === "STAGED" ? "Staged" : "Ready"}
                </span>
              </div>

              <dl className="will-call-meta">
                <div><dt>Fill</dt><dd>#{fill?.fillNumber ?? "—"}</dd></div>
                <div><dt>Quantity</dt><dd>{String(fill?.quantity ?? rx.quantityWritten ?? "—")}</dd></div>
                <div><dt>Ready since</dt><dd>{readySince ? readySince.toLocaleString() : "—"}</dd></div>
                <div><dt>Ready age</dt><dd>{readyAge(readySince)}</dd></div>
                <div>
                  <dt>Bag</dt>
                  <dd className="mono">{willCallPackage?.bagBarcode ?? "Not staged"}</dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>
                    {willCallPackage
                      ? `${willCallPackage.location.code} — ${willCallPackage.location.name}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Location barcode</dt>
                  <dd className="mono">
                    {willCallPackage?.location.barcode ?? "—"}
                  </dd>
                </div>
              </dl>

              {activeStaging && (
                <div className="detail-card">
                  <p className="eyebrow">
                    {activeStaging.mode === "STAGE"
                      ? "Scan-first Will Call staging"
                      : activeStaging.mode === "REBAG"
                        ? "Replace physical bag"
                        : "Move Will Call location"}
                  </p>

                  {activeStaging.mode !== "RELOCATE" && (
                    <label>
                      {activeStaging.mode === "REBAG"
                        ? "Scan replacement bag barcode"
                        : "1. Scan bag barcode"}
                      <input
                        ref={stagingBagRef}
                        value={activeStaging.bagBarcode}
                        onChange={(event) =>
                          setStaging((current) =>
                            current
                              ? { ...current, bagBarcode: event.target.value }
                              : current,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          if (activeStaging.mode === "REBAG") {
                            void completeStaging();
                          } else {
                            stagingLocationRef.current?.focus();
                          }
                        }}
                        placeholder={
                          activeStaging.mode === "REBAG"
                            ? "New physical bag barcode"
                            : "Leave blank only to generate a system bag ID"
                        }
                        autoComplete="off"
                      />
                    </label>
                  )}

                  {activeStaging.mode !== "REBAG" && (
                    <label>
                      {activeStaging.mode === "STAGE"
                        ? "2. Scan bin / location barcode"
                        : "Scan destination bin / location barcode"}
                      <input
                        ref={stagingLocationRef}
                        value={activeStaging.locationBarcode}
                        onChange={(event) =>
                          setStaging((current) =>
                            current
                              ? { ...current, locationBarcode: event.target.value }
                              : current,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void completeStaging();
                          }
                        }}
                        placeholder={
                          activeStaging.mode === "STAGE"
                            ? "Blank uses default Will Call"
                            : "Destination location barcode required"
                        }
                        autoComplete="off"
                      />
                    </label>
                  )}

                  <p className="muted">
                    Barcode scanners that send Enter can complete this workflow
                    without mouse input.
                  </p>
                  <div className="action-row">
                    <button
                      className="primary-button"
                      disabled={checkoutBusy || loading}
                      onClick={() => void completeStaging()}
                    >
                      {activeStaging.mode === "STAGE"
                        ? "Confirm Staging"
                        : activeStaging.mode === "REBAG"
                          ? "Confirm New Bag"
                          : "Confirm Move"}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={checkoutBusy || loading}
                      onClick={() => {
                        setStaging(null);
                        focusWorkstationScanner();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {activeHistory && (
                <div className="detail-card">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">Physical custody history</p>
                      <h3>Will Call events</h3>
                    </div>
                    <span className="queue-count">{activeHistory.length}</span>
                  </div>
                  {activeHistory.map((event) => (
                    <div className="will-call-meta" key={event.id}>
                      <div>
                        <dt>Event</dt>
                        <dd>{historyLabel(event)}</dd>
                      </div>
                      <div>
                        <dt>When</dt>
                        <dd>{new Date(event.occurredAt).toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Staff</dt>
                        <dd>{event.actor?.displayName ?? "—"}</dd>
                      </div>
                      {event.oldBagBarcode && (
                        <div>
                          <dt>Prior bag</dt>
                          <dd className="mono">{event.oldBagBarcode}</dd>
                        </div>
                      )}
                      {event.newBagBarcode && (
                        <div>
                          <dt>New bag</dt>
                          <dd className="mono">{event.newBagBarcode}</dd>
                        </div>
                      )}
                      {event.fromLocation && (
                        <div>
                          <dt>From</dt>
                          <dd>{event.fromLocation.code}</dd>
                        </div>
                      )}
                      {event.toLocation && (
                        <div>
                          <dt>To</dt>
                          <dd>{event.toLocation.code}</dd>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {activeCheckout && quoteLine && (
                <div className="detail-card">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">Controlled pickup</p>
                      <h3>{money(activeCheckout.quote.totalDue)} due</h3>
                    </div>
                    <span className="status">
                      {basisLabel(quoteLine.priceBasis)}
                    </span>
                  </div>

                  <dl className="will-call-meta">
                    <div>
                      <dt>Pricing basis</dt>
                      <dd>{basisLabel(quoteLine.priceBasis)}</dd>
                    </div>
                    <div>
                      <dt>Patient amount</dt>
                      <dd>{money(quoteLine.amountDue)}</dd>
                    </div>
                    <div>
                      <dt>Pickup path</dt>
                      <dd>
                        {activeCheckout.pickupFulfillmentMode === "IMMEDIATE"
                          ? "Immediate — patient waiting"
                          : "Will Call"}
                      </dd>
                    </div>
                    {activeCheckout.pickupFulfillmentMode === "WILL_CALL" && (
                      <div>
                        <dt>Expected location</dt>
                        <dd>{quoteLine.willCallLocationCode}</dd>
                      </div>
                    )}
                  </dl>

                  {activeCheckout.pickupFulfillmentMode === "IMMEDIATE" && (
                    <p className="muted">
                      Patient waiting: this verified prescription will be handed
                      directly to the recipient. No Will Call bag or bin staging
                      is required.
                    </p>
                  )}

                  <div className="form-grid">
                    {activeCheckout.pickupFulfillmentMode === "WILL_CALL" && (
                      <label>
                        Scan Will Call bag
                        <input
                          value={activeCheckout.bagBarcode}
                          onChange={(event) =>
                            setCheckout((current) =>
                              current
                                ? { ...current, bagBarcode: event.target.value }
                                : current,
                            )
                          }
                          placeholder={quoteLine.bagBarcode ?? ""}
                          autoFocus={!activeCheckout.bagBarcode}
                        />
                      </label>
                    )}
                    <label>
                      Pickup recipient
                      <input
                        value={activeCheckout.recipientName}
                        onChange={(event) =>
                          setCheckout((current) =>
                            current
                              ? { ...current, recipientName: event.target.value }
                              : current,
                          )
                        }
                      />
                    </label>
                    <label>
                      Relationship
                      <input
                        value={activeCheckout.relationship}
                        onChange={(event) =>
                          setCheckout((current) =>
                            current
                              ? { ...current, relationship: event.target.value }
                              : current,
                          )
                        }
                        placeholder="Self, caregiver, parent..."
                      />
                    </label>
                    <label>
                      Identity verification
                      <select
                        value={activeCheckout.identityMethod}
                        onChange={(event) =>
                          setCheckout((current) =>
                            current
                              ? {
                                  ...current,
                                  identityMethod:
                                    event.target.value as PickupIdentityMethod,
                                  identityValue: "",
                                }
                              : current,
                          )
                        }
                      >
                        <option value="DATE_OF_BIRTH">Date of birth</option>
                        <option value="ADDRESS">Address</option>
                        <option value="GOVERNMENT_ID">Government ID checked</option>
                        <option value="KNOWN_PATIENT">Known patient</option>
                        <option value="OTHER">Other verified method</option>
                      </select>
                    </label>
                    {activeCheckout.identityMethod === "DATE_OF_BIRTH" && (
                      <label>
                        Patient date of birth
                        <input
                          type="date"
                          value={activeCheckout.identityValue}
                          onChange={(event) =>
                            setCheckout((current) =>
                              current
                                ? { ...current, identityValue: event.target.value }
                                : current,
                            )
                          }
                        />
                      </label>
                    )}
                    <label>
                      Electronic signature
                      <input
                        value={activeCheckout.signatureName}
                        onChange={(event) =>
                          setCheckout((current) =>
                            current
                              ? { ...current, signatureName: event.target.value }
                              : current,
                          )
                        }
                        placeholder="Signer types full name"
                      />
                    </label>
                  </div>

                  {Number(activeCheckout.quote.totalDue) > 0 && (
                    <div className="form-grid">
                      <label>
                        Payment method
                        <select
                          value={activeCheckout.method}
                          onChange={(event) =>
                            setCheckout((current) =>
                              current
                                ? {
                                    ...current,
                                    method: event.target.value as PaymentMethod,
                                  }
                                : current,
                            )
                          }
                        >
                          <option value="CARD">Card</option>
                          <option value="CASH">Cash</option>
                          <option value="CHECK">Check</option>
                          <option value="OTHER">Other</option>
                        </select>
                      </label>
                      <label>
                        Amount tendered
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={activeCheckout.amount}
                          onChange={(event) =>
                            setCheckout((current) =>
                              current
                                ? { ...current, amount: event.target.value }
                                : current,
                            )
                          }
                        />
                      </label>
                      <label>
                        Payment reference (optional)
                        <input
                          value={activeCheckout.reference}
                          onChange={(event) =>
                            setCheckout((current) =>
                              current
                                ? { ...current, reference: event.target.value }
                                : current,
                            )
                          }
                          placeholder="Last 4 / check / external ref"
                        />
                      </label>
                    </div>
                  )}

                  {Number(activeCheckout.quote.totalDue) === 0 && (
                    <p className="muted">
                      No tender is required. Identity verification and signature
                      are still required to record pickup.
                    </p>
                  )}

                  <div className="action-row">
                    <button
                      className="primary-button"
                      disabled={checkoutBusy || loading}
                      onClick={() => void completeCheckout()}
                    >
                      Confirm Pickup
                    </button>
                    <button
                      className="secondary-button"
                      disabled={checkoutBusy || loading}
                      onClick={() => {
                        setCheckout(null);
                        focusWorkstationScanner();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="action-row">
                <button className="secondary-button" onClick={() => onOpen(rx.id)}>
                  Open
                </button>
                {willCallPackage?.status !== "STAGED" ? (
                  <>
                    <button
                      className="secondary-button"
                      disabled={
                        !canProcess(user) ||
                        loading ||
                        checkoutBusy ||
                        !fill ||
                        Boolean(activeCheckout)
                      }
                      onClick={() =>
                        fill &&
                        setStaging({
                          fillId: fill.id,
                          mode: "STAGE",
                          bagBarcode: "",
                          locationBarcode: "",
                        })
                      }
                    >
                      Stage Bag
                    </button>
                    <button
                      className="primary-button"
                      disabled={!canSell(user) || loading || checkoutBusy || !fill}
                      onClick={() => void beginCheckout(rx, "IMMEDIATE")}
                    >
                      Patient Waiting — Pickup Now
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="secondary-button"
                      disabled={
                        !canProcess(user) ||
                        loading ||
                        checkoutBusy ||
                        !fill ||
                        Boolean(activeCheckout)
                      }
                      onClick={() =>
                        fill &&
                        setStaging({
                          fillId: fill.id,
                          mode: "RELOCATE",
                          bagBarcode: "",
                          locationBarcode: "",
                        })
                      }
                    >
                      Move Bin
                    </button>
                    <button
                      className="secondary-button"
                      disabled={
                        !canProcess(user) ||
                        loading ||
                        checkoutBusy ||
                        !fill ||
                        Boolean(activeCheckout)
                      }
                      onClick={() =>
                        fill &&
                        setStaging({
                          fillId: fill.id,
                          mode: "REBAG",
                          bagBarcode: "",
                          locationBarcode: "",
                        })
                      }
                    >
                      Replace Bag
                    </button>
                    <button
                      className="secondary-button"
                      disabled={checkoutBusy || loading || !fill}
                      onClick={() => fill && void toggleHistory(fill.id)}
                    >
                      {activeHistory ? "Hide History" : "History"}
                    </button>
                    <button
                      className="primary-button"
                      disabled={!canSell(user) || loading || checkoutBusy || !fill}
                      onClick={() => void beginCheckout(rx, "WILL_CALL")}
                    >
                      Checkout
                    </button>
                  </>
                )}
                <button
                  className="secondary-button"
                  disabled={
                    !canProcess(user) ||
                    !fill ||
                    loading ||
                    checkoutBusy ||
                    Boolean(activeCheckout)
                  }
                  onClick={() =>
                    window.confirm(
                      "Return this Ready fill to stock? Any active paid claim will be reversed before inventory is returned.",
                    ) && void returnToStock(rx)
                  }
                >
                  Return to Stock
                </button>
              </div>
            </article>
          );
        })}

        {prescriptions.length === 0 && (
          <div className="empty-state will-call-empty">
            No prescriptions are currently waiting in Will Call.
          </div>
        )}
      </div>
    </section>
  );
}
