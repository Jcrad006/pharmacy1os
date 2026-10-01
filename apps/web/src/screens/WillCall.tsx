import { useState } from "react";
import {
  checkoutPos,
  quotePosCheckout,
  returnFillToStock,
} from "../api";
import type {
  DevUser,
  PaymentMethod,
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
};

function money(value: string | number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : "$0.00";
}

function basisLabel(basis: PosQuote["lines"][number]["priceBasis"]) {
  if (basis === "THIRD_PARTY") return "Final patient responsibility";
  if (basis === "COMPLETION_ALREADY_BILLED") return "Already billed on primary fill";
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
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  async function beginCheckout(rx: PrescriptionQueueItem) {
    const fill = readyFill(rx.fills);
    if (!fill) return;

    setCheckoutBusy(true);
    onError(null);
    try {
      const quote = await quotePosCheckout(devUser, [fill.id]);
      const due = String(quote.totalDue);
      setCheckout({
        fillId: fill.id,
        quote,
        method: "CARD",
        amount: Number(due).toFixed(2),
        reference: "",
      });
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

    try {
      await returnFillToStock(devUser, fill.id);
      if (checkout?.fillId === fill.id) setCheckout(null);
      await onMutated("Prescription returned to stock and removed from Will Call.");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to return fill to stock.");
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
          const activeCheckout =
            fill && checkout?.fillId === fill.id ? checkout : null;
          const quoteLine = activeCheckout?.quote.lines[0];

          return (
            <article className="will-call-card" key={rx.id}>
              <div className="will-call-main">
                <div>
                  <span className="mono">{rx.rxNumber ?? "Pending Rx"}</span>
                  <h3>{formatPatientName(rx.patient)}</h3>
                  <p>{rx.medicationName} {rx.strength ?? ""}</p>
                </div>
                <span className="status status-ready">Ready</span>
              </div>

              <dl className="will-call-meta">
                <div><dt>Fill</dt><dd>#{fill?.fillNumber ?? "—"}</dd></div>
                <div><dt>Quantity</dt><dd>{String(fill?.quantity ?? rx.quantityWritten ?? "—")}</dd></div>
                <div><dt>Ready since</dt><dd>{readySince ? readySince.toLocaleString() : "—"}</dd></div>
              </dl>

              {activeCheckout && quoteLine && (
                <div className="detail-card">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">Pickup quote</p>
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
                      <dt>Receipt status</dt>
                      <dd>Pending payment</dd>
                    </div>
                  </dl>

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
                        Reference (optional)
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
                      No tender is required. Confirm pickup to record the $0 transaction.
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
                <button
                  className="primary-button"
                  disabled={!canSell(user) || loading || checkoutBusy || !fill}
                  onClick={() => void beginCheckout(rx)}
                >
                  Checkout
                </button>
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
                    window.confirm("Return this ready synthetic fill to stock?") &&
                    void returnToStock(rx)
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
