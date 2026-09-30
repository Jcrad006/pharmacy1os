import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ClinicalPanel } from "./ClinicalPanel";
import {
  createFill,
  getPrescription,
  getPrescriptionAudit,
  returnFillToStock,
  startFill,
  transitionPrescription,
  updatePrescription,
} from "../api";
import type {
  AuditEvent,
  DevUser,
  Prescriber,
  PrescriptionQueueItem,
  PrescriptionStatus,
} from "../types";
import {
  activeFill,
  canEditPrescription,
  canProcess,
  canReadAudit,
  canSell,
  canVerify,
  formatPatientName,
  formatPrescriberName,
  primaryProviderContact,
  primaryProviderIdentifier,
  prescriptionCanBeEdited,
  readyFill,
  remainingRefills,
  statusLabels,
} from "../workflow";

type EditState = {
  prescriberId: string;
  medicationName: string;
  strength: string;
  dosageForm: string;
  sig: string;
  quantityWritten: string;
  refillsAllowed: string;
  writtenDate: string;
  expirationDate: string;
  doNotFillBefore: string;
};

function dateInputValue(value: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function editStateFromRx(rx: PrescriptionQueueItem): EditState {
  return {
    prescriberId: rx.prescriber.id,
    medicationName: rx.medicationName,
    strength: rx.strength ?? "",
    dosageForm: rx.dosageForm ?? "",
    sig: rx.sig,
    quantityWritten: String(rx.quantityWritten ?? ""),
    refillsAllowed: String(rx.refillsAllowed),
    writtenDate: dateInputValue(rx.writtenDate),
    expirationDate: dateInputValue(rx.expirationDate),
    doNotFillBefore: dateInputValue(rx.doNotFillBefore),
  };
}

function AuditDetails({ event }: { event: AuditEvent }) {
  if (event.action !== "PRESCRIPTION_EDITED" || !event.metadata) return null;

  const metadata = event.metadata as {
    changes?: Record<string, { before: unknown; after: unknown }>;
    workflowReset?: { from: string; to: string } | null;
  };

  return (
    <div className="audit-details">
      {metadata.changes &&
        Object.entries(metadata.changes).map(([field, change]) => (
          <div key={field}>
            <span>{field}</span>
            <code>{String(change.before ?? "—")} → {String(change.after ?? "—")}</code>
          </div>
        ))}
      {metadata.workflowReset && (
        <div>
          <span>workflow</span>
          <code>{metadata.workflowReset.from} → {metadata.workflowReset.to}</code>
        </div>
      )}
    </div>
  );
}

export function PrescriptionDetail({
  prescriptionId,
  devUser,
  user,
  prescribers,
  onBack,
  onMutated,
  onError,
}: {
  prescriptionId: string;
  devUser: string;
  user?: DevUser;
  prescribers: Prescriber[];
  onBack: () => void;
  onMutated: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [rx, setRx] = useState<PrescriptionQueueItem | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [openHighClinicalIssues, setOpenHighClinicalIssues] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [editing, setEditing] = useState(false);
  const [editState, setEditState] = useState<EditState | null>(null);

  async function load() {
    if (!devUser) return;
    setLoading(true);
    try {
      const next = await getPrescription(devUser, prescriptionId);
      setRx(next);
      setOpenHighClinicalIssues(null);
      setQuantity(String(next.quantityWritten ?? ""));
      if (!editing) setEditState(editStateFromRx(next));
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
          : result.fill.status === "IN_PROGRESS" && rx.fills[0]?.status === "RETURNED_TO_STOCK"
            ? "Returned fill re-entered Product Fill using the same fill number."
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

  async function returnToStock() {
    if (!rx) return;
    const fill = readyFill(rx.fills);
    if (!fill) return;

    setLoading(true);
    onError(null);
    try {
      await returnFillToStock(devUser, fill.id);
      await onMutated("Ready fill returned to stock; prescription returned to DUR Review.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to return fill to stock.");
      setLoading(false);
    }
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (!rx || !editState) return;

    setLoading(true);
    onError(null);
    try {
      await updatePrescription(devUser, rx.id, {
        prescriberId: editState.prescriberId,
        medicationName: editState.medicationName,
        strength: editState.strength || null,
        dosageForm: editState.dosageForm || null,
        sig: editState.sig,
        quantityWritten: editState.quantityWritten
          ? Number(editState.quantityWritten)
          : undefined,
        refillsAllowed: Number(editState.refillsAllowed),
        writtenDate: editState.writtenDate
          ? new Date(`${editState.writtenDate}T00:00:00`).toISOString()
          : null,
        expirationDate: editState.expirationDate
          ? new Date(`${editState.expirationDate}T00:00:00`).toISOString()
          : null,
        doNotFillBefore: editState.doNotFillBefore
          ? new Date(`${editState.doNotFillBefore}T00:00:00`).toISOString()
          : null,
      });
      setEditing(false);
      await onMutated("Prescription updated; audited changes were recorded.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to update prescription.");
      setLoading(false);
    }
  }

  if (!rx) {
    return <section className="panel"><p>{loading ? "Loading prescription…" : "Prescription not available."}</p></section>;
  }

  const processAllowed = canProcess(user);
  const verifyAllowed = canVerify(user);
  const sellAllowed = canSell(user);
  const editAllowed =
    canEditPrescription(user) &&
    prescriptionCanBeEdited(rx.status) &&
    !currentFill;
  const refillBalance = remainingRefills(rx.refillsAllowed, rx.refillsUsed);
  const scheduledCanStart =
    currentFill?.status === "SCHEDULED" &&
    (!currentFill.scheduledFor || new Date(currentFill.scheduledFor).getTime() <= Date.now());

  return (
    <div className="detail-stack">
      <div className="detail-toolbar">
        <button className="secondary-button" onClick={onBack}>← Queue</button>
        <div className="action-row">
          {editAllowed && (
            <button
              className="secondary-button"
              disabled={loading}
              onClick={() => {
                setEditState(editStateFromRx(rx));
                setEditing((value) => !value);
              }}
            >
              {editing ? "Close Editor" : "Edit Rx"}
            </button>
          )}
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

      {editing && editState && (
        <section className="panel edit-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Audited order change</p>
              <h2>Edit Prescription</h2>
            </div>
            <span className="edit-warning">Changes after DUR Review return the Rx to Data Entry.</span>
          </div>

          <form className="form-grid" onSubmit={submitEdit}>
            <label>
              Prescriber
              <select
                value={editState.prescriberId}
                onChange={(event) => setEditState({ ...editState, prescriberId: event.target.value })}
              >
                {prescribers.map((prescriber) => (
                  <option value={prescriber.id} key={prescriber.id}>
                    {formatPrescriberName(prescriber)}
                  </option>
                ))}
              </select>
            </label>
            <label>Medication<input value={editState.medicationName} onChange={(event) => setEditState({ ...editState, medicationName: event.target.value })} required /></label>
            <label>Strength<input value={editState.strength} onChange={(event) => setEditState({ ...editState, strength: event.target.value })} /></label>
            <label>Dosage form<input value={editState.dosageForm} onChange={(event) => setEditState({ ...editState, dosageForm: event.target.value })} /></label>
            <label className="wide">Directions / Sig<input value={editState.sig} onChange={(event) => setEditState({ ...editState, sig: event.target.value })} required /></label>
            <label>Quantity<input type="number" min="0.001" step="0.001" value={editState.quantityWritten} onChange={(event) => setEditState({ ...editState, quantityWritten: event.target.value })} /></label>
            <label>Refills authorized<input type="number" min={rx.refillsUsed} step="1" value={editState.refillsAllowed} onChange={(event) => setEditState({ ...editState, refillsAllowed: event.target.value })} /></label>
            <label>Written date<input type="date" value={editState.writtenDate} onChange={(event) => setEditState({ ...editState, writtenDate: event.target.value })} /></label>
            <label>Expiration date<input type="date" value={editState.expirationDate} onChange={(event) => setEditState({ ...editState, expirationDate: event.target.value })} /></label>
            <label>Do not fill before<input type="date" value={editState.doNotFillBefore} onChange={(event) => setEditState({ ...editState, doNotFillBefore: event.target.value })} /></label>
            <div className="form-actions wide action-row">
              <button className="primary-button" type="submit" disabled={loading}>Save audited changes</button>
              <button className="secondary-button" type="button" onClick={() => setEditing(false)}>Cancel edit</button>
            </div>
          </form>
        </section>
      )}

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
            <div><dt>Practice level</dt><dd>{rx.prescriber.practiceLevel}</dd></div>
            <div><dt>NPI</dt><dd>{primaryProviderIdentifier(rx.prescriber, "NPI")?.number ?? "—"}</dd></div>
            <div><dt>Phone</dt><dd>{primaryProviderContact(rx.prescriber, "PHONE")?.value ?? "—"}</dd></div>
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
                {rx.fills[0]?.status === "RETURNED_TO_STOCK"
                  ? "Reprocess returned fill"
                  : scheduledFor
                    ? "Schedule fill"
                    : "Create fill now"}
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
            <div className="verification-gate">
              {openHighClinicalIssues !== null && openHighClinicalIssues > 0 && (
                <p className="clinical-gate-warning">
                  Resolve {openHighClinicalIssues} HIGH DUR issue{openHighClinicalIssues === 1 ? "" : "s"} before final verification.
                </p>
              )}
              <button
                className="primary-button"
                disabled={
                  !verifyAllowed ||
                  loading ||
                  openHighClinicalIssues === null ||
                  openHighClinicalIssues > 0
                }
                onClick={() =>
                  void transition(
                    "READY",
                    "Pharmacist verification completed; prescription is Ready.",
                  )
                }
              >
                {!verifyAllowed
                  ? "Pharmacist verification required"
                  : openHighClinicalIssues === null
                    ? "Checking DUR status…"
                    : openHighClinicalIssues > 0
                      ? "Resolve HIGH DUR issues first"
                      : "Verify prescription → Ready"}
              </button>
            </div>
          )}

          {rx.status === "READY" && (
            <div className="action-row">
              <button className="primary-button" disabled={!sellAllowed || loading} onClick={() => void transition("SOLD", "Prescription marked sold.")}>
                {sellAllowed ? "Mark prescription sold" : "Sale permission required"}
              </button>
              <button
                className="secondary-button"
                disabled={!processAllowed || loading}
                onClick={() =>
                  window.confirm("Return this ready synthetic fill to stock?") &&
                  void returnToStock()
                }
              >
                Return to Stock
              </button>
            </div>
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

      <ClinicalPanel
        prescription={rx}
        devUser={devUser}
        user={user}
        onChanged={async (text) => {
          await onMutated(text);
          await load();
        }}
        onError={onError}
        onBlockersChanged={setOpenHighClinicalIssues}
      />

      {canReadAudit(user) && (
        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Accountability</p><h2>Audit history</h2></div>
          </div>
          <div className="audit-list">
            {audit.map((event) => (
              <article className="audit-event" key={event.id}>
                <div className="audit-main">
                  <strong>{event.action.replaceAll("_", " ")}</strong>
                  <span>{event.actor ? `${event.actor.displayName} · ${event.actor.role}` : "System"}</span>
                  <AuditDetails event={event} />
                </div>
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
