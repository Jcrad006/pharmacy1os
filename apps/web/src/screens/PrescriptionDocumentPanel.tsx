import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  applyPrescriptionDocumentedChange,
  createPrescriptionVisualAnnotation,
  ensureElectronicPrescriptionRender,
  getPrescriptionDocumentBlob,
  getPrescriptionDocuments,
  supersedePrescriptionVisualAnnotation,
  uploadPrescriptionOriginal,
  type PrescriptionAnnotationInput,
} from "../api";
import type {
  DevUser,
  PrescriptionAnnotation,
  PrescriptionChangeCommunicationMethod,
  PrescriptionChangeRecord,
  PrescriptionChangeType,
  PrescriptionDocument,
  PrescriptionQueueItem,
} from "../types";
import { canManagePrescriptionDocuments } from "../workflow";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ChangeForm = {
  text: string;
  changeType: PrescriptionChangeType;
  whatChanged: string;
  reason: string;
  communicationMethod: PrescriptionChangeCommunicationMethod | "";
  contactedParty: string;
  authorizingPrescriber: string;
  note: string;
  structuredValue: string;
};

const emptyChangeForm: ChangeForm = {
  text: "",
  changeType: "OTHER",
  whatChanged: "",
  reason: "",
  communicationMethod: "",
  contactedParty: "",
  authorizingPrescriber: "",
  note: "",
  structuredValue: "",
};

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Unable to read file."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

function percent(value: string | number) {
  return String(Number(value) * 100) + "%";
}

function humanChangeType(type: PrescriptionChangeType) {
  return type.replaceAll("_", " ");
}

function parseStructuredValue(
  type: PrescriptionChangeType,
  raw: string,
): unknown {
  const value = raw.trim();
  if (type === "QUANTITY" || type === "REFILLS") {
    return Number(value);
  }
  return value;
}

function structuredValueText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

function structuredValueHint(type: PrescriptionChangeType) {
  if (type === "DRUG") return "Enter the new Medication catalog ID.";
  if (type === "PRESCRIBER") return "Enter the new Prescriber record ID.";
  if (type === "DAW") {
    return "Use UNSPECIFIED, SELECTION_PERMITTED, or DISPENSE_AS_WRITTEN.";
  }
  if (type === "WRITTEN_DATE") return "Enter an ISO date, e.g. 2026-10-01.";
  if (type === "QUANTITY" || type === "REFILLS") return "Enter the new numeric value.";
  return "Enter the exact new structured prescription value.";
}

function annotationInput(
  rect: Rect,
  form: ChangeForm,
): PrescriptionAnnotationInput {
  return {
    text: form.text.trim(),
    ...rect,
    change: {
      changeType: form.changeType,
      whatChanged: form.whatChanged.trim(),
      reason: form.reason.trim(),
      communicationMethod: form.communicationMethod || null,
      contactedParty: form.contactedParty.trim() || null,
      authorizingPrescriber: form.authorizingPrescriber.trim() || null,
      note: form.note.trim() || null,
      structuredValue:
        form.changeType === "OTHER"
          ? undefined
          : parseStructuredValue(
              form.changeType,
              form.structuredValue,
            ),
    },
  };
}

