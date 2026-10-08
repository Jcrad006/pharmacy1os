import { useEffect, useState, type FormEvent } from "react";
import {
  createDurIssue,
  createIntervention,
  getClinicalRecord,
  resolveDurIssue,
  updatePrescription,
} from "../api";
import type {
  DevUser,
  DurIssue,
  DurSeverity,
  InterventionNote,
  PrescriptionQueueItem,
} from "../types";
import { canDocumentClinical, canEditPrescription } from "../workflow";

export function ClinicalPanel({
  prescription,
  devUser,
  user,
  onChanged,
  onError,
  onBlockersChanged,
}: {
  prescription: PrescriptionQueueItem;
  devUser: string;
  user?: DevUser;
  onChanged: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
  onBlockersChanged?: (count: number | null) => void;
}) {
  const [issues, setIssues] = useState<DurIssue[]>([]);
  const [interventions, setInterventions] = useState<InterventionNote[]>([]);
  const [expirationDate, setExpirationDate] = useState("");
  const [minimumDays, setMinimumDays] = useState("");
  const [issueCode, setIssueCode] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [severity, setSeverity] = useState<DurSeverity>("WARNING");
  const [note, setNote] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const documentAllowed = canDocumentClinical(user);
  const editAllowed = canEditPrescription(user);

  async function load(isCurrent: () => boolean = () => true) {
    if (!devUser) return;
    try {
      const result = await getClinicalRecord(devUser, prescription.id);
      // Responses for an older identity/Rx must never authorize the current user.
      if (!isCurrent()) return;
      setIssues(result.issues);
      setInterventions(result.interventions);
      onBlockersChanged?.(
        result.issues.filter(
          (issue) => issue.status === "OPEN" && issue.severity === "HIGH",
        ).length,
      );
    } catch (error) {
      if (isCurrent()) {
        onError(error instanceof Error ? error.message : "Unable to load clinical record.");
      }
    }
  }

  useEffect(() => {
    let current = true;
    // Fail closed during the clinical refresh; the verifier cannot advance
    // until the clinical record for this Rx and identity has returned.
    onBlockersChanged?.(null);
    setExpirationDate(
      prescription.expirationDate
        ? prescription.expirationDate.slice(0, 10)
        : "",
    );
    setMinimumDays(
      prescription.minimumDaysBetweenFills === null
        ? ""
        : String(prescription.minimumDaysBetweenFills),
    );
    void load(() => current);
    return () => {
      current = false;
    };
  }, [prescription.id, prescription.updatedAt, devUser]);

  async function saveRules(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await updatePrescription(devUser, prescription.id, {
        expirationDate: expirationDate
          ? new Date(`${expirationDate}T00:00:00Z`).toISOString()
          : null,
        minimumDaysBetweenFills: minimumDays === "" ? null : Number(minimumDays),
      });
      await onChanged("Synthetic dispensing date rules updated.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to update date rules.");
    } finally {
      setBusy(false);
    }
  }

  async function addIssue(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await createDurIssue(devUser, prescription.id, {
        code: issueCode,
        title: issueTitle,
        description: issueDescription || undefined,
        severity,
      });
      setIssueCode("");
      setIssueTitle("");
      setIssueDescription("");
      setSeverity("WARNING");
      await onChanged("Synthetic DUR issue added.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to add DUR issue.");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(issueId: string) {
    const resolutionNote = resolutionNotes[issueId]?.trim();
    if (!resolutionNote) {
      onError("A resolution note is required before closing a DUR issue.");
      return;
    }

    setBusy(true);
    onError(null);
    try {
      await resolveDurIssue(devUser, issueId, resolutionNote);
      setResolutionNotes((current) => {
        const next = { ...current };
        delete next[issueId];
        return next;
      });
      await onChanged("DUR issue resolved with documented disposition.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to resolve DUR issue.");
    } finally {
      setBusy(false);
    }
  }

  async function addIntervention(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await createIntervention(devUser, prescription.id, note);
      setNote("");
      await onChanged("Pharmacist intervention documented.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to record intervention.");
    } finally {
      setBusy(false);
    }
  }

  const openIssues = issues.filter((issue) => issue.status === "OPEN");
  const resolvedIssues = issues.filter((issue) => issue.status === "RESOLVED");
  const highBlockers = openIssues.filter((issue) => issue.severity === "HIGH");

  return (
    <section className="panel clinical-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Synthetic clinical workflow</p>
          <h2>Clinical / DUR</h2>
        </div>
        <span className="clinical-disclaimer">
          Development rules only — not a validated drug-knowledge system
        </span>
      </div>

      {highBlockers.length > 0 && (
        <div className="clinical-blocker-banner">
          <strong>
            {highBlockers.length} HIGH DUR issue{highBlockers.length === 1 ? "" : "s"} block final pharmacist verification.
          </strong>
          <span>
            Resolve the HIGH issue(s) with a documented resolution note before the prescription can move to Ready.
          </span>
        </div>
      )}

      <div className="clinical-grid">
        <div>
          <h3>Dispensing date rules</h3>
          <form className="stack-form" onSubmit={saveRules}>
            <label>
              Prescription expiration date
              <input
                type="date"
                value={expirationDate}
                onChange={(event) => setExpirationDate(event.target.value)}
                disabled={!editAllowed || busy}
              />
            </label>
            <label>
              Minimum days between sold fills
              <input
                type="number"
                min="0"
                max="365"
                step="1"
                value={minimumDays}
                onChange={(event) => setMinimumDays(event.target.value)}
                placeholder="No synthetic interval rule"
                disabled={!editAllowed || busy}
              />
            </label>
            <button className="secondary-button" type="submit" disabled={!editAllowed || busy}>
              Save date rules
            </button>
          </form>
          {prescription.doNotFillBefore && (
            <p className="clinical-caption">
              Do not fill before: {new Date(prescription.doNotFillBefore).toLocaleString()}
            </p>
          )}
        </div>

        <div>
          <h3>Open DUR issues</h3>
          <div className="dur-list">
            {openIssues.map((issue) => (
              <article className={`dur-card dur-${issue.severity.toLowerCase()}`} key={issue.id}>
                <div className="dur-heading">
                  <div>
                    <strong>{issue.title}</strong>
                    <span>{issue.code} · {issue.source}</span>
                  </div>
                  <span className="severity-badge">{issue.severity}</span>
                </div>
                {issue.description && <p>{issue.description}</p>}
                {issue.eligibleAt && (
                  <p className="clinical-caption">
                    Eligible at: {new Date(issue.eligibleAt).toLocaleString()}
                  </p>
                )}
                {documentAllowed && (
                  <div className="dur-resolution">
                    <label>
                      Resolution note
                      <textarea
                        rows={2}
                        maxLength={4000}
                        value={resolutionNotes[issue.id] ?? ""}
                        onChange={(event) =>
                          setResolutionNotes((current) => ({
                            ...current,
                            [issue.id]: event.target.value,
                          }))
                        }
                        placeholder="Document why this issue is being resolved."
                      />
                    </label>
                    <button
                      className="secondary-button"
                      disabled={busy || !(resolutionNotes[issue.id]?.trim())}
                      onClick={() => void resolve(issue.id)}
                    >
                      Resolve issue
                    </button>
                  </div>
                )}
              </article>
            ))}
            {openIssues.length === 0 && <p className="muted">No open DUR issues.</p>}
          </div>
        </div>
      </div>

      {documentAllowed && (
        <div className="clinical-grid clinical-entry-grid">
          <div>
            <h3>Add synthetic DUR issue</h3>
            <form className="stack-form" onSubmit={addIssue}>
              <label>Code<input value={issueCode} onChange={(event) => setIssueCode(event.target.value)} required /></label>
              <label>Title<input value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} required /></label>
              <label>Description<textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} /></label>
              <label>
                Severity
                <select value={severity} onChange={(event) => setSeverity(event.target.value as DurSeverity)}>
                  <option value="INFO">Info</option>
                  <option value="WARNING">Warning</option>
                  <option value="HIGH">High</option>
                </select>
              </label>
              <button className="primary-button" type="submit" disabled={busy}>Add synthetic issue</button>
            </form>
          </div>

          <div>
            <h3>Pharmacist intervention</h3>
            <form className="stack-form" onSubmit={addIntervention}>
              <label>
                Intervention note
                <textarea
                  rows={5}
                  maxLength={4000}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  required
                  placeholder="Document communication, clarification, recommendation, or resolution."
                />
              </label>
              <button className="primary-button" type="submit" disabled={busy}>Record intervention</button>
            </form>
          </div>
        </div>
      )}

      <div className="clinical-history">
        <div>
          <h3>Interventions</h3>
          <div className="note-list">
            {interventions.map((item) => (
              <article className="clinical-note" key={item.id}>
                <p>{item.note}</p>
                <span>{item.author.displayName} · {item.author.role} · {new Date(item.createdAt).toLocaleString()}</span>
              </article>
            ))}
            {interventions.length === 0 && <p className="muted">No intervention notes.</p>}
          </div>
        </div>

        <div>
          <h3>Resolved DUR issues</h3>
          <div className="note-list">
            {resolvedIssues.map((issue) => (
              <article className="clinical-note" key={issue.id}>
                <strong>{issue.title}</strong>
                <p>{issue.description ?? issue.code}</p>
                {issue.resolutionNote && (
                  <p><strong>Resolution:</strong> {issue.resolutionNote}</p>
                )}
                <span>
                  Resolved {issue.resolvedAt ? new Date(issue.resolvedAt).toLocaleString() : ""}
                  {issue.resolvedAutomatically
                    ? " automatically by date-rule reconciliation"
                    : issue.resolvedBy
                      ? ` by ${issue.resolvedBy.displayName}`
                      : ""}
                </span>
              </article>
            ))}
            {resolvedIssues.length === 0 && <p className="muted">No resolved DUR issues.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
