import { useEffect, useMemo, useState } from "react";
import {
  addTransferCustodyEvent,
  cancelInventoryTransfer,
  createInventoryTransfer,
  getInventorySites,
  getInventoryTransfers,
  getTransferCustodyEvents,
  receiveInventoryTransfer,
} from "../api";
import type {
  DevUser,
  InventoryBalance,
  InventoryTransfer,
  PharmacySiteSummary,
  TransferCustodyEvent,
} from "../types";
import {
  canCorrectInventory,
  canWriteInventory,
} from "../workflow";

function qty(value: string | number) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function balanceLabel(balance: InventoryBalance) {
  const product = balance.product;
  return [
    product
      ? `${product.medication.genericName} ${product.medication.strength}`
      : balance.productId,
    product?.ndc ? `NDC ${product.ndc}` : null,
    balance.productLot?.lotNumber ? `Lot ${balance.productLot.lotNumber}` : null,
    `${qty(balance.availableQuantity)} available`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function InventoryTransfers({
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
  const [sites, setSites] = useState<PharmacySiteSummary[]>([]);
  const [transfers, setTransfers] = useState<InventoryTransfer[]>([]);
  const [balanceId, setBalanceId] = useState("");
  const [destinationSiteId, setDestinationSiteId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [transferIdempotencyKey, setTransferIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [custodyEvents, setCustodyEvents] = useState<
    Record<string, TransferCustodyEvent[]>
  >({});
  const [handoffCarrier, setHandoffCarrier] = useState("");
  const [handoffTracking, setHandoffTracking] = useState("");
  const [handoffSeal, setHandoffSeal] = useState("");
  const [busy, setBusy] = useState(false);

  const correctable = canCorrectInventory(user);
  const writable = canWriteInventory(user);

  async function refresh() {
    if (!devUser) return;
    try {
      const [nextSites, nextTransfers] = await Promise.all([
        getInventorySites(devUser),
        getInventoryTransfers(devUser),
      ]);
      setSites(nextSites);
      setTransfers(nextTransfers);
      const active = nextTransfers.filter(
        (transfer) => transfer.status === "IN_TRANSIT",
      );
      const custody = await Promise.all(
        active.map(async (transfer) => [
          transfer.id,
          await getTransferCustodyEvents(devUser, transfer.id),
        ] as const),
      );
      setCustodyEvents(Object.fromEntries(custody));
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load inventory transfers.",
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, [devUser]);

  const destinations = useMemo(
    () => sites.filter((site) => site.id !== user?.siteId),
    [sites, user?.siteId],
  );

  async function ship() {
    const amount = Number(quantity);
    if (
      !correctable ||
      !balanceId ||
      !destinationSiteId ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return;
    }

    setBusy(true);
    onError(null);
    try {
      await createInventoryTransfer(devUser, {
        destinationSiteId,
        sourceInventoryBalanceId: balanceId,
        quantity: amount,
        note: note.trim() || undefined,
        idempotencyKey: transferIdempotencyKey,
      });
      setBalanceId("");
      setDestinationSiteId("");
      setQuantity("");
      setNote("");
      setTransferIdempotencyKey(crypto.randomUUID());
      await Promise.all([refresh(), onBalancesChanged()]);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to create inventory transfer.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function receive(transferId: string) {
    setBusy(true);
    onError(null);
    try {
      await receiveInventoryTransfer(devUser, transferId);
      await Promise.all([refresh(), onBalancesChanged()]);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to receive inventory transfer.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyTransfer(transferId: string) {
    setBusy(true);
    onError(null);
    try {
      await addTransferCustodyEvent(devUser, transferId, {
        type: "VERIFIED",
        note: "Second-person verification completed before receipt.",
      });
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to verify transfer.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handOffTransfer(transferId: string) {
    setBusy(true);
    onError(null);
    try {
      await addTransferCustodyEvent(devUser, transferId, {
        type: "HANDED_OFF",
        carrier: handoffCarrier.trim() || undefined,
        trackingReference: handoffTracking.trim() || undefined,
        sealIdentifier: handoffSeal.trim() || undefined,
        note: "Transfer released to courier/carrier.",
      });
      setHandoffCarrier("");
      setHandoffTracking("");
      setHandoffSeal("");
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to record handoff.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!cancelId || !cancelReason.trim()) return;
    setBusy(true);
    onError(null);
    try {
      await cancelInventoryTransfer(devUser, cancelId, cancelReason.trim());
      setCancelId(null);
      setCancelReason("");
      await Promise.all([refresh(), onBalancesChanged()]);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to cancel inventory transfer.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel inventory-operations-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Inter-site transfers</p>
          <h2>Move traceable stock between pharmacy locations</h2>
        </div>
      </div>

      <p className="catalog-help">
        Shipping immediately removes the transferred quantity from the source
        site's on-hand inventory. The destination does not receive usable stock
        until a staff member at that site confirms receipt.
      </p>

      {correctable && destinations.length > 0 && (
        <div className="inventory-operation-form transfer-form">
          <label className="wide">
            Source inventory
            <select
              value={balanceId}
              onChange={(event) => setBalanceId(event.target.value)}
              disabled={busy}
            >
              <option value="">Select NDC / lot / expiration</option>
              {balances
                .filter((balance) => Number(balance.availableQuantity) > 0)
                .map((balance) => (
                  <option key={balance.id} value={balance.id}>
                    {balanceLabel(balance)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Destination pharmacy
            <select
              value={destinationSiteId}
              onChange={(event) => setDestinationSiteId(event.target.value)}
              disabled={busy}
            >
              <option value="">Select destination</option>
              {destinations.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="wide">
            Transfer note
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Optional reason or courier/reference note"
              disabled={busy}
            />
          </label>
          <div className="wide">
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                !balanceId ||
                !destinationSiteId ||
                !quantity ||
                !Number.isFinite(Number(quantity)) ||
                Number(quantity) <= 0
              }
              onClick={() =>
                window.confirm(
                  "Ship this quantity and remove it from source on-hand inventory?",
                ) && void ship()
              }
            >
              Ship transfer
            </button>
          </div>
        </div>
      )}

      {writable && (
        <div className="inventory-operation-form">
          <label>
            Carrier / courier
            <input
              value={handoffCarrier}
              onChange={(event) => setHandoffCarrier(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <label>
            Tracking / reference
            <input
              value={handoffTracking}
              onChange={(event) => setHandoffTracking(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <label>
            Seal identifier
            <input
              value={handoffSeal}
              onChange={(event) => setHandoffSeal(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <p className="catalog-help wide">
            These values are used when recording a Hand off custody event.
          </p>
        </div>
      )}

      <div className="table-wrap">
        <table className="compact-table inventory-transfer-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Product / lot</th>
              <th>Quantity</th>
              <th>From → To</th>
              <th>Shipped</th>
              <th>Custody</th>
              <th>Received / cancelled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((transfer) => (
              <tr key={transfer.id}>
                <td>
                  <span className={`status status-${transfer.status.toLowerCase().replaceAll("_", "-")}`}>
                    {transfer.status.replaceAll("_", " ")}
                  </span>
                </td>
                <td>
                  <strong>
                    {transfer.sourceInventoryBalance.product?.medication.genericName ??
                      "Unknown"}{" "}
                    {transfer.sourceInventoryBalance.product?.medication.strength ?? ""}
                  </strong>
                  <span className="cell-subtext">
                    NDC {transfer.sourceInventoryBalance.product?.ndc ?? transfer.productId}
                    {" · "}Lot {transfer.lotNumber}
                    {" · "}Exp {new Date(transfer.expirationDate).toLocaleDateString()}
                  </span>
                </td>
                <td>{qty(transfer.quantity)}</td>
                <td>
                  {transfer.sourceSite.name}
                  <span className="cell-subtext">
                    → {transfer.destinationSite.name}
                  </span>
                </td>
                <td>
                  {transfer.initiatedBy.displayName}
                  <span className="cell-subtext">
                    {new Date(transfer.shippedAt).toLocaleString()}
                  </span>
                </td>
                <td>
                  <div className="receipt-history">
                    {(custodyEvents[transfer.id] ?? transfer.custodyEvents ?? []).map(
                      (event) => (
                        <span key={event.id}>
                          {event.type.replaceAll("_", " ")}
                          {event.actor?.displayName
                            ? ` · ${event.actor.displayName}`
                            : ""}
                          {event.carrier ? ` · ${event.carrier}` : ""}
                          {event.trackingReference
                            ? ` · ${event.trackingReference}`
                            : ""}
                        </span>
                      ),
                    )}
                    {(custodyEvents[transfer.id] ?? transfer.custodyEvents ?? [])
                      .length === 0 && <span>—</span>}
                  </div>
                </td>
                <td>
                  {transfer.status === "RECEIVED" ? (
                    <>
                      {transfer.receivedBy?.displayName ?? "Received"}
                      <span className="cell-subtext">
                        {transfer.receivedAt
                          ? new Date(transfer.receivedAt).toLocaleString()
                          : ""}
                      </span>
                    </>
                  ) : transfer.status === "CANCELLED" ? (
                    <>
                      {transfer.cancelledBy?.displayName ?? "Cancelled"}
                      <span className="cell-subtext">
                        {transfer.cancelledAt
                          ? new Date(transfer.cancelledAt).toLocaleString()
                          : ""}
                      </span>
                    </>
                  ) : (
                    "In transit"
                  )}
                </td>
                <td>
                  <div className="table-action-stack">
                    {transfer.status === "IN_TRANSIT" &&
                      transfer.destinationSiteId === user?.siteId &&
                      writable && (
                        <button
                          type="button"
                          className="primary-button table-action"
                          disabled={busy}
                          onClick={() =>
                            window.confirm(
                              "Confirm physical receipt of this transfer into destination inventory?",
                            ) && void receive(transfer.id)
                          }
                        >
                          Receive
                        </button>
                      )}
                    {transfer.status === "IN_TRANSIT" &&
                      transfer.sourceSiteId === user?.siteId &&
                      correctable && (
                        <button
                          type="button"
                          className="secondary-button table-action"
                          disabled={
                            busy ||
                            (custodyEvents[transfer.id] ?? []).some(
                              (event) => event.type === "VERIFIED",
                            )
                          }
                          onClick={() => void verifyTransfer(transfer.id)}
                        >
                          Verify
                        </button>
                      )}
                    {transfer.status === "IN_TRANSIT" &&
                      transfer.sourceSiteId === user?.siteId &&
                      writable && (
                        <button
                          type="button"
                          className="secondary-button table-action"
                          disabled={busy}
                          onClick={() =>
                            window.confirm(
                              "Record this transfer as handed to the carrier?",
                            ) && void handOffTransfer(transfer.id)
                          }
                        >
                          Hand off
                        </button>
                      )}
                    {transfer.status === "IN_TRANSIT" &&
                      transfer.sourceSiteId === user?.siteId &&
                      correctable && (
                        <button
                          type="button"
                          className="secondary-button table-action"
                          disabled={busy}
                          onClick={() => {
                            setCancelId(transfer.id);
                            setCancelReason("");
                          }}
                        >
                          Cancel
                        </button>
                      )}
                  </div>
                </td>
              </tr>
            ))}
            {transfers.length === 0 && (
              <tr>
                <td colSpan={8} className="empty-state">
                  No inter-site inventory transfers have been recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {cancelId && correctable && (
        <div className="inventory-operation-resolution">
          <label>
            Required cancellation reason
            <textarea
              rows={3}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="action-row">
            <button
              type="button"
              className="danger-button"
              disabled={busy || !cancelReason.trim()}
              onClick={() =>
                window.confirm(
                  "Cancel this in-transit transfer and restore the quantity to the source inventory?",
                ) && void cancel()
              }
            >
              Cancel transfer
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setCancelId(null)}
            >
              Keep transfer
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
