import { useEffect, useMemo, useState } from "react";
import {
  closeRecallCase,
  createRecallCase,
  getRecallCases,
} from "../api";
import type {
  DevUser,
  InventoryBalance,
  RecallCase,
} from "../types";
import { canCorrectInventory } from "../workflow";

function productLabel(balance: InventoryBalance) {
  const product = balance.product;
  return [
    product
      ? `${product.medication.genericName} ${product.medication.strength}`
      : balance.productId,
    product?.ndc ? `NDC ${product.ndc}` : null,
    balance.productLot?.lotNumber
      ? `Lot ${balance.productLot.lotNumber}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
  const [recalls, setRecalls] = useState<RecallCase[]>([]);
  const [balanceId, setBalanceId] = useState("");
  const [lotSpecific, setLotSpecific] = useState(true);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closureNote, setClosureNote] = useState("");
  const [busy, setBusy] = useState(false);

  const correctable = canCorrectInventory(user);
  const selectedBalance = balances.find((balance) => balance.id === balanceId);

  async function refresh() {
    if (!devUser || !correctable) return;
    try {
      setRecalls(await getRecallCases(devUser));
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load recall cases.",
      );
    }
  }

  useEffect(() => {
    if (correctable) {
      void refresh();
    } else {
      setRecalls([]);
    }
  }, [devUser, correctable]);

  const ordered = useMemo(
    () =>
      [...recalls].sort((a, b) => {
        if (a.status === "ACTIVE" && b.status !== "ACTIVE") return -1;
        if (a.status !== "ACTIVE" && b.status === "ACTIVE") return 1;
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      }),
    [recalls],
  );

  async function create() {
    if (
      !correctable ||
      !selectedBalance ||
      !reference.trim() ||
      !reason.trim()
    ) {
      return;
    }

    setBusy(true);
    onError(null);
    try {
      await createRecallCase(devUser, {
        productId: selectedBalance.productId,
        lotNumber: lotSpecific
          ? selectedBalance.productLot?.lotNumber
          : undefined,
        reference: reference.trim(),
        reason: reason.trim(),
      });
      setBalanceId("");
      setReference("");
      setReason("");
      setLotSpecific(true);
      await Promise.all([refresh(), onInventoryChanged()]);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to create recall case.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function closeRecall() {
    if (!closingId || !closureNote.trim()) return;
    setBusy(true);
    onError(null);
    try {
      await closeRecallCase(devUser, closingId, closureNote.trim());
      setClosingId(null);
      setClosureNote("");
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to close recall case.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!correctable) {
    return (
      <section className="panel inventory-operations-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Recall management</p>
            <h2>Recalled inventory & patient exposure tracing</h2>
          </div>
        </div>
        <p className="permission-note">
          Recall-case creation and patient exposure review are restricted to
          pharmacists/admins.
        </p>
      </section>
    );
  }

  return (
    <section className="panel inventory-operations-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Recall management</p>
          <h2>Recalled inventory & patient exposure tracing</h2>
        </div>
      </div>

      <p className="catalog-help">
        Opening a recall automatically quarantines all currently available
        matching stock. Existing reservations are flagged by the dispensing
        guard: a recalled lot cannot be newly reserved or pharmacist-verified.
        Sold fills are linked to the case for patient follow-up.
      </p>

      <div className="inventory-operation-form recall-form">
        <label className="wide">
          Recalled product / lot
          <select
            value={balanceId}
            onChange={(event) => setBalanceId(event.target.value)}
            disabled={busy}
          >
            <option value="">Select an inventory balance</option>
            {balances.map((balance) => (
              <option key={balance.id} value={balance.id}>
                {productLabel(balance)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Recall scope
          <select
            value={lotSpecific ? "LOT" : "NDC"}
            onChange={(event) => setLotSpecific(event.target.value === "LOT")}
            disabled={busy}
          >
            <option value="LOT">Specific lot</option>
            <option value="NDC">Entire NDC / product</option>
          </select>
        </label>
        <label>
          Recall reference
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="FDA / manufacturer reference"
            disabled={busy}
          />
        </label>
        <label className="wide">
          Reason / instructions
          <textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Describe the recall reason and immediate pharmacy action."
            disabled={busy}
          />
        </label>
        <div className="wide">
          <button
            type="button"
            className="danger-button"
            disabled={
              busy ||
              !selectedBalance ||
              !reference.trim() ||
              !reason.trim()
            }
            onClick={() =>
              window.confirm(
                "Open this recall case and quarantine all currently available matching stock?",
              ) && void create()
            }
          >
            Open recall & quarantine stock
          </button>
        </div>
      </div>

      <div className="recall-case-list">
        {ordered.map((recall) => (
          <article key={recall.id} className="recall-case-card">
            <div className="recall-case-header">
              <div>
                <span className={`status status-${recall.status.toLowerCase()}`}>
                  {recall.status}
                </span>
                <h3>
                  {recall.product.medication.genericName}{" "}
                  {recall.product.medication.strength}
                </h3>
                <p className="cell-subtext">
                  NDC {recall.product.ndc}
                  {recall.lotNumber ? ` · Lot ${recall.lotNumber}` : " · Entire NDC"}
                  {" · "}Reference {recall.reference}
                </p>
              </div>
              <div className="recall-summary">
                <span>{recall.holds.length} quarantine hold(s)</span>
                <span>{recall.affectedFills.length} sold fill(s) linked</span>
              </div>
            </div>

            <p>{recall.reason}</p>
            <p className="cell-subtext">
              Opened by {recall.createdBy.displayName} ·{" "}
              {new Date(recall.createdAt).toLocaleString()}
            </p>

            {recall.affectedFills.length > 0 && (
              <div className="table-wrap recall-exposure-table-wrap">
                <table className="compact-table">
                  <thead>
                    <tr>
                      <th>Affected patient</th>
                      <th>Rx</th>
                      <th>Lot</th>
                      <th>Sold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recall.affectedFills.map((affected) => (
                      <tr key={affected.id}>
                        <td>
                          <strong>
                            {affected.fill.prescription.patient.lastName},{" "}
                            {affected.fill.prescription.patient.firstName}
                          </strong>
                          <span className="cell-subtext">
                            DOB{" "}
                            {affected.fill.prescription.patient.dateOfBirth
                              ? new Date(
                                  affected.fill.prescription.patient.dateOfBirth,
                                ).toLocaleDateString()
                              : "not recorded"}
                          </span>
                        </td>
                        <td>
                          {affected.fill.prescription.rxNumber ?? "Unnumbered Rx"}
                        </td>
                        <td className="mono">
                          {affected.fill.productLot?.lotNumber ??
                            recall.lotNumber ??
                            "—"}
                        </td>
                        <td>
                          {affected.fill.soldAt
                            ? new Date(affected.fill.soldAt).toLocaleString()
                            : "Sold status recorded"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {recall.status === "ACTIVE" && (
              <div className="action-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setClosingId(recall.id);
                    setClosureNote("");
                  }}
                >
                  Close recall case
                </button>
              </div>
            )}

            {recall.status === "CLOSED" && recall.closureNote && (
              <p className="inventory-operation-resolution">
                <strong>Closure:</strong> {recall.closureNote}
              </p>
            )}
          </article>
        ))}
        {ordered.length === 0 && (
          <p className="empty-state">No recall cases have been recorded.</p>
        )}
      </div>

      {closingId && (
        <div className="inventory-operation-resolution">
          <label>
            Required closure note
            <textarea
              rows={3}
              value={closureNote}
              onChange={(event) => setClosureNote(event.target.value)}
              placeholder="Document completion of the recall response. Closing the case does not automatically release quarantine holds."
              disabled={busy}
            />
          </label>
          <div className="action-row">
            <button
              type="button"
              className="primary-button"
              disabled={busy || !closureNote.trim()}
              onClick={() =>
                window.confirm(
                  "Close this recall case? Any active quarantine holds will remain quarantined until separately resolved.",
                ) && void closeRecall()
              }
            >
              Close recall
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setClosingId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
