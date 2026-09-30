import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createFill,
  getPrescription,
  getPrescriptionAudit,
  startFill,
  transitionPrescription,
} from "../api";
import type {
  AuditEvent,
  DevUser,
  PrescriptionQueueItem,
  PrescriptionStatus,
} from "../types";
import {
  activeFill,
  canProcess,
  canReadAudit,
  canSell,
  canVerify,
  formatPatientName,
  formatPrescriberName,
  remainingRefills,
  statusLabels,
} from "../workflow";

export function PrescriptionDetail({
  prescriptionId,
  devUser,
  user,
  onBack,
  onMutated,
  onError,
}: {
  prescriptionId: string;
  devUser: string;
  user?: DevUser;
  onBack: () => void;
  onMutated: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [rx, setRx] = useState<PrescriptionQueueItem | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");

  async function load() {
    if (!devUser) return;
    setLoading(true);
    try {
      const next = await getPrescription(devUser, prescriptionId);
      setRx(next);
      setQuantity(String(next.quantityWritten ?? ""));
      if (canReadAudit(user)) {
        setAudit(await getPrescriptionAudit(devUser, prescriptionId));
      } else {
        setAudit([]);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to load prescription.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [prescriptionId, devUser, user?.role]);

  const currentFill = useMemo(() => (rx ? activeFill(rx.fills) : undefined), [rx]);

  async function transition(status: PrescriptionStatus, successMessage: string) {
    if (!rx) return;
    setLoading(true);
    onError(null);
    try {
      await transitionPrescription(devUser, rx.id, status);
      await onMutated(successMessage);
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Workflow update failed.");
      setLoading(false);
    }
  }

  async function submitFill(event: FormEvent) {
    event.preventDefault();
    if (!rx) return;
    setLoading(true);
    onError(null);
    try {
      const result = await createFill(devUser, rx.id, {
        quantity: quantity ? Number(quantity) : undefined,
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
      });
      await onMutated(
        result.fill.status === "SCHEDULED"
          ? "Future fill scheduled."
          : "Fill created and moved to Product Fill.",
      );
      setScheduledFor("");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create fill.");
      setLoading(false);
    }
  }

  async function beginScheduledFill(fillId: string) {
    setLoading(true);
    onError(null);
    try {
      await startFill(devUser, fillId);
      await onMutated("Scheduled fill started.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to start fill.");
      setLoading(false);
    }
  }

  if (!rx) {
    return <section className="panel"><p>{loading ? "Loading prescription…" : "Prescription not available."}</p></section>;
  }

  const processAllowed = canProcess(user);
  const verifyAllowed = canVerify(user);
  const sellAllowed = canSell(user);
  const refillBalance = remainingRefills(rx.refillsAllowed, rx.refillsUsed);
  const scheduledCanStart =
    currentFill?.status === "SCHEDULED" &&
    (!currentFill.scheduledFor || new Date(currentFill.scheduledFor).getTime() <= Date.now());

  return (
    <div className="detail-stack">
      <div className="detail-toolbar">
        <button className="secondary-button" onClick={onBack}>← Queue</button>
        <div className="action-row">
          {rx.allowedTransitions.includes("ON_HOLD") && processAllowed && (
            <button className="secondary-button" disabled={loading} onClick={() => void transition("ON_HOLD", "Prescription placed on hold.")}>Hold</button>
          )}
          {rx.allowedTransitions.includes("CANCELLED") && processAllowed && (
            <button className="danger-button" disabled={loading} onClick={() => window.confirm("Cancel this synthetic prescription?") && void transition("CANCELLED", "Prescription cancelled.")}>Cancel</button>
          )}
          {rx.allowedTransitions.includes("TRANSFERRED") && processAllowed && (
            <button className="secondary-button" disabled={loading} onClick={() => window.confirm("Mark this synthetic prescription transferred?") && void transition("TRANSFERRED", "Prescription marked transferred.")}>Transfer</button>
          )}
        </div>
      </div>

      <section className="detail-hero panel">
        <div>
          <p className="eyebrow">Prescription {rx.rxNumber ?? "Pending number"}</p>
          <h2>{rx.medicationName} {rx.strength ?? ""}</h2>
          <p className="detail-sig">{rx.sig}</p>
        </div>
        <span className={`status large-status status-${rx.status.toLowerCase()}`}>{statusLabels[rx.status]}</span>
      </section>

      <div className="detail-grid">
        <section className="panel">
          <p className="eyebrow">Patient</p>
          <h3>{formatPatientName(rx.patient)}</h3>
          <dl className="detail-list">
            <div><dt>DOB</dt><dd>{rx.patient.dateOfBirth ? new Date(rx.patient.dateOfBirth).toLocaleDateString() : "—"}</dd></div>
            <div><dt>Phone</dt><dd>{rx.patient.phone ?? "—"}</dd></div>
          </dl>
        </section>

        <section className="panel">
          <p className="eyebrow">Prescriber</p>
          <h3>{formatPrescriberName(rx.prescriber)}</h3>
          <dl className="detail-list">
            <div><dt>NPI</dt><dd>{rx.prescriber.npi ?? "—"}</dd></div>
            <div><dt>Phone</dt><dd>{rx.prescriber.phone ?? "—"}</dd></div>
          </dl>
        </section>

        <section className="panel">
          <p className="eyebrow">Refill status</p>
          <h3>{refillBalance} refill{refillBalance === 1 ? "" : "s"} remaining</h3>
          <dl className="detail-list">
            <div><dt>Used</dt><dd>{rx.refillsUsed}</dd></div>
            <div><dt>Authorized</dt><dd>{rx.refillsAllowed}</dd></div>
            <div><dt>Quantity</dt><dd>{String(rx.quantityWritten ?? "—")}</dd></div>
          </dl>
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Dispensing workflow</p><h2>Current action</h2></div>
        </div>

        <div className="workflow-action">
          {rx.status === "DATA_ENTRY" && (
            <button className="primary-button" disabled={!processAllowed || loading} onClick={() => void transition("DUR_REVIEW", "Prescription moved to DUR Review.")}>Complete data entry → DUR Review</button>
          )}

          {rx.status === "DUR_REVIEW" && !currentFill && (
            <form className="inline-fill-form" onSubmit={submitFill}>
              <label>Quantity<input type="number" min="0" step="0.001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
              <label>Schedule for later (optional)<input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} /></label>
              <button className="primary-button" type="submit" disabled={!processAllowed || loading}>
                {scheduledFor ? "Schedule fill" : "Create fill now"}
              </button>
            </form>
          )}

          {rx.status === "DUR_REVIEW" && currentFill?.status === "SCHEDULED" && (
            <div className="scheduled-action">
              <div>
                <strong>Future fill #{currentFill.fillNumber}</strong>
                <span>{currentFill.scheduledFor ? new Date(currentFill.scheduledFor).toLocaleString() : "Scheduled"}</span>
              </div>
              <button className="primary-button" disabled={!processAllowed || !scheduledCanStart || loading} onClick={() => void beginScheduledFill(currentFill.id)}>
                {scheduledCanStart ? "Start scheduled fill" : "Waiting for scheduled time"}
              </button>
            </div>
          )}

          {rx.status === "PRODUCT_FILL" && (
            <button className="primary-button" disabled={!processAllowed || loading} onClick={() => void transition("PHARMACIST_REVIEW", "Product fill completed; sent to pharmacist review.")}>Product prepared → Pharmacist Review</button>
          )}

          {rx.status === "PHARMACIST_REVIEW" && (
            <button className="primary-button" disabled={!verifyAllowed || loading} onClick={() => void transition("READY", "Pharmacist verification completed; prescription is Ready.")}>
              {verifyAllowed ? "Verify prescription → Ready" : "Pharmacist verification required"}
            </button>
          )}

          {rx.status === "READY" && (
            <button className="primary-button" disabled={!sellAllowed || loading} onClick={() => void transition("SOLD", "Prescription marked sold.")}>
              {sellAllowed ? "Mark prescription sold" : "Sale permission required"}
            </button>
          )}

          {rx.status === "SOLD" && refillBalance > 0 && (
            <button className="primary-button" disabled={!processAllowed || loading} onClick={() => void transition("DUR_REVIEW", "Refill review started.")}>Start refill review</button>
          )}

          {rx.status === "SOLD" && refillBalance === 0 && <p className="permission-note">No refills remain on this prescription.</p>}

          {rx.status === "ON_HOLD" && rx.heldFromStatus && (
            <button className="primary-button" disabled={!processAllowed || loading} onClick={() => void transition(rx.heldFromStatus!, `Prescription resumed to ${statusLabels[rx.heldFromStatus!] }.`)}>Resume → {statusLabels[rx.heldFromStatus]}</button>
          )}

          {(rx.status === "CANCELLED" || rx.status === "TRANSFERRED") && (
            <p className="permission-note">This prescription is in a terminal workflow state.</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Dispensing history</p><h2>Fills</h2></div>
        </div>
        <div className="table-wrap">
          <table className="compact-table">
            <thead><tr><th>Fill</th><th>Status</th><th>Quantity</th><th>Scheduled</th><th>Filled</th><th>Sold</th></tr></thead>
            <tbody>
              {rx.fills.map((fill) => (
                <tr key={fill.id}>
                  <td>#{fill.fillNumber}</td>
                  <td>{fill.status.replaceAll("_", " ")}</td>
                  <td>{String(fill.quantity ?? "—")}</td>
                  <td>{fill.scheduledFor ? new Date(fill.scheduledFor).toLocaleString() : "—"}</td>
                  <td>{fill.filledAt ? new Date(fill.filledAt).toLocaleString() : "—"}</td>
                  <td>{fill.soldAt ? new Date(fill.soldAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
              {rx.fills.length === 0 && <tr><td colSpan={6} className="empty-state">No fills created yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {canReadAudit(user) && (
        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Accountability</p><h2>Audit history</h2></div>
          </div>
          <div className="audit-list">
            {audit.map((event) => (
              <article className="audit-event" key={event.id}>
                <div><strong>{event.action.replaceAll("_", " ")}</strong><span>{event.actor ? `${event.actor.displayName} · ${event.actor.role}` : "System"}</span></div>
                <time>{new Date(event.occurredAt).toLocaleString()}</time>
              </article>
            ))}
            {audit.length === 0 && <p className="muted">No audit events found.</p>}
          </div>
        </section>
      )}
    </div>
  );
}
