import { useEffect, useMemo, useState } from "react";
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getMedications,
  getPurchaseOrders,
  receivePurchaseOrderLine,
} from "../api";
import type {
  DevUser,
  Medication,
  PurchaseOrder,
} from "../types";
import {
  canCorrectInventory,
  canWriteInventory,
} from "../workflow";

type DraftLine = {
  key: number;
  productId: string;
  quantityOrdered: string;
  unitCost: string;
};

type ReceiptDraft = {
  quantity: string;
  lotNumber: string;
  expirationDate: string;
  invoiceReference: string;
  idempotencyKey: string;
};

function qty(value: string | number) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export function PurchaseOrders({
  devUser,
  user,
  onError,
  onInventoryChanged,
}: {
  devUser: string;
  user?: DevUser;
  onError: (message: string | null) => void;
  onInventoryChanged: () => Promise<void>;
}) {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [orderNumber, setOrderNumber] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [note, setNote] = useState("");
  const [expectedDeliveryAt, setExpectedDeliveryAt] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([
    { key: 1, productId: "", quantityOrdered: "", unitCost: "" },
  ]);
  const [receiptDrafts, setReceiptDrafts] = useState<
    Record<string, ReceiptDraft>
  >({});
  const [busy, setBusy] = useState(false);
  const writable = canWriteInventory(user);
  const correctable = canCorrectInventory(user);

  async function refresh() {
    if (!devUser) return;
    try {
      const [nextOrders, nextMedications] = await Promise.all([
        getPurchaseOrders(devUser),
        getMedications(devUser),
      ]);
      setOrders(nextOrders);
      setMedications(nextMedications);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load purchase orders.",
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, [devUser]);

  const products = useMemo(
    () =>
      medications.flatMap((medication) =>
        medication.products.map((product) => ({
          ...product,
          medication,
        })),
      ),
    [medications],
  );

  function updateLine(
    key: number,
    field: keyof Omit<DraftLine, "key">,
    value: string,
  ) {
    setDraftLines((current) =>
      current.map((line) =>
        line.key === key ? { ...line, [field]: value } : line,
      ),
    );
  }

  function addLine() {
    setDraftLines((current) => [
      ...current,
      {
        key: Math.max(0, ...current.map((line) => line.key)) + 1,
        productId: "",
        quantityOrdered: "",
        unitCost: "",
      },
    ]);
  }

  async function create() {
    const normalized = draftLines.map((line) => ({
      productId: line.productId,
      quantityOrdered: Number(line.quantityOrdered),
      unitCost: line.unitCost ? Number(line.unitCost) : undefined,
    }));

    if (
      !writable ||
      !orderNumber.trim() ||
      !supplierName.trim() ||
      normalized.length === 0 ||
      normalized.some(
        (line) =>
          !line.productId ||
          !Number.isFinite(line.quantityOrdered) ||
          line.quantityOrdered <= 0 ||
          (line.unitCost !== undefined &&
            (!Number.isFinite(line.unitCost) || line.unitCost < 0)),
      )
    ) {
      return;
    }

    setBusy(true);
    onError(null);
    try {
      await createPurchaseOrder(devUser, {
        orderNumber: orderNumber.trim(),
        supplierName: supplierName.trim(),
        note: note.trim() || undefined,
        expectedDeliveryAt: expectedDeliveryAt
          ? new Date(expectedDeliveryAt).toISOString()
          : undefined,
        lines: normalized,
      });
      setOrderNumber("");
      setSupplierName("");
      setNote("");
      setExpectedDeliveryAt("");
      setDraftLines([
        { key: 1, productId: "", quantityOrdered: "", unitCost: "" },
      ]);
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to create purchase order.",
      );
    } finally {
      setBusy(false);
    }
  }

  function receiptDraft(lineId: string): ReceiptDraft {
    return (
      receiptDrafts[lineId] ?? {
        quantity: "",
        lotNumber: "",
        expirationDate: "",
        invoiceReference: "",
      }
    );
  }

  function updateReceipt(
    lineId: string,
    field: keyof ReceiptDraft,
    value: string,
  ) {
    setReceiptDrafts((current) => ({
      ...current,
      [lineId]: {
        ...receiptDraft(lineId),
        [field]: value,
      },
    }));
  }

  async function receive(orderId: string, lineId: string) {
    const draft = receiptDraft(lineId);
    const amount = Number(draft.quantity);
    if (
      !writable ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !draft.lotNumber.trim() ||
      !draft.expirationDate
    ) {
      return;
    }

    setBusy(true);
    onError(null);
    try {
      await receivePurchaseOrderLine(devUser, orderId, lineId, {
        quantity: amount,
        lotNumber: draft.lotNumber.trim(),
        expirationDate: new Date(
          `${draft.expirationDate}T00:00:00.000Z`,
        ).toISOString(),
        invoiceReference: draft.invoiceReference.trim() || undefined,
        idempotencyKey: draft.idempotencyKey,
      });
      setReceiptDrafts((current) => {
        const next = { ...current };
        delete next[lineId];
        return next;
      });
      await Promise.all([refresh(), onInventoryChanged()]);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to receive purchase-order line.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancel(orderId: string) {
    setBusy(true);
    onError(null);
    try {
      await cancelPurchaseOrder(devUser, orderId);
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to cancel purchase order.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel inventory-operations-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Purchase orders</p>
          <h2>Wholesaler order & receiving reconciliation</h2>
        </div>
      </div>

      <p className="catalog-help">
        Purchase-order receipts create normal inventory ledger entries and
        require lot/expiration traceability. Partial receipts are preserved and
        over-receiving beyond the ordered quantity is blocked.
      </p>

      {writable && (
        <div className="purchase-order-create">
          <div className="inventory-operation-form">
            <label>
              PO number
              <input
                value={orderNumber}
                onChange={(event) => setOrderNumber(event.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              Supplier / wholesaler
              <input
                value={supplierName}
                onChange={(event) => setSupplierName(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="wide">
              Order note
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={busy}
                placeholder="Optional"
              />
            </label>
            <label>
              Expected delivery
              <input
                type="datetime-local"
                value={expectedDeliveryAt}
                onChange={(event) => setExpectedDeliveryAt(event.target.value)}
                disabled={busy}
              />
            </label>
          </div>

          <div className="purchase-order-lines">
            {draftLines.map((line, index) => (
              <div className="purchase-order-line-editor" key={line.key}>
                <label>
                  Product / NDC
                  <select
                    value={line.productId}
                    onChange={(event) =>
                      updateLine(line.key, "productId", event.target.value)
                    }
                    disabled={busy}
                  >
                    <option value="">Select product</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.medication.genericName}{" "}
                        {product.medication.strength} · NDC {product.ndc} ·{" "}
                        {product.manufacturer.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Quantity ordered
                  <input
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={line.quantityOrdered}
                    onChange={(event) =>
                      updateLine(
                        line.key,
                        "quantityOrdered",
                        event.target.value,
                      )
                    }
                    disabled={busy}
                  />
                </label>
                <label>
                  Unit cost
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={line.unitCost}
                    onChange={(event) =>
                      updateLine(line.key, "unitCost", event.target.value)
                    }
                    disabled={busy}
                    placeholder="Optional"
                  />
                </label>
                {draftLines.length > 1 && (
                  <button
                    type="button"
                    className="secondary-button table-action"
                    disabled={busy}
                    onClick={() =>
                      setDraftLines((current) =>
                        current.filter((item) => item.key !== line.key),
                      )
                    }
                  >
                    Remove
                  </button>
                )}
                <span className="cell-subtext">Line {index + 1}</span>
              </div>
            ))}
          </div>

          <div className="action-row">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={addLine}
            >
              Add line
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                !orderNumber.trim() ||
                !supplierName.trim() ||
                draftLines.some(
                  (line) =>
                    !line.productId ||
                    !line.quantityOrdered ||
                    !Number.isFinite(Number(line.quantityOrdered)) ||
                    Number(line.quantityOrdered) <= 0,
                )
              }
              onClick={() => void create()}
            >
              Create purchase order
            </button>
          </div>
        </div>
      )}

      <div className="purchase-order-list">
        {orders.map((order) => (
          <article className="purchase-order-card" key={order.id}>
            <div className="purchase-order-header">
              <div>
                <span className={`status status-${order.status.toLowerCase().replaceAll("_", "-")}`}>
                  {order.status.replaceAll("_", " ")}
                </span>
                <h3>{order.orderNumber}</h3>
                <p className="cell-subtext">
                  {order.supplierName} · Created by {order.createdBy.displayName}
                  {" · "}{new Date(order.createdAt).toLocaleString()}
                  {order.expectedDeliveryAt
                    ? ` · Expected ${new Date(order.expectedDeliveryAt).toLocaleString()}`
                    : ""}
                </p>
              </div>
              {correctable &&
                !["RECEIVED", "CANCELLED"].includes(order.status) && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      window.confirm(
                        "Cancel the remaining unreceived portion of this purchase order?",
                      ) && void cancel(order.id)
                    }
                  >
                    Cancel PO
                  </button>
                )}
            </div>

            {order.note && <p>{order.note}</p>}

            <div className="table-wrap">
              <table className="compact-table purchase-order-table">
                <thead>
                  <tr>
                    <th>Product / NDC</th>
                    <th>Ordered</th>
                    <th>Received</th>
                    <th>Remaining</th>
                    <th>Receipt history</th>
                    <th>Receive stock</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => {
                    const ordered = Number(line.quantityOrdered);
                    const received = Number(line.quantityReceived);
                    const remaining = Math.max(0, ordered - received);
                    const draft = receiptDraft(line.id);

                    return (
                      <tr key={line.id}>
                        <td>
                          <strong>
                            {line.product.medication.genericName}{" "}
                            {line.product.medication.strength}
                          </strong>
                          <span className="cell-subtext">
                            NDC {line.product.ndc} ·{" "}
                            {line.product.manufacturer.name}
                          </span>
                        </td>
                        <td>{qty(line.quantityOrdered)}</td>
                        <td>{qty(line.quantityReceived)}</td>
                        <td>
                          <strong>{qty(remaining)}</strong>
                        </td>
                        <td>
                          {line.receipts.length === 0 ? (
                            "—"
                          ) : (
                            <div className="receipt-history">
                              {line.receipts.map((receipt) => (
                                <span key={receipt.id}>
                                  {qty(receipt.quantity)} · Lot{" "}
                                  {receipt.lotNumber} ·{" "}
                                  {new Date(
                                    receipt.receivedAt,
                                  ).toLocaleDateString()}
                                  {receipt.invoiceReference
                                    ? ` · ${receipt.invoiceReference}`
                                    : ""}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>
                          {writable &&
                          remaining > 0 &&
                          order.status !== "CANCELLED" ? (
                            <div className="po-receipt-form">
                              <input
                                type="number"
                                min="0.001"
                                max={remaining}
                                step="0.001"
                                placeholder="Qty"
                                value={draft.quantity}
                                onChange={(event) =>
                                  updateReceipt(
                                    line.id,
                                    "quantity",
                                    event.target.value,
                                  )
                                }
                                disabled={busy}
                              />
                              <input
                                placeholder="Lot"
                                value={draft.lotNumber}
                                onChange={(event) =>
                                  updateReceipt(
                                    line.id,
                                    "lotNumber",
                                    event.target.value,
                                  )
                                }
                                disabled={busy}
                              />
                              <input
                                type="date"
                                value={draft.expirationDate}
                                onChange={(event) =>
                                  updateReceipt(
                                    line.id,
                                    "expirationDate",
                                    event.target.value,
                                  )
                                }
                                disabled={busy}
                              />
                              <input
                                placeholder="Invoice/ref"
                                value={draft.invoiceReference}
                                onChange={(event) =>
                                  updateReceipt(
                                    line.id,
                                    "invoiceReference",
                                    event.target.value,
                                  )
                                }
                                disabled={busy}
                              />
                              <button
                                type="button"
                                className="primary-button table-action"
                                disabled={
                                  busy ||
                                  !draft.quantity ||
                                  !Number.isFinite(Number(draft.quantity)) ||
                                  Number(draft.quantity) <= 0 ||
                                  Number(draft.quantity) > remaining ||
                                  !draft.lotNumber.trim() ||
                                  !draft.expirationDate
                                }
                                onClick={() =>
                                  window.confirm(
                                    "Post this physical receipt against the purchase order?",
                                  ) && void receive(order.id, line.id)
                                }
                              >
                                Receive
                              </button>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>
        ))}
        {orders.length === 0 && (
          <p className="empty-state">No purchase orders have been recorded.</p>
        )}
      </div>
    </section>
  );
}