export function PrescriptionDocumentPanel({
  prescription,
  devUser,
  user,
  onMutated,
  onError,
}: {
  prescription: PrescriptionQueueItem;
  devUser: string;
  user?: DevUser;
  onMutated: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [documents, setDocuments] = useState<PrescriptionDocument[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    null,
  );
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [draftRect, setDraftRect] = useState<Rect | null>(null);
  const [draftForm, setDraftForm] = useState<ChangeForm>(emptyChangeForm);
  const [revisionOf, setRevisionOf] =
    useState<PrescriptionAnnotation | null>(null);
  const [applyValues, setApplyValues] = useState<Record<string, string>>({});
  const viewerRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  const canManage = canManagePrescriptionDocuments(user);
  const selectedDocument = useMemo(
    () =>
      documents.find((item) => item.id === selectedDocumentId) ?? null,
    [documents, selectedDocumentId],
  );
  const activeChangeCount = documents.reduce(
    (sum, item) =>
      sum +
      item.annotations.filter((annotation) => annotation.status === "ACTIVE")
        .length,
    0,
  );

  async function loadDocuments() {
    if (!devUser) return;
    try {
      let next = await getPrescriptionDocuments(devUser, prescription.id);
      if (
        next.length === 0 &&
        prescription.sourceType === "ELECTRONIC" &&
        canManage
      ) {
        await ensureElectronicPrescriptionRender(devUser, prescription.id);
        next = await getPrescriptionDocuments(devUser, prescription.id);
      }
      setDocuments(next);
      setSelectedDocumentId((current) =>
        current && next.some((item) => item.id === current)
          ? current
          : next[0]?.id ?? null,
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load prescription source documents.",
      );
    }
  }

  useEffect(() => {
    void loadDocuments();
  }, [prescription.id, prescription.sourceType, devUser, canManage]);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setBlobUrl(null);
    if (!selectedDocument || !devUser) return;

    void getPrescriptionDocumentBlob(devUser, selectedDocument.id)
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch((error) =>
        onError(
          error instanceof Error
            ? error.message
            : "Unable to retrieve the immutable prescription source.",
        ),
      );

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selectedDocument?.id, devUser]);

  async function uploadOriginal(file: File | null) {
    if (!file || !canManage) return;
    setBusy(true);
    onError(null);
    try {
      const base64Data = await fileToBase64(file);
      const result = await uploadPrescriptionOriginal(
        devUser,
        prescription.id,
        {
          sourceType: "SCAN",
          mimeType: file.type || "application/octet-stream",
          originalFilename: file.name,
          base64Data,
        },
      );
      await loadDocuments();
      setSelectedDocumentId(result.document.id);
      await onMutated(
        "Immutable prescription original stored in the local document vault.",
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to store prescription source document.",
      );
    } finally {
      setBusy(false);
    }
  }

  function normalizedPoint(event: PointerEvent<HTMLDivElement>) {
    const rect = viewerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.min(
        1,
        Math.max(0, (event.clientX - rect.left) / rect.width),
      ),
      y: Math.min(
        1,
        Math.max(0, (event.clientY - rect.top) / rect.height),
      ),
    };
  }

  function beginDraw(event: PointerEvent<HTMLDivElement>) {
    if (!drawMode || !selectedDocument || !canManage) return;
    const point = normalizedPoint(event);
    if (!point) return;
    pointerStart.current = point;
    setDraftRect({
      x: point.x,
      y: point.y,
      width: 0.01,
      height: 0.01,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateDraw(event: PointerEvent<HTMLDivElement>) {
    if (!drawMode || !pointerStart.current) return;
    const point = normalizedPoint(event);
    if (!point) return;
    const start = pointerStart.current;
    setDraftRect({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.max(0.01, Math.abs(point.x - start.x)),
      height: Math.max(0.01, Math.abs(point.y - start.y)),
    });
  }

  function endDraw(event: PointerEvent<HTMLDivElement>) {
    if (!pointerStart.current) return;
    updateDraw(event);
    pointerStart.current = null;
    setDrawMode(false);
    setRevisionOf(null);
    setDraftForm(emptyChangeForm);
  }

  function beginRevision(annotation: PrescriptionAnnotation) {
    setRevisionOf(annotation);
    setDraftRect({
      x: Number(annotation.x),
      y: Number(annotation.y),
      width: Number(annotation.width),
      height: Number(annotation.height),
    });
    setDraftForm({
      text: annotation.text,
      changeType: annotation.changeRecord?.changeType ?? "OTHER",
      whatChanged: annotation.changeRecord?.whatChanged ?? "",
      reason: annotation.changeRecord?.reason ?? "",
      communicationMethod:
        annotation.changeRecord?.communicationMethod ?? "",
      contactedParty: annotation.changeRecord?.contactedParty ?? "",
      authorizingPrescriber:
        annotation.changeRecord?.authorizingPrescriber ?? "",
      note: annotation.changeRecord?.note ?? "",
      structuredValue: structuredValueText(
        annotation.changeRecord?.afterValue,
      ),
    });
    setDrawMode(false);
  }

  async function saveAnnotation() {
    if (!selectedDocument || !draftRect || !canManage) return;
    if (
      !draftForm.text.trim() ||
      !draftForm.whatChanged.trim() ||
      !draftForm.reason.trim() ||
      (draftForm.changeType !== "OTHER" &&
        !draftForm.structuredValue.trim())
    ) {
      onError(
        "Visual note, what changed, why, and the new structured Rx value are required for a clinical change.",
      );
      return;
    }

    setBusy(true);
    onError(null);
    try {
      const input = annotationInput(draftRect, draftForm);
      const revised = Boolean(revisionOf);
      if (revisionOf) {
        await supersedePrescriptionVisualAnnotation(
          devUser,
          revisionOf.id,
          input,
        );
      } else {
        await createPrescriptionVisualAnnotation(
          devUser,
          selectedDocument.id,
          input,
        );
      }
      setDraftRect(null);
      setRevisionOf(null);
      setDraftForm(emptyChangeForm);
      await loadDocuments();
      await onMutated(
        revised
          ? "Prescription annotation revised; the prior version remains in history."
          : "Prescription visual annotation and separate change documentation saved.",
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to save prescription annotation.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyChange(record: PrescriptionChangeRecord) {
    const raw =
      applyValues[record.id] ?? structuredValueText(record.afterValue);
    if (!raw.trim()) {
      onError(
        "Enter the exact new structured Rx value before applying this documented change.",
      );
      return;
    }

    setBusy(true);
    onError(null);
    try {
      await applyPrescriptionDocumentedChange(
        devUser,
        record.id,
        parseStructuredValue(record.changeType, raw),
      );
      setApplyValues((current) => {
        const next = { ...current };
        delete next[record.id];
        return next;
      });
      await loadDocuments();
      await onMutated(
        `${humanChangeType(record.changeType)} change applied to structured prescription data. Pharmacist review will see the documented amendment.`,
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to apply documented change to the prescription.",
      );
    } finally {
      setBusy(false);
    }
  }

  const previewIsImage =
    selectedDocument?.mimeType.startsWith("image/") &&
    selectedDocument.mimeType !== "image/tiff";
  const previewIsPdf =
    selectedDocument?.mimeType === "application/pdf";

  return (
    <section className="panel prescription-document-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Source prescription</p>
          <h2>Document Vault / Visual Rx</h2>
        </div>
        <div className="document-heading-actions">
          {activeChangeCount > 0 && (
            <span className="document-change-alert">
              {activeChangeCount} documented change
              {activeChangeCount === 1 ? "" : "s"}
            </span>
          )}
          {canManage && (
            <label className="secondary-button document-upload-button">
              {busy ? "Working…" : "Scan / add original"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/tiff,application/pdf"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  void uploadOriginal(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          )}
        </div>
      </div>

      <p className="document-vault-note">
        Originals are immutable. Visual boxes are separate overlays and never
        alter source pixels or the original electronic prescription rendering.
      </p>

      {prescription.status === "PHARMACIST_REVIEW" &&
        activeChangeCount > 0 && (
          <div className="document-review-alert">
            <strong>
              {activeChangeCount} documented prescription change
              {activeChangeCount === 1 ? "" : "s"} — pharmacist review
            </strong>
            <span>
              Review the opaque visual note(s) and the separate provenance
              record before final verification.
            </span>
          </div>
        )}

      {documents.length > 0 && (
        <div className="document-tabs">
          {documents.map((document, index) => (
            <button
              type="button"
              className={
                document.id === selectedDocumentId
                  ? "document-tab active"
                  : "document-tab"
              }
              key={document.id}
              onClick={() => {
                setSelectedDocumentId(document.id);
                setDraftRect(null);
                setRevisionOf(null);
              }}
            >
              {document.sourceType === "ELECTRONIC_RENDER"
                ? "eRx visual"
                : document.originalFilename ||
                  "Original " + String(index + 1)}
            </button>
          ))}
        </div>
      )}

      {selectedDocument ? (
        <div className="prescription-document-layout">
          <div>
            <div className="document-source-meta">
              <span>
                {selectedDocument.sourceType.replaceAll("_", " ")}
              </span>
              <span>
                SHA-256{" "}
                <code>
                  {selectedDocument.sha256.slice(0, 16)}…
                </code>
              </span>
              <span>
                {selectedDocument.encrypted
                  ? "Encrypted at rest"
                  : "Development storage — encryption key not configured"}
              </span>
            </div>

            <div
              className={
                drawMode
                  ? "prescription-visual prescription-visual-drawing"
                  : "prescription-visual"
              }
              ref={viewerRef}
              onPointerDown={beginDraw}
              onPointerMove={updateDraw}
              onPointerUp={endDraw}
            >
              {previewIsImage && blobUrl && (
                <img
                  src={blobUrl}
                  alt="Immutable prescription source"
                  draggable={false}
                />
              )}
              {previewIsPdf && blobUrl && (
                <object
                  data={blobUrl}
                  type="application/pdf"
                  className="prescription-pdf"
                >
                  PDF preview is unavailable in this browser.
                </object>
              )}
              {!previewIsImage && !previewIsPdf && (
                <div className="empty-state">
                  This stored source type is retained immutably but cannot be
                  visually annotated in the current browser.
                </div>
              )}

              {previewIsImage &&
                selectedDocument.annotations
                  .filter(
                    (annotation) => annotation.status === "ACTIVE",
                  )
                  .map((annotation, index) => (
                    <button
                      type="button"
                      className="prescription-annotation-box"
                      style={{
                        left: percent(annotation.x),
                        top: percent(annotation.y),
                        width: percent(annotation.width),
                        height: percent(annotation.height),
                      }}
                      title="Open change documentation"
                      onClick={(event) => {
                        event.stopPropagation();
                        beginRevision(annotation);
                      }}
                      key={annotation.id}
                    >
                      <span className="annotation-number">
                        {index + 1}
                      </span>
                      <span>{annotation.text}</span>
                    </button>
                  ))}

              {previewIsImage && draftRect && (
                <div
                  className="prescription-annotation-box draft"
                  style={{
                    left: percent(draftRect.x),
                    top: percent(draftRect.y),
                    width: percent(draftRect.width),
                    height: percent(draftRect.height),
                  }}
                >
                  {draftForm.text || "New note"}
                </div>
              )}
            </div>

            {canManage && previewIsImage && (
              <div className="action-row document-draw-actions">
                <button
                  type="button"
                  className={
                    drawMode
                      ? "primary-button"
                      : "secondary-button"
                  }
                  disabled={busy}
                  onClick={() => {
                    setDraftRect(null);
                    setRevisionOf(null);
                    setDraftForm(emptyChangeForm);
                    setDrawMode((value) => !value);
                  }}
                >
                  {drawMode
                    ? "Drag a box on the prescription…"
                    : "Draw opaque text box"}
                </button>
                {draftRect && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => {
                      setDraftRect(null);
                      setRevisionOf(null);
                      setDraftForm(emptyChangeForm);
                    }}
                  >
                    Cancel annotation
                  </button>
                )}
              </div>
            )}
          </div>

          <aside className="prescription-change-sidebar">
            {draftRect ? (
              <div className="document-change-editor">
                <p className="eyebrow">
                  {revisionOf
                    ? "Revision"
                    : "New visual annotation"}
                </p>
                <h3>
                  {revisionOf
                    ? "Revise note and documentation"
                    : "Document change"}
                </h3>

                <label>
                  Text shown on prescription
                  <textarea
                    rows={3}
                    value={draftForm.text}
                    onChange={(event) =>
                      setDraftForm((current) => ({
                        ...current,
                        text: event.target.value,
                      }))
                    }
                    placeholder="Example: PER MD: TAKE 1 TABLET BID"
                  />
                </label>

                <label>
                  Change type
                  <select
                    value={draftForm.changeType}
                    onChange={(event) =>
                      setDraftForm((current) => ({
                        ...current,
                        changeType:
                          event.target
                            .value as PrescriptionChangeType,
                        structuredValue: "",
                      }))
                    }
                  >
                    {(
                      [
                        "SIG",
                        "QUANTITY",
                        "REFILLS",
                        "DRUG",
                        "STRENGTH",
                        "DOSAGE_FORM",
                        "DAW",
                        "PRESCRIBER",
                        "WRITTEN_DATE",
                        "OTHER",
                      ] as PrescriptionChangeType[]
                    ).map((type) => (
                      <option value={type} key={type}>
                        {humanChangeType(type)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  What changed
                  <textarea
                    rows={3}
                    value={draftForm.whatChanged}
                    onChange={(event) =>
                      setDraftForm((current) => ({
                        ...current,
                        whatChanged: event.target.value,
                      }))
                    }
                    placeholder={'Example: "once daily" → "twice daily"'}
                  />
                </label>

                <label>
                  Why
                  <textarea
                    rows={3}
                    value={draftForm.reason}
                    onChange={(event) =>
                      setDraftForm((current) => ({
                        ...current,
                        reason: event.target.value,
                      }))
                    }
                    placeholder="Example: Clarified with prescriber office"
                  />
                </label>

                <label>
                  Communication
                  <select
                    value={draftForm.communicationMethod}
                    onChange={(event) =>
                      setDraftForm((current) => ({
                        ...current,
                        communicationMethod:
                          event.target.value as
                            | PrescriptionChangeCommunicationMethod
                            | "",
                      }))
                    }
                  >
                    <option value="">Not specified</option>
                    <option value="PHONE">Phone</option>
                    <option value="FAX">Fax</option>
                    <option value="ELECTRONIC">
                      Electronic
                    </option>
                    <option value="IN_PERSON">In person</option>
                    <option value="OTHER">Other</option>
                  </select>
                </label>

                <label>
                  Spoke with / contacted
                  <input
                    value={draftForm.contactedParty}
                    onChange={(event) =>
                      setDraftForm((current) => ({
                        ...current,
                        contactedParty: event.target.value,
                      }))
                    }
                    placeholder="Name and role if known"
                  />
                </label>

                <label>
                  Authorizing prescriber
                  <input
                    value={draftForm.authorizingPrescriber}
                    onChange={(event) =>
                      setDraftForm((current) => ({
                        ...current,
                        authorizingPrescriber:
                          event.target.value,
                      }))
                    }
                    placeholder="Prescriber name if applicable"
                  />
                </label>

                {draftForm.changeType !== "OTHER" && (
                  <label>
                    New structured Rx value
                    <input
                      value={draftForm.structuredValue}
                      onChange={(event) =>
                        setDraftForm((current) => ({
                          ...current,
                          structuredValue: event.target.value,
                        }))
                      }
                      placeholder={structuredValueHint(
                        draftForm.changeType,
                      )}
                    />
                    <small>
                      This value is stored with the documentation and can be
                      applied to the actual prescription record. The visual
                      text box alone never changes dispensing data.
                    </small>
                  </label>
                )}

                <label>
                  Additional note
                  <textarea
                    rows={3}
                    value={draftForm.note}
                    onChange={(event) =>
                      setDraftForm((current) => ({
                        ...current,
                        note: event.target.value,
                      }))
                    }
                  />
                </label>

                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    busy ||
                    !draftForm.text.trim() ||
                    !draftForm.whatChanged.trim() ||
                    !draftForm.reason.trim() ||
                    (draftForm.changeType !== "OTHER" &&
                      !draftForm.structuredValue.trim())
                  }
                  onClick={() => void saveAnnotation()}
                >
                  {revisionOf
                    ? "Save revision"
                    : "Save annotation + change record"}
                </button>
              </div>
            ) : (
              <>
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">
                      Separate provenance
                    </p>
                    <h3>Change documentation</h3>
                  </div>
                </div>
                <div className="prescription-change-list">
                  {[...selectedDocument.annotations]
                    .sort(
                      (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                    )
                    .map((annotation) => (
                      <article
                        className={
                          annotation.status === "SUPERSEDED"
                            ? "prescription-change-card superseded"
                            : "prescription-change-card"
                        }
                        key={annotation.id}
                      >
                        <div className="prescription-change-card-heading">
                          <strong>{annotation.text}</strong>
                          <span>{annotation.status}</span>
                        </div>
                        {annotation.changeRecord && (
                          <>
                            <p>
                              <b>
                                {humanChangeType(
                                  annotation.changeRecord
                                    .changeType,
                                )}
                              </b>
                              {" · "}
                              {
                                annotation.changeRecord
                                  .whatChanged
                              }
                            </p>
                            <p>
                              {annotation.changeRecord.reason}
                            </p>
                            <dl>
                              <div>
                                <dt>Changed by</dt>
                                <dd>
                                  {
                                    annotation.changeRecord
                                      .changedBy.displayName
                                  }
                                  {" · "}
                                  {
                                    annotation.changeRecord
                                      .changedBy.role
                                  }
                                </dd>
                              </div>
                              <div>
                                <dt>When</dt>
                                <dd>
                                  {new Date(
                                    annotation.changeRecord
                                      .changedAt,
                                  ).toLocaleString()}
                                </dd>
                              </div>
                              <div>
                                <dt>Communication</dt>
                                <dd>
                                  {annotation.changeRecord
                                    .communicationMethod ?? "—"}
                                </dd>
                              </div>
                              <div>
                                <dt>Contacted</dt>
                                <dd>
                                  {annotation.changeRecord
                                    .contactedParty ?? "—"}
                                </dd>
                              </div>
                              <div>
                                <dt>Authorized by</dt>
                                <dd>
                                  {annotation.changeRecord
                                    .authorizingPrescriber ?? "—"}
                                </dd>
                              </div>
                            </dl>
                            {annotation.changeRecord.requiresStructuredApply && (
                              <div className="document-structured-change">
                                <strong>
                                  {annotation.changeRecord.appliedAt
                                    ? `Applied to Rx data: ${annotation.changeRecord.appliedField ?? "structured field"}`
                                    : "Structured Rx update required"}
                                </strong>
                                {annotation.changeRecord.appliedAt ? (
                                  <span>
                                    Applied{" "}
                                    {new Date(
                                      annotation.changeRecord.appliedAt,
                                    ).toLocaleString()}
                                    {annotation.changeRecord.reviewedAt
                                      ? ` · pharmacist acknowledged ${new Date(
                                          annotation.changeRecord.reviewedAt,
                                        ).toLocaleString()}`
                                      : ""}
                                  </span>
                                ) : (
                                  <>
                                    <input
                                      value={
                                        applyValues[
                                          annotation.changeRecord.id
                                        ] ??
                                        structuredValueText(
                                          annotation.changeRecord.afterValue,
                                        )
                                      }
                                      placeholder={structuredValueHint(
                                        annotation.changeRecord.changeType,
                                      )}
                                      onChange={(event) =>
                                        setApplyValues((current) => ({
                                          ...current,
                                          [annotation.changeRecord!.id]:
                                            event.target.value,
                                        }))
                                      }
                                    />
                                    <small>
                                      {structuredValueHint(
                                        annotation.changeRecord.changeType,
                                      )}
                                    </small>
                                    {annotation.status === "ACTIVE" &&
                                      canManage && (
                                        <button
                                          type="button"
                                          className="primary-button"
                                          disabled={busy}
                                          onClick={() =>
                                            void applyChange(
                                              annotation.changeRecord!,
                                            )
                                          }
                                        >
                                          Apply to Rx Data
                                        </button>
                                      )}
                                  </>
                                )}
                              </div>
                            )}
                          </>
                        )}
                        {annotation.status === "ACTIVE" &&
                          canManage && (
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={busy}
                              onClick={() =>
                                beginRevision(annotation)
                              }
                            >
                              Revise
                            </button>
                          )}
                      </article>
                    ))}
                  {selectedDocument.annotations.length === 0 && (
                    <div className="empty-state">
                      No documented visual changes on this
                      prescription.
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      ) : (
        <div className="empty-state">
          {prescription.sourceType === "ELECTRONIC"
            ? canManage
              ? "Creating a human-readable ePrescription visual…"
              : "No rendered electronic prescription is available."
            : "No prescription source image has been stored yet."}
        </div>
      )}
    </section>
  );
}
