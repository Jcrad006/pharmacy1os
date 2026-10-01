import { useEffect, useMemo, useState } from "react";
import {
  countCycleCountLine,
  createCycleCount,
  getCycleCounts,
  reviewCycleCount,
  submitCycleCount,
} from "../api";
import type {
  CycleCountLine,
  CycleCountSession,
  DevUser,
} from "../types";
import { canCorrectInventory, canWriteInventory } from "../workflow";

function qty(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function discrepancyClass(value: string | null) {
  if (value === null) return "";
  const amount = Number(value);
  if (amount === 0) return "cycle-discrepancy-none";
  return amount > 0 ? "cycle-discrepancy-positive" : "cycle-discrepancy-negative";
}

function lineLabel(line: CycleCountLine) {
  const product = line.inventoryBalance.product;
  return `${product?.medication.genericName ?? "Unknown"} ${product?.medication.strength ?? ""} · NDC ${product?.ndc ?? line.inventoryBalance.productId}`;
}

export function CycleCounts({
  devUser,
  user,
  onError,
  onBalancesChanged,
}: {
  devUser: string;
  user?: DevUser;
  onError: (message: string | null) => void;
  onBalancesChanged: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<CycleCountSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newNote, setNewNote] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [countValues, setCountValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const writable = canWriteInventory(user);
  const correctable = canCorrectInventory(user);
  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  async function refresh(preferredId?: string | null) {
    if (!devUser) return;
    try {
      const next = await getCycleCounts(devUser);
      setSessions(next);
      const nextId =
        preferredId ??
        selectedId ??
        next.find((session) =>
          ["OPEN", "SUBMITTED"].includes(session.status),
        )?.id ??
        next[0]?.id ??
        null;
      setSelectedId(nextId);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load cycle counts.",
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, [devUser]);

  useEffect(() => {
    if (!selected) return;
    const values: Record<string, string> = {};
    for (const line of selected.lines) {
      if (line.countedQuantity !== null) {
        values[line.id] = String(line.countedQuantity);
      }
    }
    setCountValues(values);
    setReviewNote(selected.reviewNote ?? "");
  }, [selectedId, selected?.status, selected?.reviewedAt]);

  const countedLines = useMemo(
    () => selected?.lines.filter((line) => line.countedQuantity !== null).length ?? 0,
    [selected],
  );
  const discrepancyLines = useMemo(
    () =>
      selected?.lines.filter(
        (line) => line.discrepancy !== null && Number(line.discrepancy) !== 0,
      ).length ?? 0,
    [selected],
  );

  async function startFullCount() {
    setBusy(true);
    onError(null);
    try {
      const result = await createCycleCount(devUser, {
        note: newNote.trim() || undefined,
      });
      setNewNote("");
      await refresh(result.session.id);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to start cycle count.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveLine(line: CycleCountLine) {
    const value = Number(countValues[line.id]);
    if (!Number.isFinite(value) || value < 0 || !selected) return;

    setBusy(true);
    onError(null);
    try {
      const result = await countCycleCountLine(
        devUser,
        selected.id,
        line.id,
        value,
      );
      setSessions((current) =>
        current.map((session) =>
          session.id === result.session.id ? result.session : session,
        ),
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to save physical count.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!selected) return;
    setBusy(true);
    onError(null);
    try {
      const result = await submitCycleCount(devUser, selected.id);
      setSessions((current) =>
        current.map((session) =>
          session.id === result.session.id ? result.session : session,
        ),
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to submit cycle count.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function review(decision: "APPROVE" | "REJECT") {
    if (!selected || !reviewNote.trim()) return;

    setBusy(true);
    onError(null);
    try {
      const result = await reviewCycleCount(devUser, selected.id, {
        decision,
        reviewNote: reviewNote.trim(),
      });
      setSessions((current) =>
        current.map((session) =>
          session.id === result.session.id ? result.session : session,
        ),
      );
      if (decision === "APPROVE") {
        await onBalancesChanged();
      }
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to review cycle count.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel cycle-count-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Cycle counts</p>
          <h2>Physical inventory reconciliation</h2>
        </div>
        <div className="cycle-count-create">
          <input
            value={newNote}
            onChange={(event) => setNewNote(event.target.value)}
            placeholder="Optional count note"
            disabled={!writable || busy}
          />
          <button
            type="button"
            className="primary-button"
            disabled={!writable || busy}
            onClick={() => void startFullCount()}
          >
            Start full cycle count
          </button>
        </div>
      </div>

      <p className="catalog-help">
        Physical counts do not change inventory immediately. Staff submit the
        completed count, then a pharmacist/admin reviews discrepancies before
        any ledger adjustment is posted. Physical counts should include all
        units physically present, including segregated/quarantined stock.
      </p>

      <div className="cycle-count-layout">
        <div className="cycle-count-list">
          {sessions.map((session) => {
            const discrepancies = session.lines.filter(
              (line) =>
                line.discrepancy !== null && Number(line.discrepancy) !== 0,
            ).length;
            return (
              <button
                type="button"
                key={session.id}
                className={
                  selectedId === session.id
                    ? "cycle-count-card active"
                    : "cycle-count-card"
                }
                onClick={() => setSelectedId(session.id)}
              >
                <span>
                  <strong>{session.status.replaceAll("_", " ")}</strong>
                  <small>
                    {new Date(session.createdAt).toLocaleString()} ·{" "}
                    {session.lines.length} lines
                  </small>
                </span>
                <span className="cycle-count-card-meta">
                  {discrepancies} discrepanc{discrepancies === 1 ? "y" : "ies"}
                </span>
              </button>
            );
          })}
          {sessions.length === 0 && (
            <p className="empty-state">No cycle counts have been created.</p>
          )}
        </div>

        {selected && (
          <div className="cycle-count-detail">
            <div className="cycle-count-summary">
              <div>
                <span>Status</span>
                <strong>{selected.status.replaceAll("_", " ")}</strong>
              </div>
              <div>
                <span>Created by</span>
                <strong>{selected.createdBy.displayName}</strong>
              </div>
              <div>
                <span>Counted</span>
                <strong>
                  {countedLines} / {selected.lines.length}
                </strong>
              </div>
              <div>
                <span>Discrepancies</span>
                <strong>{discrepancyLines}</strong>
              </div>
            </div>

            {selected.note && (
              <p className="cycle-count-note">
                <strong>Count note:</strong> {selected.note}
              </p>
            )}

            <div className="table-wrap">
              <table className="compact-table cycle-count-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Lot / Exp</th>
                    <th>System on hand</th>
                    <th>Reserved</th>
                    <th>Quarantined</th>
                    <th>Physical count</th>
                    <th>Discrepancy</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {selected.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <strong>{lineLabel(line)}</strong>
                        <span className="cell-subtext">
                          {line.inventoryBalance.product?.manufacturer.name ?? ""}
                        </span>
                      </td>
                      <td>
                        <span className="mono">
                          {line.inventoryBalance.productLot?.lotNumber ?? "—"}
                        </span>
                        <span className="cell-subtext">
                          {line.inventoryBalance.productExpiration?.expirationDate
                            ? new Date(
                                line.inventoryBalance.productExpiration
                                  .expirationDate,
                              ).toLocaleDateString()
                            : "—"}
                        </span>
                      </td>
                      <td>{qty(line.expectedOnHand)}</td>
                      <td>{qty(line.expectedReserved)}</td>
                      <td>{qty(line.expectedQuarantined)}</td>
                      <td>
                        {selected.status === "OPEN" && writable ? (
                          <input
                            className="cycle-count-input"
                            type="number"
                            min="0"
                            step="0.001"
                            value={countValues[line.id] ?? ""}
                            onChange={(event) =>
                              setCountValues((current) => ({
                                ...current,
                                [line.id]: event.target.value,
                              }))
                            }
                            disabled={busy}
                          />
                        ) : (
                          qty(line.countedQuantity)
                        )}
                      </td>
                      <td>
                        <strong className={discrepancyClass(line.discrepancy)}>
                          {line.discrepancy === null
                            ? "—"
                            : Number(line.discrepancy) > 0
                              ? `+${qty(line.discrepancy)}`
                              : qty(line.discrepancy)}
                        </strong>
                      </td>
                      <td>
                        {selected.status === "OPEN" && writable && (
                          <button
                            type="button"
                            className="secondary-button table-action"
                            disabled={
                              busy ||
                              countValues[line.id] === undefined ||
                              countValues[line.id] === "" ||
                              !Number.isFinite(Number(countValues[line.id])) ||
                              Number(countValues[line.id]) < 0
                            }
                            onClick={() => void saveLine(line)}
                          >
                            Save count
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selected.status === "OPEN" && writable && (
              <div className="cycle-count-actions">
                <p className="catalog-help">
                  Saving a count snapshots on-hand, reserved, and quarantined
                  quantities at that moment. Any later inventory movement will
                  require that line to be recounted before approval.
                </p>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || countedLines !== selected.lines.length}
                  onClick={() =>
                    window.confirm(
                      "Submit this completed cycle count for pharmacist review?",
                    ) && void submit()
                  }
                >
                  Submit for review
                </button>
              </div>
            )}

            {selected.status === "SUBMITTED" && (
              <div className="cycle-count-review">
                {correctable ? (
                  <>
                    <label>
                      Required pharmacist review note
                      <textarea
                        rows={3}
                        value={reviewNote}
                        onChange={(event) => setReviewNote(event.target.value)}
                        disabled={busy}
                        placeholder="Document the reconciliation decision and any investigation."
                      />
                    </label>
                    <div className="action-row">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy || !reviewNote.trim()}
                        onClick={() =>
                          window.confirm(
                            "Approve this cycle count and post all discrepancy adjustments?",
                          ) && void review("APPROVE")
                        }
                      >
                        Approve & reconcile
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={busy || !reviewNote.trim()}
                        onClick={() =>
                          window.confirm(
                            "Reject this cycle count without changing inventory?",
                          ) && void review("REJECT")
                        }
                      >
                        Reject count
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="permission-note">
                    Submitted. Awaiting pharmacist/admin review.
                  </p>
                )}
              </div>
            )}

            {["APPROVED", "REJECTED"].includes(selected.status) && (
              <div className="cycle-count-closed">
                <p>
                  <strong>
                    {selected.status === "APPROVED"
                      ? "Reconciliation completed."
                      : "Count rejected without inventory changes."}
                  </strong>
                </p>
                {selected.reviewedBy && (
                  <p className="catalog-help">
                    Reviewed by {selected.reviewedBy.displayName}
                    {selected.reviewedAt
                      ? ` · ${new Date(selected.reviewedAt).toLocaleString()}`
                      : ""}
                  </p>
                )}
                {selected.reviewNote && (
                  <p className="cycle-count-note">
                    <strong>Review note:</strong> {selected.reviewNote}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
