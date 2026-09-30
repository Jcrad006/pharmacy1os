import { returnFillToStock, transitionPrescription } from "../api";
import type { DevUser, PrescriptionQueueItem } from "../types";
import {
  canProcess,
  canSell,
  formatPatientName,
  readyFill,
} from "../workflow";

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
  async function sell(rx: PrescriptionQueueItem) {
    try {
      await transitionPrescription(devUser, rx.id, "SOLD");
      await onMutated("Prescription marked sold from Will Call.");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to mark sold.");
    }
  }

  async function returnToStock(rx: PrescriptionQueueItem) {
    const fill = readyFill(rx.fills);
    if (!fill) return;

    try {
      await returnFillToStock(devUser, fill.id);
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
          <h2>Will Call</h2>
        </div>
        <span className="queue-count">{prescriptions.length} prescription{prescriptions.length === 1 ? "" : "s"}</span>
      </div>

      <div className="will-call-grid">
        {prescriptions.map((rx) => {
          const fill = readyFill(rx.fills);
          const readySince = fill?.filledAt ? new Date(fill.filledAt) : null;
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

              <div className="action-row">
                <button className="secondary-button" onClick={() => onOpen(rx.id)}>Open</button>
                <button
                  className="primary-button"
                  disabled={!canSell(user) || loading}
                  onClick={() => void sell(rx)}
                >
                  Mark Sold
                </button>
                <button
                  className="secondary-button"
                  disabled={!canProcess(user) || !fill || loading}
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
