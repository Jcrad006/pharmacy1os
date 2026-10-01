import { useEffect, useMemo, useState } from "react";
import {
  closeInventoryRecall,
  createInventoryRecall,
  getInventoryRecalls,
} from "../api";
import type {
  DevUser,
  InventoryBalance,
  InventoryRecall,
} from "../types";
import { canCorrectInventory } from "../workflow";

function qty(value: string | number) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export function InventoryRecalls({
  devUser,
  user,
  balances,
  onError,
  onInventoryChanged,
}: {
  devUser: string;
  user?: DevUser;
  balances: InventoryBalance[];
  onError: (message: string | null) => void;
  onInventoryChanged: () => Promise<void>;
}) {
  const [recalls, setRecalls] = useState<InventoryRecall[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [productLotId, setProductLotId] = useState("");
  const [source, setSource] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [reason, setReason] = useState("");
  const [closureNote, setClosureNote] = useState("");
  const [busy, setBusy] = useState(false);
  const correctable = canCorrectInventory(user);

  async function refresh(preferredId?: string | null) {
    if (!devUser) return;
    try {
      const next = await getInventoryRecalls(devUser);
      setRecalls(next);
      setSelectedId(
        preferredId ??
          selectedId ??
          next.find((recall) => recall.status === "OPEN")?.id ??
          next[0]?.id ??
          null,
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to load recalls.",
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, [devUser]);

  const lots = useMemo(() => {
    const seen = new Set<string>();
    return balances.filter((balance) => {
      if (seen.has(balance.productLotId)) return false;
      seen.add(balance.productLotId);
      return true;
    });
  }, [balances]);

  const selected =
    recalls.find((recall) => recall.id === selectedId) ?? null;

  async function openRecall() {
    if (!productLotId || !reason.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const result = await createInventoryRecall(devUser, {
        productLotId,
        source: source.trim() || undefined,
        referenceNumber: referenceNumber.trim() || undefined,
        reason: reason.trim(),
      });
      setProductLotId("");
      setSource("");
      setReferenceNumber("");
      setReason("");
      await Promise.all([
        refresh(result.recall.id),
        onInventoryChanged(),
      ]);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to open recall.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function closeRecall() {
    if (!selected || !closureNote.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const result = await closeInventoryRecall(
        devUser,
        selected.id,
        closureNote.trim(),
      );
      setClosureNote("");
      await refresh(result.recall.id);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to close recall.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel inventory-recall-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Lot recall management</p>
          <h2>Recall impact & affected fills</h2>
        </div>
      </div>

      <p className="catalog-help">
        Opening a recall quarantines currently available stock, invalidates
        unsafe active Product Fill reservations, blocks recalled product from
        verification and sale, and snapshots every previously identified fill
        for follow-up.
      </p>

      {correctable && (
        <div className="recall-create-grid">
          <label className="wide">
            Product / lot
            <select
              value={productLotId}
              onChange={(event) => setProductLotId(event.target.value)}
              disabled={busy}
            >
              <option value="">Select affected lot</option>
              {lots.map((balance) => (
                <option key={balance.productLotId} value={balance.productLotId}>
                  {balance.product?.medication.genericName ?? "Unknown"}{" "}
                  {balance.product?.medication.strength ?? ""} · NDC{" "}
                  {balance.product?.ndc ?? balance.productId} · Lot{" "}
                  {balance.productLot?.lotNumber ?? balance.productLotId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              disabled={busy}
              placeholder="FDA, manufacturer, wholesaler..."
            />
          </label>
          <label>
            Recall/reference number
            <input
              value={referenceNumber}
              onChange={(event) => setReferenceNumber(event.target.value)}
              disabled={busy}
              placeholder="Optional external reference"
            />
          </label>
          <label className="wide">
            Recall reason
            <textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              placeholder="Document the recall notice and why this lot must be removed from dispensing."
            />
          </label>
          <div className="wide">
            <button
              className="danger-button"
              type="button"
              disabled={busy || !productLotId || !reason.trim()}
              onClick={() =>
                window.confirm(
                  "Open this lot recall? Current available stock will be quarantined and affected active fills will be invalidated.",
                ) && void openRecall()
              }
            >
              Open lot recall
            </button>
          </div>
        </div>
      )}

      <div className="recall-layout">
        <div className="recall-list">
          {recalls.map((recall) => (
            <button
              key={recall.id}
              type="button"
              className={
                recall.id === selectedId
                  ? "recall-card active"
                  : "recall-card"
              }
              onClick={() => setSelectedId(recall.id)}
            >
              <span>
                <strong>
                  {recall.product.medication.genericName}{" "}
                  {recall.product.medication.strength}
                </strong>
                <small>
                  NDC {recall.product.ndc} · Lot {recall.productLot.lotNumber}
                </small>
              </span>
              <span>
                <span className={`status status-${recall.status.toLowerCase()}`}>
                  {recall.status}
                </span>
                <small>{recall.summary.affectedFillCount} affected fills</small>
              </span>
            </button>
          ))}
          {recalls.length === 0 && (
            <p className="empty-state">No recalls have been recorded.</p>
          )}
        </div>

        {selected && (
          <div className="recall-detail">
            <div className="recall-summary-grid">
              <div>
                <span>Status</span>
                <strong>{selected.status}</strong>
              </div>
              <div>
                <span>Quarantined</span>
                <strong>{qty(selected.summary.quarantinedQuantity)}</strong>
              </div>
              <div>
                <span>Ready / Will Call</span>
                <strong>{selected.summary.readyFillCount}</strong>
              </div>
              <div>
                <span>Already sold</span>
                <strong>{selected.summary.soldFillCount}</strong>
              </div>
            </div>

            <div className="recall-context">
              <p>
                <strong>Lot:</strong> {selected.productLot.lotNumber} ·{" "}
                <strong>NDC:</strong> {selected.product.ndc}
              </p>
              {selected.referenceNumber && (
                <p>
                  <strong>Reference:</strong> {selected.referenceNumber}
                </p>
              )}
              {selected.source && (
                <p>
                  <strong>Source:</strong> {selected.source}
                </p>
              )}
              <p>
                <strong>Reason:</strong> {selected.reason}
              </p>
              <p className="catalog-help">
                Opened by {selected.initiatedBy.displayName} on{" "}
                {new Date(selected.initiatedAt).toLocaleString()}.
              </p>
            </div>

            <h3>Affected fills</h3>
            <div className="table-wrap">
              <table className="compact-table recall-fill-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Rx / Fill</th>
                    <th>Status when identified</th>
                    <th>Current status</th>
                    <th>Quantity</th>
                    <th>Dispensed / sold</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.affectedFills.map((affected) => {
                    const rx = affected.fill.prescription;
                    return (
                      <tr key={affected.id}>
                        <td>
                          <strong>
                            {rx.patient.lastName}, {rx.patient.firstName}
                          </strong>
                          <span className="cell-subtext">
                            DOB{" "}
                            {rx.patient.dateOfBirth
                              ? new Date(
                                  rx.patient.dateOfBirth,
                                ).toLocaleDateString()
                              : "—"}
                          </span>
                        </td>
                        <td>
                          <strong>Rx {rx.rxNumber ?? "—"}</strong>
                          <span className="cell-subtext">
                            Fill #{affected.fill.fillNumber}
                          </span>
                        </td>
                        <td>
                          <strong>
                            {affected.fillStatusAtIdentification.replaceAll(
                              "_",
                              " ",
                            )}
                          </strong>
                          <span className="cell-subtext">
                            Rx{" "}
                            {affected.prescriptionStatusAtIdentification.replaceAll(
                              "_",
                              " ",
                            )}
                          </span>
                        </td>
                        <td>
                          {affected.fill.status.replaceAll("_", " ")}
                          <span className="cell-subtext">
                            Rx {rx.status.replaceAll("_", " ")}
                          </span>
                        </td>
                        <td>{qty(affected.fill.quantity ?? 0)}</td>
                        <td>
                          {affected.fill.soldAt
                            ? `Sold ${new Date(
                                affected.fill.soldAt,
                              ).toLocaleString()}`
                            : affected.fill.filledAt
                              ? `Filled ${new Date(
                                  affected.fill.filledAt,
                                ).toLocaleString()}`
                              : "Not dispensed"}
                        </td>
                      </tr>
                    );
                  })}
                  {selected.affectedFills.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty-state">
                        No fills had been associated with this lot when the
                        recall was opened.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {selected.status === "OPEN" && correctable && (
              <div className="recall-close-panel">
                <label>
                  Required closure note
                  <textarea
                    rows={3}
                    value={closureNote}
                    onChange={(event) => setClosureNote(event.target.value)}
                    disabled={busy}
                    placeholder="Document why the recall can be closed. Quarantined stock is not automatically released."
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !closureNote.trim()}
                  onClick={() =>
                    window.confirm(
                      "Close this recall? Existing quarantine holds will remain in place until separately released or disposed.",
                    ) && void closeRecall()
                  }
                >
                  Close recall
                </button>
              </div>
            )}

            {selected.status === "CLOSED" && (
              <div className="recall-closed-note">
                <strong>Recall closed.</strong>
                <p>{selected.closureNote ?? "No closure note."}</p>
                {selected.closedBy && (
                  <span className="cell-subtext">
                    {selected.closedBy.displayName}
                    {selected.closedAt
                      ? ` · ${new Date(selected.closedAt).toLocaleString()}`
                      : ""}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
