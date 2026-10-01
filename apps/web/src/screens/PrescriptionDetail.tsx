import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ClinicalPanel } from "./ClinicalPanel";
import {
  createEmergencySupply,
  createFill,
  createPartialFill,
  completeBiologicCommunication,
  completeEmergencySupplyFollowUp,
  documentNtiManufacturerConsent,
  getMedications,
  getPrescription,
  getPrescriptionAudit,
  removeFillProductSource,
  returnFillToStock,
  scanFillBarcode,
  scanFillProduct,
  setFillBillingProduct,
  setFillPackaging,
  startFill,
  transitionPrescription,
  updatePrescription,
} from "../api";
import type {
  AuditEvent,
  DevUser,
  FillInterruptionReason,
  Medication,
  Prescriber,
  PrescriptionQueueItem,
  PrescriptionStatus,
} from "../types";
import {
  activeFill,
  canAuthorizeEmergencySupply,
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
  medicationId: string;
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
    medicationId: rx.medicationId ?? "",
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
  const [medications, setMedications] = useState<Medication[]>([]);
  const [scanBarcode, setScanBarcode] = useState("");
  const [scanNdc, setScanNdc] = useState("");
  const [scanLot, setScanLot] = useState("");
  const [scanExpiration, setScanExpiration] = useState("");
  const [scanSourceQuantity, setScanSourceQuantity] = useState("");
  const [ntiPriorManufacturerId, setNtiPriorManufacturerId] = useState("");
  const [ntiNewManufacturerId, setNtiNewManufacturerId] = useState("");
  const [ntiPrescriberConsentAt, setNtiPrescriberConsentAt] = useState("");
  const [ntiPatientConsentAt, setNtiPatientConsentAt] = useState("");
  const [ntiConsentNote, setNtiConsentNote] = useState("");
  const [biologicCommunicationNote, setBiologicCommunicationNote] = useState("");
  const [quantity, setQuantity] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [partialQuantity, setPartialQuantity] = useState("");
  const [completionScheduledFor, setCompletionScheduledFor] = useState("");
  const [partialInterruptionReason, setPartialInterruptionReason] =
    useState<FillInterruptionReason | "">("");
  const [partialReason, setPartialReason] = useState("");
  const [emergencyQuantity, setEmergencyQuantity] = useState("");
  const [emergencyReason, setEmergencyReason] = useState("");
  const [emergencyFollowUpDueAt, setEmergencyFollowUpDueAt] = useState("");
  const [emergencyFollowUpNote, setEmergencyFollowUpNote] = useState("");
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

  useEffect(() => {
    if (!devUser) return;
    void getMedications(devUser)
      .then((items) => setMedications(items.filter((item) => item.active)))
      .catch((error) =>
        onError(
          error instanceof Error
            ? error.message
            : "Unable to load the drug catalog.",
        ),
      );
  }, [devUser]);

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

  async function verifyRawBarcode(event: FormEvent) {
    event.preventDefault();
    if (!rx || !currentFill || !scanBarcode.trim()) return;

    setLoading(true);
    onError(null);
    try {
      await scanFillBarcode(
        devUser,
        currentFill.id,
        scanBarcode,
        scanSourceQuantity ? Number(scanSourceQuantity) : undefined,
      );
      setScanBarcode("");
      setScanSourceQuantity("");
      await onMutated(
        "Physical product source verified and reserved for this fill.",
      );
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Barcode did not verify against the prescription.",
      );
      setLoading(false);
    }
  }

  async function verifyProductScan(event: FormEvent) {
    event.preventDefault();
    if (!rx || !currentFill) return;

    setLoading(true);
    onError(null);
    try {
      await scanFillProduct(devUser, currentFill.id, {
        ndc: scanNdc,
        lotNumber: scanLot,
        expirationDate: new Date(
          `${scanExpiration}T00:00:00Z`,
        ).toISOString(),
        sourceQuantity: scanSourceQuantity
          ? Number(scanSourceQuantity)
          : undefined,
      });
      setScanNdc("");
      setScanLot("");
      setScanExpiration("");
      setScanSourceQuantity("");
      await onMutated(
        "Physical NDC, lot, expiration, and source quantity added to this fill.",
      );
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Scanned product did not match the prescription.",
      );
      setLoading(false);
    }
  }

  async function removeProductSource(sourceId: string) {
    if (!currentFill) return;
    setLoading(true);
    onError(null);
    try {
      await removeFillProductSource(devUser, currentFill.id, sourceId);
      await onMutated("Physical product source removed and reservation released.");
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to remove physical product source.",
      );
      setLoading(false);
    }
  }

  async function selectBillingProduct(productId: string) {
    if (!currentFill) return;
    setLoading(true);
    onError(null);
    try {
      await setFillBillingProduct(
        devUser,
        currentFill.id,
        productId || null,
      );
      await onMutated(
        productId
          ? "Default billing NDC candidate selected."
          : "Billing NDC candidate cleared; payer strategy must select it during adjudication.",
      );
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to select billing NDC.",
      );
      setLoading(false);
    }
  }

  async function changePackaging(originalContainer: boolean) {
    if (!currentFill) return;
    setLoading(true);
    onError(null);
    try {
      await setFillPackaging(devUser, currentFill.id, originalContainer);
      await onMutated(
        originalContainer
          ? "Fill marked for dispensing in the manufacturer's original container."
          : "Fill marked for pharmacy-container dispensing; NC discard-date calculation will apply at verification.",
      );
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to update packaging status.",
      );
      setLoading(false);
    }
  }

  async function submitNtiConsent(event: FormEvent) {
    event.preventDefault();
    if (
      !currentFill ||
      !ntiPriorManufacturerId ||
      !ntiNewManufacturerId ||
      !ntiPrescriberConsentAt ||
      !ntiPatientConsentAt ||
      !ntiConsentNote.trim()
    ) return;

    setLoading(true);
    onError(null);
    try {
      await documentNtiManufacturerConsent(devUser, currentFill.id, {
        priorManufacturerId: ntiPriorManufacturerId,
        newManufacturerId: ntiNewManufacturerId,
        prescriberConsentAt: new Date(ntiPrescriberConsentAt).toISOString(),
        patientConsentAt: new Date(ntiPatientConsentAt).toISOString(),
        note: ntiConsentNote.trim(),
      });
      setNtiPrescriberConsentAt("");
      setNtiPatientConsentAt("");
      setNtiConsentNote("");
      await onMutated(
        "NC NTI manufacturer-change prescriber and patient consent documented.",
      );
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to document NTI manufacturer change consent.",
      );
      setLoading(false);
    }
  }

  async function finishBiologicCommunication(fillId: string) {
    if (!biologicCommunicationNote.trim()) return;
    setLoading(true);
    onError(null);
    try {
      await completeBiologicCommunication(
        devUser,
        fillId,
        biologicCommunicationNote.trim(),
      );
      setBiologicCommunicationNote("");
      await onMutated("NC biologic prescriber communication documented.");
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to document biologic communication.",
      );
      setLoading(false);
    }
  }

  async function submitPartialFill(event: FormEvent) {
    event.preventDefault();
    if (!rx || !currentFill) return;

    const dispenseQuantity = Number(partialQuantity);
    if (
      !Number.isFinite(dispenseQuantity) ||
      dispenseQuantity <= 0 ||
      !completionScheduledFor
    ) {
      return;
    }

    setLoading(true);
    onError(null);
    try {
      const result = await createPartialFill(devUser, currentFill.id, {
        dispenseQuantity,
        completionScheduledFor: new Date(
          completionScheduledFor,
        ).toISOString(),
        interruptionReason: partialInterruptionReason || undefined,
        reason: partialReason.trim() || undefined,
      });
      setPartialQuantity("");
      setCompletionScheduledFor("");
      setPartialInterruptionReason("");
      setPartialReason("");
      await onMutated(
        `Partial fill recorded: ${String(result.partialFill.quantity)} physically today; ${String(result.completionFill.quantity)} owed for completion. Payer-intended quantity remains ${String(result.partialFill.payerIntendedQuantity ?? result.partialFill.intendedQuantity ?? "—")}.`,
      );
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to create partial/completion fill.",
      );
      setLoading(false);
    }
  }

  async function submitEmergencySupply(event: FormEvent) {
    event.preventDefault();
    if (!rx) return;

    const emergencyAmount = Number(emergencyQuantity);
    if (
      !Number.isFinite(emergencyAmount) ||
      emergencyAmount <= 0 ||
      !emergencyReason.trim() ||
      !emergencyFollowUpDueAt
    ) {
      return;
    }

    setLoading(true);
    onError(null);
    try {
      await createEmergencySupply(devUser, rx.id, {
        quantity: emergencyAmount,
        reason: emergencyReason.trim(),
        followUpDueAt: new Date(emergencyFollowUpDueAt).toISOString(),
      });
      setEmergencyQuantity("");
      setEmergencyReason("");
      setEmergencyFollowUpDueAt("");
      await onMutated(
        "Pharmacist-authorized emergency supply created and moved to Product Fill.",
      );
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to authorize emergency supply.",
      );
      setLoading(false);
    }
  }

  async function completeEmergencyFollowUp(fillId: string) {
    if (!emergencyFollowUpNote.trim()) return;
    setLoading(true);
    onError(null);
    try {
      await completeEmergencySupplyFollowUp(
        devUser,
        fillId,
        emergencyFollowUpNote.trim(),
      );
      setEmergencyFollowUpNote("");
      await onMutated("Emergency-supply follow-up documented.");
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to complete emergency-supply follow-up.",
      );
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
        medicationId: editState.medicationId || undefined,
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
  const emergencyAllowed = canAuthorizeEmergencySupply(user);
  const sellAllowed = canSell(user);
  const editAllowed =
    canEditPrescription(user) &&
    prescriptionCanBeEdited(rx.status) &&
    !currentFill;
  const refillBalance = remainingRefills(rx.refillsAllowed, rx.refillsUsed);
  const sourceReservedQuantity = (currentFill?.productSources ?? []).reduce(
    (sum, source) => sum + Number(source.quantity),
    0,
  );
  const sourceRequiredQuantity = Number(currentFill?.quantity ?? 0);
  const sourceRemainingQuantity = Math.max(
    0,
    sourceRequiredQuantity - sourceReservedQuantity,
  );
  const sourceProductIds = Array.from(
    new Set((currentFill?.productSources ?? []).map((source) => source.productId)),
  );
  const complianceAllowed =
    user?.role === "ADMIN" || user?.role === "PHARMACIST";
  const medicationManufacturers = Array.from(
    new Map(
      (rx.medication?.products ?? []).map((product) => [
        product.manufacturer.id,
        product.manufacturer,
      ]),
    ).values(),
  );
  const scheduledCanStart =
    currentFill?.status === "SCHEDULED" &&
    (!currentFill.scheduledFor ||
      new Date(currentFill.scheduledFor).getTime() <= Date.now());
  const unresolvedEmergencyFollowUp = rx.fills.find(
    (fill) =>
      fill.kind === "EMERGENCY_SUPPLY" &&
      fill.followUpDueAt &&
      !fill.followUpCompletedAt,
  );

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
            <label>
              Drug
              <select
                value={editState.medicationId}
                onChange={(event) =>
                  setEditState({ ...editState, medicationId: event.target.value })
                }
                required
              >
                <option value="">Select drug</option>
                {medications.map((medication) => (
                  <option key={medication.id} value={medication.id}>
                    {medication.genericName} · {medication.strength} · {medication.dosageForm}
                  </option>
                ))}
              </select>
            </label>
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

          {(rx.status === "DUR_REVIEW" ||
            (rx.status === "SOLD" && currentFill?.kind === "COMPLETION")) &&
            currentFill?.status === "SCHEDULED" && (
              <div className="scheduled-action continuity-scheduled-action">
                <div>
                  <strong>
                    {currentFill.kind === "COMPLETION"
                      ? `Completion fill #${currentFill.fillNumber} · part ${currentFill.partNumber}`
                      : `Future fill #${currentFill.fillNumber}`}
                  </strong>
                  <span>
                    {currentFill.kind === "COMPLETION"
                      ? `${String(currentFill.quantity ?? "—")} remaining`
                      : ""}
                    {currentFill.scheduledFor
                      ? ` · ${new Date(currentFill.scheduledFor).toLocaleString()}`
                      : "Scheduled"}
                  </span>
                </div>
                <button
                  className="primary-button"
                  disabled={!processAllowed || !scheduledCanStart || loading}
                  onClick={() => void beginScheduledFill(currentFill.id)}
                >
                  {scheduledCanStart
                    ? currentFill.kind === "COMPLETION"
                      ? "Start completion fill"
                      : "Start scheduled fill"
                    : "Waiting for scheduled time"}
                </button>
              </div>
            )}

          {rx.status === "PRODUCT_FILL" && currentFill && (
            <div className="product-scan-workflow">
              <div className="scan-expected-drug">
                <span>Drug selected during Data Entry</span>
                <strong>
                  {rx.medication
                    ? `${rx.medication.genericName} ${rx.medication.strength} ${rx.medication.dosageForm}`
                    : `${rx.medicationName} ${rx.strength ?? ""} ${rx.dosageForm ?? ""}`}
                </strong>
                <small>
                  {rx.productSelectionDirective === "DISPENSE_AS_WRITTEN"
                    ? "Product selection prohibited: only the prescribed product/NDC may be used."
                    : "Up to four eligible physical NDC / lot / expiration sources may satisfy this dispense part."}
                </small>
              </div>

              {currentFill.kind !== "EMERGENCY_SUPPLY" &&
                currentFill.kind !== "PARTIAL" && (
                  <details className="partial-fill-panel">
                    <summary>
                      {currentFill.productVerifiedAt
                        ? "Stop current fill / convert to partial"
                        : "Only part of this fill is available"}
                    </summary>
                    <form
                      className="continuity-form"
                      onSubmit={submitPartialFill}
                    >
                      <p className="catalog-help">
                        {currentFill.productVerifiedAt
                          ? "The product has already been scanned and reserved. Pharmacy1OS will release the current reservation, re-reserve only the physical quantity dispensed today, and create a linked completion for the remainder. The payer-intended full-fill quantity is preserved."
                          : "Record the physical quantity to dispense today. The remainder will be scheduled as a linked completion of the same fill number and will not consume another refill. The payer-intended quantity remains the full intended fill quantity."}
                      </p>
                      <div className="fill-quantity-summary">
                        <span>
                          Planned physical part
                          <strong>{String(currentFill.quantity ?? "—")}</strong>
                        </span>
                        <span>
                          Payer intended
                          <strong>
                            {String(
                              currentFill.payerIntendedQuantity ??
                                currentFill.intendedQuantity ??
                                currentFill.authorizedQuantity ??
                                currentFill.quantity ??
                                "—",
                            )}
                          </strong>
                        </span>
                        <span>
                          Currently reserved
                          <strong>
                            {currentFill.inventoryReservedAt
                              ? String(currentFill.quantity ?? "—")
                              : "0"}
                          </strong>
                        </span>
                      </div>
                      <label>
                        Dispense now
                        <input
                          type="number"
                          min="0.001"
                          step="0.001"
                          max={
                            currentFill.quantity !== null
                              ? Number(currentFill.quantity) - 0.001
                              : undefined
                          }
                          value={partialQuantity}
                          onChange={(event) =>
                            setPartialQuantity(event.target.value)
                          }
                          placeholder={`Less than ${String(currentFill.quantity ?? "fill quantity")}`}
                          required
                        />
                      </label>
                      <label>
                        Completion date/time
                        <input
                          type="datetime-local"
                          value={completionScheduledFor}
                          onChange={(event) =>
                            setCompletionScheduledFor(event.target.value)
                          }
                          required
                        />
                      </label>
                      <label>
                        Interruption reason
                        <select
                          value={partialInterruptionReason}
                          onChange={(event) =>
                            setPartialInterruptionReason(
                              event.target.value as
                                | FillInterruptionReason
                                | "",
                            )
                          }
                          required={Boolean(currentFill.productVerifiedAt)}
                        >
                          <option value="">Select reason</option>
                          <option value="INSUFFICIENT_PHYSICAL_STOCK">
                            Insufficient physical stock
                          </option>
                          <option value="DAMAGED_PRODUCT">
                            Damaged product
                          </option>
                          <option value="EXPIRED_PRODUCT">
                            Expired product discovered
                          </option>
                          <option value="STOCK_DISCREPANCY">
                            Stock discrepancy
                          </option>
                          <option value="OTHER">Other</option>
                        </select>
                      </label>
                      <label className="wide">
                        Reason / inventory note
                        <input
                          value={partialReason}
                          onChange={(event) =>
                            setPartialReason(event.target.value)
                          }
                          placeholder="Example: only 3 tablets in stock; remainder ordered for next business day"
                        />
                      </label>
                      <button
                        type="submit"
                        className="secondary-button"
                        disabled={
                          loading ||
                          !processAllowed ||
                          !partialQuantity ||
                          !completionScheduledFor ||
                          (Boolean(currentFill.productVerifiedAt) &&
                            !partialInterruptionReason) ||
                          !Number.isFinite(Number(partialQuantity)) ||
                          Number(partialQuantity) <= 0 ||
                          (currentFill.quantity !== null &&
                            Number(partialQuantity) >=
                              Number(currentFill.quantity))
                        }
                      >
                        {currentFill.productVerifiedAt
                          ? "Interrupt fill + create partial"
                          : "Create partial + completion"}
                      </button>
                    </form>
                  </details>
                )}

              <div className="split-source-workflow">
                <div className="split-source-summary">
                  <span>
                    Physical dispense
                    <strong>{String(currentFill.quantity ?? "—")}</strong>
                  </span>
                  <span>
                    Reserved from sources
                    <strong>{sourceReservedQuantity}</strong>
                  </span>
                  <span>
                    Remaining
                    <strong>{sourceRemainingQuantity}</strong>
                  </span>
                  <span>
                    Sources
                    <strong>{currentFill.productSources.length} / 4</strong>
                  </span>
                </div>

                {currentFill.productSources.length > 0 && (
                  <div className="fill-source-list">
                    {currentFill.productSources.map((source) => (
                      <div className="fill-source-row" key={source.id}>
                        <span className="source-sequence">#{source.sequence}</span>
                        <div>
                          <strong>
                            {source.manufacturerSnapshot} · NDC{" "}
                            {source.ndcSnapshot}
                          </strong>
                          <span>
                            Lot {source.lotNumberSnapshot} · Exp{" "}
                            {new Date(
                              source.expirationSnapshot,
                            ).toLocaleDateString()}
                          </span>
                        </div>
                        <strong>Qty {String(source.quantity)}</strong>
                        {!currentFill.inventoryCommittedAt &&
                          processAllowed && (
                            <button
                              type="button"
                              className="secondary-button table-action"
                              disabled={loading}
                              onClick={() =>
                                void removeProductSource(source.id)
                              }
                            >
                              Remove
                            </button>
                          )}
                      </div>
                    ))}
                  </div>
                )}

                {sourceRemainingQuantity > 0 &&
                  currentFill.productSources.length < 4 && (
                    <div className="product-scan-stack">
                      <div className="source-quantity-control">
                        <label>
                          Quantity from next source
                          <input
                            type="number"
                            min="0.001"
                            step="0.001"
                            max={sourceRemainingQuantity}
                            value={scanSourceQuantity}
                            onChange={(event) =>
                              setScanSourceQuantity(event.target.value)
                            }
                            placeholder={String(sourceRemainingQuantity)}
                          />
                        </label>
                        <small>
                          Leave blank to use the entire remaining quantity.
                        </small>
                      </div>

                      <form
                        className="raw-barcode-form"
                        onSubmit={verifyRawBarcode}
                      >
                        <label>
                          Scan stock-package barcode
                          <input
                            autoFocus
                            value={scanBarcode}
                            onChange={(event) =>
                              setScanBarcode(event.target.value)
                            }
                            placeholder="Scan GS1 / registered barcode"
                            required
                          />
                        </label>
                        <button
                          className="primary-button"
                          type="submit"
                          disabled={
                            !processAllowed ||
                            loading ||
                            !scanBarcode.trim()
                          }
                        >
                          Add scanned source
                        </button>
                      </form>

                      <details className="manual-scan-fallback">
                        <summary>
                          Development fallback: enter NDC / lot / expiration
                          manually
                        </summary>
                        <form
                          className="product-scan-form"
                          onSubmit={verifyProductScan}
                        >
                          <label>
                            NDC
                            <input
                              value={scanNdc}
                              onChange={(event) =>
                                setScanNdc(event.target.value)
                              }
                              placeholder="NDC from stock package"
                              required
                            />
                          </label>
                          <label>
                            Lot
                            <input
                              value={scanLot}
                              onChange={(event) =>
                                setScanLot(event.target.value)
                              }
                              placeholder="Lot number"
                              required
                            />
                          </label>
                          <label>
                            Expiration
                            <input
                              type="date"
                              value={scanExpiration}
                              onChange={(event) =>
                                setScanExpiration(event.target.value)
                              }
                              required
                            />
                          </label>
                          <button
                            className="secondary-button"
                            type="submit"
                            disabled={
                              !processAllowed ||
                              loading ||
                              !scanNdc ||
                              !scanLot ||
                              !scanExpiration
                            }
                          >
                            Add manual source
                          </button>
                        </form>
                      </details>
                    </div>
                  )}

                {sourceRemainingQuantity > 0 &&
                  currentFill.productSources.length >= 4 && (
                    <p className="clinical-gate-warning">
                      Four physical sources have been reached but{" "}
                      {sourceRemainingQuantity} units remain. Remove a source,
                      change quantities, or convert the fill to a partial.
                    </p>
                  )}

                <div className="fill-billing-separation">
                  <div>
                    <strong>Physical source NDCs</strong>
                    <span>
                      {sourceProductIds.length === 0
                        ? "None yet"
                        : currentFill.productSources
                            .map((source) => source.ndcSnapshot)
                            .join(" · ")}
                    </span>
                  </div>
                  <label>
                    Default billing NDC candidate
                    <select
                      value={currentFill.billingProductId ?? ""}
                      disabled={
                        loading ||
                        !processAllowed ||
                        currentFill.productSources.length === 0
                      }
                      onChange={(event) =>
                        void selectBillingProduct(event.target.value)
                      }
                    >
                      <option value="">
                        {sourceProductIds.length > 1
                          ? "Payer strategy / explicit selection required"
                          : "Not selected"}
                      </option>
                      {Array.from(
                        new Map(
                          currentFill.productSources.map((source) => [
                            source.productId,
                            source,
                          ]),
                        ).values(),
                      ).map((source) => (
                        <option
                          key={source.productId}
                          value={source.productId}
                        >
                          {source.ndcSnapshot} ·{" "}
                          {source.manufacturerSnapshot}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="catalog-help">
                    This is only the fill-level default candidate. Each future
                    immutable payer claim will snapshot the actual NDC sent to
                    that payer; Pharmacy1OS does not infer first/majority NDC
                    for a split-product fill.
                  </p>
                </div>

                <label className="architecture-check">
                  <input
                    type="checkbox"
                    checked={currentFill.dispensedInOriginalContainer}
                    disabled={loading || !processAllowed}
                    onChange={(event) =>
                      void changePackaging(event.target.checked)
                    }
                  />
                  Dispense in manufacturer original container
                </label>
                {!currentFill.dispensedInOriginalContainer && (
                  <p className="catalog-help">
                    North Carolina patient discard date will be calculated at
                    pharmacist verification from the earliest source
                    expiration or one year from dispensing, whichever is
                    earlier.
                  </p>
                )}

                {currentFill.productVerifiedAt && (
                  <div className="scan-verified-card">
                    <strong>✓ Physical Product Fill fully sourced</strong>
                    <span>
                      {sourceReservedQuantity} of{" "}
                      {String(currentFill.quantity ?? "—")} units reserved
                      across {currentFill.productSources.length} source
                      {currentFill.productSources.length === 1 ? "" : "s"}.
                    </span>
                  </div>
                )}

                {rx.medication?.ncNarrowTherapeuticIndex &&
                  complianceAllowed && (
                    <details className="partial-fill-panel">
                      <summary>
                        Pharmacist: document NC NTI manufacturer-change
                        consent
                      </summary>
                      <form
                        className="continuity-form"
                        onSubmit={submitNtiConsent}
                      >
                        <p className="catalog-help">
                          Use only for a manufacturer change between fills.
                          Pharmacy1OS still blocks mixing different
                          manufacturers within the same NTI dispense.
                        </p>
                        <label>
                          Prior manufacturer
                          <select
                            value={ntiPriorManufacturerId}
                            onChange={(event) =>
                              setNtiPriorManufacturerId(event.target.value)
                            }
                            required
                          >
                            <option value="">Select manufacturer</option>
                            {medicationManufacturers.map((manufacturer) => (
                              <option
                                key={manufacturer.id}
                                value={manufacturer.id}
                              >
                                {manufacturer.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          New manufacturer
                          <select
                            value={ntiNewManufacturerId}
                            onChange={(event) =>
                              setNtiNewManufacturerId(event.target.value)
                            }
                            required
                          >
                            <option value="">Select manufacturer</option>
                            {medicationManufacturers.map((manufacturer) => (
                              <option
                                key={manufacturer.id}
                                value={manufacturer.id}
                              >
                                {manufacturer.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Prescriber consent documented
                          <input
                            type="datetime-local"
                            value={ntiPrescriberConsentAt}
                            onChange={(event) =>
                              setNtiPrescriberConsentAt(event.target.value)
                            }
                            required
                          />
                        </label>
                        <label>
                          Patient consent documented
                          <input
                            type="datetime-local"
                            value={ntiPatientConsentAt}
                            onChange={(event) =>
                              setNtiPatientConsentAt(event.target.value)
                            }
                            required
                          />
                        </label>
                        <label className="wide">
                          Required documentation note
                          <textarea
                            rows={3}
                            value={ntiConsentNote}
                            onChange={(event) =>
                              setNtiConsentNote(event.target.value)
                            }
                            required
                          />
                        </label>
                        <button
                          type="submit"
                          className="primary-button"
                          disabled={
                            loading ||
                            !ntiPriorManufacturerId ||
                            !ntiNewManufacturerId ||
                            ntiPriorManufacturerId ===
                              ntiNewManufacturerId ||
                            !ntiPrescriberConsentAt ||
                            !ntiPatientConsentAt ||
                            !ntiConsentNote.trim()
                          }
                        >
                          Document both consents
                        </button>
                      </form>
                    </details>
                  )}
              </div>

              <button
                className="primary-button"
                disabled={
                  !processAllowed ||
                  loading ||
                  (Boolean(rx.medicationId) && !currentFill.productVerifiedAt)
                }
                onClick={() =>
                  void transition(
                    "PHARMACIST_REVIEW",
                    "Product fill completed; sent to pharmacist review.",
                  )
                }
              >
                {rx.medicationId && !currentFill.productVerifiedAt
                  ? "Scan and verify product first"
                  : "Product prepared → Pharmacist Review"}
              </button>
            </div>
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

          {rx.status === "SOLD" &&
            refillBalance === 0 &&
            currentFill?.kind !== "COMPLETION" && (
              <div className="continuity-stack">
                <p className="permission-note">
                  No authorized refills remain on this prescription.
                </p>

                {emergencyAllowed && !currentFill && (
                  <details className="emergency-supply-panel">
                    <summary>
                      Pharmacist: authorize emergency supply
                    </summary>
                    <form
                      className="continuity-form"
                      onSubmit={submitEmergencySupply}
                    >
                      <p className="catalog-help">
                        Use only when pharmacist professional judgment and
                        applicable law/policy permit continuation therapy
                        without an authorized refill. This creates a separately
                        audited dispense and does not manufacture a refill.
                      </p>
                      <label>
                        Emergency quantity
                        <input
                          type="number"
                          min="0.001"
                          step="0.001"
                          value={emergencyQuantity}
                          onChange={(event) =>
                            setEmergencyQuantity(event.target.value)
                          }
                          required
                        />
                      </label>
                      <label>
                        Follow-up deadline
                        <input
                          type="datetime-local"
                          value={emergencyFollowUpDueAt}
                          onChange={(event) =>
                            setEmergencyFollowUpDueAt(event.target.value)
                          }
                          required
                        />
                      </label>
                      <label className="wide">
                        Required pharmacist justification
                        <textarea
                          rows={3}
                          value={emergencyReason}
                          onChange={(event) =>
                            setEmergencyReason(event.target.value)
                          }
                          placeholder="Document why interruption of therapy poses a clinically significant risk and the attempted/needed prescriber follow-up."
                          required
                        />
                      </label>
                      <button
                        type="submit"
                        className="danger-button"
                        disabled={
                          loading ||
                          !emergencyReason.trim() ||
                          !emergencyQuantity ||
                          !emergencyFollowUpDueAt ||
                          !Number.isFinite(Number(emergencyQuantity)) ||
                          Number(emergencyQuantity) <= 0
                        }
                      >
                        Authorize emergency supply
                      </button>
                    </form>
                  </details>
                )}
              </div>
            )}

          {rx.status === "SOLD" &&
            unresolvedEmergencyFollowUp &&
            emergencyAllowed && (
              <div className="emergency-follow-up-panel">
                <strong>Emergency-supply follow-up remains open</strong>
                <span>
                  Due{" "}
                  {unresolvedEmergencyFollowUp.followUpDueAt
                    ? new Date(
                        unresolvedEmergencyFollowUp.followUpDueAt,
                      ).toLocaleString()
                    : "—"}
                </span>
                <textarea
                  rows={3}
                  value={emergencyFollowUpNote}
                  onChange={(event) =>
                    setEmergencyFollowUpNote(event.target.value)
                  }
                  placeholder="Document prescriber notification/contact and outcome."
                />
                <button
                  type="button"
                  className="primary-button"
                  disabled={loading || !emergencyFollowUpNote.trim()}
                  onClick={() =>
                    void completeEmergencyFollowUp(
                      unresolvedEmergencyFollowUp.id,
                    )
                  }
                >
                  Complete follow-up
                </button>
              </div>
            )}

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
            <thead><tr><th>Fill</th><th>Type</th><th>Status</th><th>Quantities</th><th>NDC / Lot / Exp</th><th>Scheduled / follow-up</th><th>Filled</th><th>Sold</th></tr></thead>
            <tbody>
              {rx.fills.map((fill) => (
                <tr key={fill.id}>
                  <td>
                    #{fill.fillNumber}
                    {fill.partNumber > 1 ? ` · part ${fill.partNumber}` : ""}
                  </td>
                  <td>
                    {fill.kind.replaceAll("_", " ")}
                    <span className="cell-subtext">
                      {fill.billingRole.replaceAll("_", " ")}
                    </span>
                    {!fill.consumesRefill && (
                      <span className="cell-subtext">No refill consumed</span>
                    )}
                  </td>
                  <td>{fill.status.replaceAll("_", " ")}</td>
                  <td>
                    <strong>
                      Physical part: {String(fill.quantity ?? "—")}
                    </strong>
                    <span className="cell-subtext">
                      Payer intended:{" "}
                      {String(
                        fill.payerIntendedQuantity ??
                          fill.intendedQuantity ??
                          "—",
                      )}
                    </span>
                    <span className="cell-subtext">
                      Physically dispensed:{" "}
                      {String(fill.physicalDispensedQuantity ?? 0)}
                    </span>
                    {Number(fill.remainingOwedQuantity ?? 0) > 0 && (
                      <span className="cell-subtext">
                        Remaining owed:{" "}
                        {String(fill.remainingOwedQuantity)}
                      </span>
                    )}
                  </td>
                  <td>
                    {fill.productVerifiedAt ? (
                      <span className="fill-product-trace">
                        {fill.scannedNdc} · {fill.scannedLotNumber} ·{" "}
                        {fill.scannedExpiration
                          ? new Date(fill.scannedExpiration).toLocaleDateString()
                          : "—"}
                      </span>
                    ) : "—"}
                  </td>
                  <td>
                    {fill.scheduledFor
                      ? new Date(fill.scheduledFor).toLocaleString()
                      : "—"}
                    {fill.kind === "EMERGENCY_SUPPLY" && fill.followUpDueAt && (
                      <span className="cell-subtext">
                        Follow-up due{" "}
                        {new Date(fill.followUpDueAt).toLocaleString()}
                        {fill.followUpCompletedAt ? " · completed" : ""}
                      </span>
                    )}
                  </td>
                  <td>{fill.filledAt ? new Date(fill.filledAt).toLocaleString() : "—"}</td>
                  <td>{fill.soldAt ? new Date(fill.soldAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
              {rx.fills.length === 0 && <tr><td colSpan={8} className="empty-state">No fills created yet.</td></tr>}
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
