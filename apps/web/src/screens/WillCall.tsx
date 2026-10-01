import { useState } from "react";
import {
  checkoutPos,
  quotePosCheckout,
  returnFillToStock,
  stageWillCallPackage,
} from "../api";
import type {
  DevUser,
  PaymentMethod,
  PickupFulfillmentMode,
  PickupIdentityMethod,
  PosQuote,
  PrescriptionQueueItem,
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

type StagingState = {
  fillId: string;
  bagBarcode: string;
  locationBarcode: string;
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
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  async function completeStaging() {
    if (!staging) return;

    setCheckoutBusy(true);
    onError(null);
    try {
      const result = await stageWillCallPackage(devUser, staging.fillId, {
        bagBarcode: staging.bagBarcode.trim() || null,
        locationBarcode: staging.locationBarcode.trim() || null,
      });
      setStaging(null);
      await onMutated(
        `Will Call package staged as ${result.package.bagBarcode} in ${result.package.location.code}.`,
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to stage Will Call package.");
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function beginCheckout(
    rx: PrescriptionQueueItem,
    pickupFulfillmentMode: PickupFulfillmentMode,
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
        bagBarcode: "",
        recipientName: formatPatientName(rx.patient),
        relationship: "Self",
        identityMethod: rx.patient.dateOfBirth
          ? "DATE_OF_BIRTH"
          : "KNOWN_PATIENT",
        identityValue: "",
        signatureName: "",
      });
      setStaging(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to quote pickup.");
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
      await onMutated(
        `Pickup completed. Receipt ${result.transaction.receiptNumber}.${changeText}`,
      );
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
      await onMutated(
        "Prescription returned to stock and removed from Will Call. Any active paid claim was reversed before the stock return.",
      );
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

      <div className="will-call-grid">
        {prescriptions.map((rx) => {
          const fill = readyFill(rx.fills);
          const readySince = fill?.filledAt ? new Date(fill.filledAt) : null;
          const willCallPackage = fill?.willCallPackage ?? null;
          const activeCheckout =
            fill && checkout?.fillId === fill.id ? checkout : null;
          const activeStaging =
            fill && staging?.fillId === fill.id ? staging : null;
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
                  <p className="eyebrow">Physical Will Call staging</p>
                  <div className="form-grid">
                    <label>
                      Bag barcode
                      <input
                        value={activeStaging.bagBarcode}
                        onChange={(event) =>
                          setStaging((current) =>
                            current
                              ? { ...current, bagBarcode: event.target.value }
                              : current,
                          )
                        }
                        placeholder="Leave blank to generate"
                        autoFocus
                      />
                    </label>
                    <label>
                      Bin / location barcode
                      <input
                        value={activeStaging.locationBarcode}
                        onChange={(event) =>
                          setStaging((current) =>
                            current
                              ? { ...current, locationBarcode: event.target.value }
                              : current,
                          )
                        }
                        placeholder="Leave blank for default Will Call"
                      />
                    </label>
                  </div>
                  <div className="action-row">
                    <button
                      className="primary-button"
                      disabled={checkoutBusy || loading}
                      onClick={() => void completeStaging()}
                    >
                      Confirm Staging
                    </button>
                    <button
                      className="secondary-button"
                      disabled={checkoutBusy || loading}
                      onClick={() => setStaging(null)}
                    >
                      Cancel
                    </button>
                  </div>
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
                          autoFocus
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
                      onClick={() => setCheckout(null)}
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
                          bagBarcode: willCallPackage.bagBarcode,
                          locationBarcode: willCallPackage.location.barcode ?? "",
                        })
                      }
                    >
                      Relocate
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
