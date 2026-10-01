import { useEffect, useMemo, useState } from "react";
import {
  adjustInventoryBalance,
  getInventoryBalances,
} from "../api";
import type { DevUser, InventoryBalance } from "../types";
import { canCorrectInventory } from "../workflow";
import { CycleCounts } from "./CycleCounts";
import { InventoryHolds } from "./InventoryHolds";
import { InventoryTransfers } from "./InventoryTransfers";
import { InventoryRecalls } from "./InventoryRecalls";
import { PurchaseOrders } from "./PurchaseOrders";
import { InventoryArchitecture } from "./InventoryArchitecture";

function quantity(value: string | number) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export function Inventory({
  devUser,
  user,
  onError,
}: {
  devUser: string;
  user?: DevUser;
  onError: (message: string | null) => void;
}) {
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [operationsVersion, setOperationsVersion] = useState(0);
  const correctable = canCorrectInventory(user);

  async function refresh() {
    if (!devUser) return;
    try {
      setBalances(await getInventoryBalances(devUser));
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to load inventory.",
      );
    }
  }

  async function refreshOperations() {
    await refresh();
    setOperationsVersion((value) => value + 1);
  }

  useEffect(() => {
    void refresh();
  }, [devUser]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return balances;

    return balances.filter((balance) => {
      const product = balance.product;
      const lot = balance.productLot;
      return [
        product?.medication.genericName,
        product?.medication.brandName,
        product?.ndc,
        product?.manufacturer.name,
        lot?.lotNumber,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized));
    });
  }, [balances, query]);

  async function submitAdjustment() {
    if (!selectedId || !reason.trim()) return;
    const parsedDelta = Number(delta);
    if (!Number.isFinite(parsedDelta) || parsedDelta === 0) return;

    setBusy(true);
    onError(null);
    try {
      await adjustInventoryBalance(devUser, selectedId, {
        delta: parsedDelta,
        reason: reason.trim(),
      });
      setSelectedId(null);
      setDelta("");
      setReason("");
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to adjust inventory balance.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Inventory ledger</p>
          <h2>On-hand stock by NDC, lot, and expiration</h2>
        </div>
        <input
          className="search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search drug, NDC, manufacturer, lot"
        />
      </div>

      <p className="catalog-help inventory-ledger-help">
        Available quantity equals on-hand minus active fill reservations.
        Pharmacist verification commits a reservation as dispensed inventory.
      </p>

      <div className="table-wrap">
        <table className="compact-table inventory-table">
          <thead>
            <tr>
              <th>Drug / NDC</th>
              <th>Lot</th>
              <th>Expiration</th>
              <th>On hand</th>
              <th>Reserved</th>
              <th>Quarantined</th>
              <th>Available</th>
              <th>Last movement</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((balance) => {
              const latest = balance.transactions?.[0];
              return (
                <tr key={balance.id}>
                  <td>
                    <strong>
                      {balance.product?.medication.genericName ?? "Unknown product"}{" "}
                      {balance.product?.medication.strength ?? ""}
                    </strong>
                    <span className="cell-subtext">
                      NDC {balance.product?.ndc ?? balance.productId}
                      {balance.product?.manufacturer.name
                        ? ` · ${balance.product.manufacturer.name}`
                        : ""}
                    </span>
                  </td>
                  <td className="mono">
                    {balance.productLot?.lotNumber ?? balance.productLotId}
                  </td>
                  <td>
                    {balance.productExpiration?.expirationDate
                      ? new Date(
                          balance.productExpiration.expirationDate,
                        ).toLocaleDateString()
                      : "—"}
                  </td>
                  <td>{quantity(balance.onHandQuantity)}</td>
                  <td>{quantity(balance.reservedQuantity)}</td>
                  <td>{quantity(balance.quarantinedQuantity)}</td>
                  <td>
                    <strong>{quantity(balance.availableQuantity)}</strong>
                  </td>
                  <td>
                    {latest ? (
                      <>
                        <strong>{latest.type.replaceAll("_", " ")}</strong>
                        <span className="cell-subtext">
                          {new Date(latest.occurredAt).toLocaleString()}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {correctable && (
                      <button
                        className="secondary-button table-action"
                        type="button"
                        onClick={() => {
                          setSelectedId(balance.id);
                          setDelta("");
                          setReason("");
                        }}
                      >
                        Adjust
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="empty-state">
                  No inventory balances match this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedId && correctable && (
        <div className="inventory-adjustment-panel">
          <div>
            <p className="eyebrow">Pharmacist inventory correction</p>
            <h3>Adjust on-hand quantity</h3>
            <p className="catalog-help">
              Enter a positive number to add stock or a negative number to
              remove stock. The adjustment cannot reduce on-hand below reserved
              quantity, and every adjustment is permanently logged.
            </p>
          </div>
          <label>
            Quantity adjustment
            <input
              type="number"
              step="0.001"
              value={delta}
              onChange={(event) => setDelta(event.target.value)}
              placeholder="Example: -5"
              disabled={busy}
            />
          </label>
          <label>
            Required reason
            <textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Example: Cycle count found 5 fewer tablets than system balance."
              disabled={busy}
            />
          </label>
          <div className="action-row">
            <button
              className="danger-button"
              type="button"
              disabled={
                busy ||
                !reason.trim() ||
                !delta ||
                Number(delta) === 0 ||
                !Number.isFinite(Number(delta))
              }
              onClick={() =>
                window.confirm(
                  "Post this audited inventory adjustment?",
                ) && void submitAdjustment()
              }
            >
              Post adjustment
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setSelectedId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <InventoryArchitecture
        devUser={devUser}
        user={user}
        balances={balances}
        onError={onError}
        onInventoryChanged={refreshOperations}
      />

      <InventoryTransfers
        devUser={devUser}
        user={user}
        balances={balances}
        onError={onError}
        onBalancesChanged={refreshOperations}
      />

      <PurchaseOrders
        devUser={devUser}
        user={user}
        onError={onError}
        onInventoryChanged={refreshOperations}
      />

      <InventoryRecalls
        devUser={devUser}
        user={user}
        balances={balances}
        onError={onError}
        onInventoryChanged={refreshOperations}
      />

      <InventoryHolds
        key={operationsVersion}
        devUser={devUser}
        user={user}
        balances={balances}
        onError={onError}
        onBalancesChanged={refreshOperations}
      />

      <CycleCounts
        devUser={devUser}
        user={user}
        onError={onError}
        onBalancesChanged={refreshOperations}
      />
    </section>
  );
}
