import { useEffect, useMemo, useState } from "react";
import {
  disposeInventoryHold,
  getInventoryHolds,
  quarantineInventoryBalance,
  releaseInventoryHold,
} from "../api";
import type {
  DevUser,
  InventoryBalance,
  InventoryDispositionType,
  InventoryHold,
  InventoryHoldReason,
} from "../types";
import { canCorrectInventory, canWriteInventory } from "../workflow";

const holdReasons: Array<{
  value: InventoryHoldReason;
  label: string;
}> = [
  { value: "DAMAGED", label: "Damaged stock" },
  { value: "EXPIRED", label: "Expired stock" },
  { value: "RECALL", label: "Recall" },
  { value: "SUSPECT_PRODUCT", label: "Suspect product" },
  { value: "TEMPERATURE_EXCURSION", label: "Temperature excursion" },
  { value: "OTHER", label: "Other" },
];

const dispositions: Array<{
  value: InventoryDispositionType;
  label: string;
}> = [
  { value: "DESTROY", label: "Destroy / waste" },
  { value: "RETURN_TO_VENDOR", label: "Return to vendor" },
  { value: "REVERSE_DISTRIBUTOR", label: "Reverse distributor" },
  { value: "OTHER", label: "Other disposition" },
];

function quantity(value: string | number) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function balanceLabel(balance: InventoryBalance) {
  const product = balance.product;
  const lot = balance.productLot;
  return [
    product
      ? `${product.medication.genericName} ${product.medication.strength}`
      : balance.productId,
    product?.ndc ? `NDC ${product.ndc}` : null,
    lot?.lotNumber ? `Lot ${lot.lotNumber}` : null,
    `${quantity(balance.availableQuantity)} available`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function InventoryHolds({
  devUser,
  user,
  balances,
  onError,
  onBalancesChanged,
}: {
  devUser: string;
  user?: DevUser;
  balances: InventoryBalance[];
  onError: (message: string | null) => void;
  onBalancesChanged: () => Promise<void>;
}) {
  const [holds, setHolds] = useState<InventoryHold[]>([]);
  const [balanceId, setBalanceId] = useState("");
  const [holdQuantity, setHoldQuantity] = useState("");
  const [reasonCode, setReasonCode] =
    useState<InventoryHoldReason>("SUSPECT_PRODUCT");
  const [note, setNote] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [dispositionType, setDispositionType] =
    useState<InventoryDispositionType>("DESTROY");
  const [busy, setBusy] = useState(false);

  const writable = canWriteInventory(user);
  const correctable = canCorrectInventory(user);

  async function refresh() {
    if (!devUser) return;
    try {
      setHolds(await getInventoryHolds(devUser));
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load quarantine holds.",
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, [devUser]);

  const orderedHolds = useMemo(
    () =>
      [...holds].sort((a, b) => {
        if (a.status === "ACTIVE" && b.status !== "ACTIVE") return -1;
        if (a.status !== "ACTIVE" && b.status === "ACTIVE") return 1;
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      }),
    [holds],
  );

  async function quarantine() {
    const amount = Number(holdQuantity);
    if (
      !balanceId ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !reasonCode
    ) {
      return;
    }

    setBusy(true);
    onError(null);
    try {
      await quarantineInventoryBalance(devUser, balanceId, {
        quantity: amount,
        reasonCode,
        note: note.trim() || undefined,
      });
      setHoldQuantity("");
      setNote("");
      setBalanceId("");
      await Promise.all([refresh(), onBalancesChanged()]);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to quarantine stock.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    if (!resolvingId || !resolutionNote.trim()) return;

    setBusy(true);
    onError(null);
    try {
      await releaseInventoryHold(
        devUser,
        resolvingId,
        resolutionNote.trim(),
      );
      setResolvingId(null);
      setResolutionNote("");
      await Promise.all([refresh(), onBalancesChanged()]);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to release quarantined stock.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function dispose() {
    if (!resolvingId || !resolutionNote.trim()) return;

    setBusy(true);
    onError(null);
    try {
      await disposeInventoryHold(devUser, resolvingId, {
        dispositionType,
        resolutionNote: resolutionNote.trim(),
      });
      setResolvingId(null);
      setResolutionNote("");
      await Promise.all([refresh(), onBalancesChanged()]);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to dispose quarantined stock.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel inventory-hold-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Quarantine & disposition</p>
          <h2>Non-dispensable physical stock</h2>
        </div>
      </div>

      <p className="catalog-help">
        Quarantined stock remains physically on hand but is removed from
        available dispensing inventory. Any staff member with inventory-write
        access may quarantine suspect stock; only a pharmacist/admin may release
        it or permanently dispose/return it.
      </p>

      {writable && (
        <div className="inventory-hold-create">
          <label className="wide">
            Inventory balance
            <select
              value={balanceId}
              onChange={(event) => setBalanceId(event.target.value)}
              disabled={busy}
            >
              <option value="">Select NDC / lot / expiration</option>
              {balances.map((balance) => (
                <option key={balance.id} value={balance.id}>
                  {balanceLabel(balance)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity to quarantine
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={holdQuantity}
              onChange={(event) => setHoldQuantity(event.target.value)}
              disabled={busy}
              placeholder="Example: 30"
            />
          </label>
          <label>
            Reason
            <select
              value={reasonCode}
              onChange={(event) =>
                setReasonCode(event.target.value as InventoryHoldReason)
              }
              disabled={busy}
            >
              {holdReasons.map((reason) => (
                <option key={reason.value} value={reason.value}>
                  {reason.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wide">
            Note
            <textarea
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={busy}
              placeholder="Optional details, e.g. bottle damaged in shipment or lot placed on recall hold."
            />
          </label>
          <div className="wide">
            <button
              type="button"
              className="danger-button"
              disabled={
                busy ||
                !balanceId ||
                !holdQuantity ||
                !Number.isFinite(Number(holdQuantity)) ||
                Number(holdQuantity) <= 0
              }
              onClick={() =>
                window.confirm(
                  "Quarantine this quantity and remove it from dispensing availability?",
                ) && void quarantine()
              }
            >
              Quarantine stock
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap inventory-hold-table-wrap">
        <table className="compact-table inventory-hold-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Drug / NDC</th>
              <th>Lot / Exp</th>
              <th>Quantity</th>
              <th>Reason</th>
              <th>Created</th>
              <th>Resolution</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orderedHolds.map((hold) => {
              const balance = hold.inventoryBalance;
              const product = balance.product;
              return (
                <tr key={hold.id}>
                  <td>
                    <span className={`status status-${hold.status.toLowerCase()}`}>
                      {hold.status}
                    </span>
                  </td>
                  <td>
                    <strong>
                      {product?.medication.genericName ?? "Unknown"}{" "}
                      {product?.medication.strength ?? ""}
                    </strong>
                    <span className="cell-subtext">
                      NDC {product?.ndc ?? balance.productId}
                    </span>
                  </td>
                  <td>
                    <span className="mono">
                      {balance.productLot?.lotNumber ?? "—"}
                    </span>
                    <span className="cell-subtext">
                      {balance.productExpiration?.expirationDate
                        ? new Date(
                            balance.productExpiration.expirationDate,
                          ).toLocaleDateString()
                        : "—"}
                    </span>
                  </td>
                  <td>{quantity(hold.quantity)}</td>
                  <td>
                    <strong>{hold.reasonCode.replaceAll("_", " ")}</strong>
                    {hold.note && (
                      <span className="cell-subtext">{hold.note}</span>
                    )}
                  </td>
                  <td>
                    {hold.createdBy.displayName}
                    <span className="cell-subtext">
                      {new Date(hold.createdAt).toLocaleString()}
                    </span>
                  </td>
                  <td>
                    {hold.status === "ACTIVE" ? (
                      "Awaiting resolution"
                    ) : (
                      <>
                        <strong>
                          {hold.status === "DISPOSED"
                            ? hold.dispositionType?.replaceAll("_", " ")
                            : "Released"}
                        </strong>
                        {hold.resolutionNote && (
                          <span className="cell-subtext">
                            {hold.resolutionNote}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {hold.status === "ACTIVE" && correctable && (
                      <button
                        type="button"
                        className="secondary-button table-action"
                        onClick={() => {
                          setResolvingId(hold.id);
                          setResolutionNote("");
                          setDispositionType("DESTROY");
                        }}
                      >
                        Resolve
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {orderedHolds.length === 0 && (
              <tr>
                <td colSpan={8} className="empty-state">
                  No quarantine holds have been recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {resolvingId && correctable && (
        <div className="inventory-hold-resolution">
          <div>
            <p className="eyebrow">Pharmacist/admin resolution</p>
            <h3>Resolve quarantined stock</h3>
          </div>
          <label>
            Required resolution note
            <textarea
              rows={3}
              value={resolutionNote}
              onChange={(event) => setResolutionNote(event.target.value)}
              disabled={busy}
              placeholder="Document investigation and rationale."
            />
          </label>
          <label>
            Disposition if permanently removed
            <select
              value={dispositionType}
              onChange={(event) =>
                setDispositionType(
                  event.target.value as InventoryDispositionType,
                )
              }
              disabled={busy}
            >
              {dispositions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div className="action-row">
            <button
              type="button"
              className="primary-button"
              disabled={busy || !resolutionNote.trim()}
              onClick={() =>
                window.confirm(
                  "Release this stock back to dispensing availability?",
                ) && void release()
              }
            >
              Release to usable stock
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy || !resolutionNote.trim()}
              onClick={() =>
                window.confirm(
                  "Permanently remove this quarantined quantity from on-hand inventory?",
                ) && void dispose()
              }
            >
              Dispose / return
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setResolvingId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
