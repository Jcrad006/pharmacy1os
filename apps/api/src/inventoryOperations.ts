import { Prisma } from "@prisma/client";
import {
  InventoryError,
  quarantineInventory,
  receiveInventory,
  releaseInventoryReservation,
} from "./inventory.js";
import {
  adjustStockPosition,
  reconcileDemandAvailability,
} from "./inventoryArchitecture.js";

function decimal(value: Prisma.Decimal | number | string) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function positive(value: Prisma.Decimal | number | string, label = "quantity") {
  const quantity = decimal(value);
  if (quantity.lte(0)) {
    throw new InventoryError(
      400,
      "INVALID_QUANTITY",
      `${label} must be greater than zero.`,
    );
  }
  return quantity;
}

function normalizeLot(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

async function lockBalance(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "InventoryBalance" WHERE "id" = ${id} FOR UPDATE`,
  );
  const balance = await tx.inventoryBalance.findUnique({
    where: { id },
    include: {
      productLot: true,
      productExpiration: true,
      product: {
        include: {
          medication: true,
          manufacturer: true,
        },
      },
    },
  });
  if (!balance) {
    throw new InventoryError(
      404,
      "INVENTORY_NOT_FOUND",
      "Inventory balance not found.",
    );
  }
  return balance;
}

async function lockTransfer(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "InventoryTransfer" WHERE "id" = ${id} FOR UPDATE`,
  );
  const transfer = await tx.inventoryTransfer.findUnique({
    where: { id },
    include: {
      sourceSite: true,
      destinationSite: true,
      sourceInventoryBalance: {
        include: {
          product: { include: { medication: true, manufacturer: true } },
          productLot: true,
          productExpiration: true,
        },
      },
      destinationInventoryBalance: true,
      initiatedBy: {
        select: { id: true, displayName: true, role: true },
      },
      receivedBy: {
        select: { id: true, displayName: true, role: true },
      },
      cancelledBy: {
        select: { id: true, displayName: true, role: true },
      },
      transactions: {
        orderBy: { occurredAt: "asc" },
      },
    },
  });
  if (!transfer) {
    throw new InventoryError(
      404,
      "INVENTORY_TRANSFER_NOT_FOUND",
      "Inventory transfer not found.",
    );
  }
  return transfer;
}

async function upsertTraceability(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    productId: string;
    lotNumber: string;
    expirationDate: Date;
  },
) {
  const lotNumberSearch = normalizeLot(input.lotNumber);
  if (!lotNumberSearch) {
    throw new InventoryError(400, "INVALID_LOT", "A lot number is required.");
  }

  const lot = await tx.productLot.upsert({
    where: {
      siteId_productId_lotNumberSearch: {
        siteId: input.siteId,
        productId: input.productId,
        lotNumberSearch,
      },
    },
    update: { active: true },
    create: {
      siteId: input.siteId,
      productId: input.productId,
      lotNumber: input.lotNumber.trim(),
      lotNumberSearch,
      active: true,
      receivedAt: new Date(),
    },
  });

  const expiration = await tx.productExpiration.upsert({
    where: {
      siteId_productId_expirationDate: {
        siteId: input.siteId,
        productId: input.productId,
        expirationDate: input.expirationDate,
      },
    },
    update: { active: true },
    create: {
      siteId: input.siteId,
      productId: input.productId,
      expirationDate: input.expirationDate,
      active: true,
    },
  });

  return { lot, expiration };
}

export async function createInventoryTransfer(
  tx: Prisma.TransactionClient,
  input: {
    sourceSiteId: string;
    destinationSiteId: string;
    sourceInventoryBalanceId: string;
    actorId: string;
    quantity: Prisma.Decimal | number | string;
    note?: string | null;
    carrier?: string | null;
    trackingNumber?: string | null;
    sealIdentifier?: string | null;
    custodyReference?: string | null;
    idempotencyKey?: string | null;
  },
) {
  if (input.sourceSiteId === input.destinationSiteId) {
    throw new InventoryError(
      400,
      "TRANSFER_SAME_SITE",
      "Source and destination pharmacy sites must be different.",
    );
  }

  if (input.idempotencyKey) {
    const existing = await tx.inventoryTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { inventoryTransfer: true },
    });
    if (existing?.inventoryTransfer) {
      return {
        transfer: existing.inventoryTransfer,
        sourceBalance: await tx.inventoryBalance.findUniqueOrThrow({
          where: { id: existing.inventoryBalanceId },
        }),
        transaction: existing,
        replayed: true,
      };
    }
    if (existing) {
      throw new InventoryError(
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "This idempotency key was already used for another inventory operation.",
      );
    }
  }

  const destination = await tx.pharmacySite.findUnique({
    where: { id: input.destinationSiteId },
    select: { id: true, name: true },
  });
  if (!destination) {
    throw new InventoryError(
      404,
      "TRANSFER_DESTINATION_NOT_FOUND",
      "Destination pharmacy site not found.",
    );
  }

  const quantity = positive(input.quantity);
  const balance = await lockBalance(tx, input.sourceInventoryBalanceId);

  if (balance.siteId !== input.sourceSiteId) {
    throw new InventoryError(
      404,
      "INVENTORY_NOT_FOUND",
      "Source inventory balance not found at this pharmacy site.",
    );
  }

  const available = balance.onHandQuantity
    .minus(balance.reservedQuantity)
    .minus(balance.quarantinedQuantity);

  if (available.lt(quantity)) {
    throw new InventoryError(
      409,
      "INSUFFICIENT_TRANSFER_INVENTORY",
      "Only available, non-reserved, non-quarantined inventory can be transferred.",
      {
        availableQuantity: available.toString(),
        requestedQuantity: quantity.toString(),
      },
    );
  }

  const transfer = await tx.inventoryTransfer.create({
    data: {
      sourceSiteId: input.sourceSiteId,
      destinationSiteId: input.destinationSiteId,
      sourceInventoryBalanceId: balance.id,
      productId: balance.productId,
      lotNumber: balance.productLot.lotNumber,
      expirationDate: balance.productExpiration.expirationDate,
      quantity,
      note: input.note?.trim() || null,
      carrier: input.carrier?.trim() || null,
      trackingNumber: input.trackingNumber?.trim() || null,
      sealIdentifier: input.sealIdentifier?.trim() || null,
      custodyReference: input.custodyReference?.trim() || null,
      initiatedById: input.actorId,
    },
  });

  const updatedSource = await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      onHandQuantity: balance.onHandQuantity.minus(quantity),
    },
  });

  await adjustStockPosition(tx, {
    siteId: input.sourceSiteId,
    inventoryBalanceId: balance.id,
    state: "AVAILABLE",
    delta: quantity.negated(),
  });

  const transaction = await tx.inventoryTransaction.create({
    data: {
      siteId: input.sourceSiteId,
      inventoryBalanceId: balance.id,
      inventoryTransferId: transfer.id,
      actorId: input.actorId,
      type: "TRANSFER_OUT",
      onHandDelta: quantity.negated(),
      reservedDelta: 0,
      quarantinedDelta: 0,
      reason: input.note?.trim() || `Transfer to ${destination.name}`,
      source: "SITE_TRANSFER",
      reference: transfer.id,
      idempotencyKey: input.idempotencyKey?.trim() || null,
    },
  });

  await tx.inventoryTransferCustodyEvent.create({
    data: {
      transferId: transfer.id,
      siteId: input.sourceSiteId,
      actorId: input.actorId,
      type: "PACKED",
      carrier: input.carrier?.trim() || null,
      trackingNumber: input.trackingNumber?.trim() || null,
      sealIdentifier: input.sealIdentifier?.trim() || null,
      note: input.note?.trim() || null,
    },
  });

  const sourceProduct = await tx.product.findUnique({
    where: { id: balance.productId },
    select: { medicationId: true },
  });
  if (sourceProduct) {
    await reconcileDemandAvailability(
      tx,
      input.sourceSiteId,
      sourceProduct.medicationId,
    );
  }

  return { transfer, sourceBalance: updatedSource, transaction, replayed: false };
}

export async function receiveInventoryTransfer(
  tx: Prisma.TransactionClient,
  input: {
    transferId: string;
    destinationSiteId: string;
    actorId: string;
    receiptNote?: string | null;
    carrier?: string | null;
    trackingNumber?: string | null;
    sealIdentifier?: string | null;
  },
) {
  const transfer = await lockTransfer(tx, input.transferId);

  if (transfer.destinationSiteId !== input.destinationSiteId) {
    throw new InventoryError(
      404,
      "INVENTORY_TRANSFER_NOT_FOUND",
      "Inventory transfer not found for this destination site.",
    );
  }

  if (transfer.status !== "IN_TRANSIT") {
    throw new InventoryError(
      409,
      "TRANSFER_NOT_IN_TRANSIT",
      "Only an in-transit transfer can be received.",
      { status: transfer.status },
    );
  }

  const traceability = await upsertTraceability(tx, {
    siteId: transfer.destinationSiteId,
    productId: transfer.productId,
    lotNumber: transfer.lotNumber,
    expirationDate: transfer.expirationDate,
  });

  const received = await receiveInventory(tx, {
    siteId: transfer.destinationSiteId,
    actorId: input.actorId,
    productId: transfer.productId,
    productLotId: traceability.lot.id,
    productExpirationId: traceability.expiration.id,
    quantity: transfer.quantity,
    source: "SITE_TRANSFER",
    reference: transfer.id,
    reason: `Received site transfer from ${transfer.sourceSite.name}`,
    idempotencyKey: `TRANSFER_RECEIVE:${transfer.id}`,
  });

  const transferTransaction = await tx.inventoryTransaction.update({
    where: { id: received.transaction.id },
    data: {
      type: "TRANSFER_IN",
      inventoryTransferId: transfer.id,
    },
  });

  const updated = await tx.inventoryTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "RECEIVED",
      destinationInventoryBalanceId: received.balance.id,
      receivedById: input.actorId,
      receivedAt: new Date(),
      carrier: input.carrier?.trim() || transfer.carrier,
      trackingNumber: input.trackingNumber?.trim() || transfer.trackingNumber,
      sealIdentifier: input.sealIdentifier?.trim() || transfer.sealIdentifier,
    },
  });

  await tx.inventoryTransferCustodyEvent.create({
    data: {
      transferId: transfer.id,
      siteId: transfer.destinationSiteId,
      actorId: input.actorId,
      type: "RECEIVED",
      carrier: input.carrier?.trim() || transfer.carrier,
      trackingNumber: input.trackingNumber?.trim() || transfer.trackingNumber,
      sealIdentifier: input.sealIdentifier?.trim() || transfer.sealIdentifier,
      note: input.receiptNote?.trim() || null,
    },
  });

  return {
    transfer: updated,
    destinationBalance: received.balance,
    transaction: transferTransaction,
  };
}

export async function cancelInventoryTransfer(
  tx: Prisma.TransactionClient,
  input: {
    transferId: string;
    sourceSiteId: string;
    actorId: string;
    reason: string;
  },
) {
  const transfer = await lockTransfer(tx, input.transferId);

  if (transfer.sourceSiteId !== input.sourceSiteId) {
    throw new InventoryError(
      404,
      "INVENTORY_TRANSFER_NOT_FOUND",
      "Inventory transfer not found for this source site.",
    );
  }

  if (transfer.status !== "IN_TRANSIT") {
    throw new InventoryError(
      409,
      "TRANSFER_NOT_IN_TRANSIT",
      "Only an in-transit transfer can be cancelled.",
      { status: transfer.status },
    );
  }

  const source = await lockBalance(tx, transfer.sourceInventoryBalanceId);
  const updatedBalance = await tx.inventoryBalance.update({
    where: { id: source.id },
    data: {
      onHandQuantity: source.onHandQuantity.plus(transfer.quantity),
    },
  });

  await adjustStockPosition(tx, {
    siteId: transfer.sourceSiteId,
    inventoryBalanceId: source.id,
    state: "AVAILABLE",
    delta: transfer.quantity,
  });

  const transaction = await tx.inventoryTransaction.create({
    data: {
      siteId: transfer.sourceSiteId,
      inventoryBalanceId: source.id,
      inventoryTransferId: transfer.id,
      actorId: input.actorId,
      type: "TRANSFER_CANCEL_RETURN",
      onHandDelta: transfer.quantity,
      reservedDelta: 0,
      quarantinedDelta: 0,
      reason: input.reason.trim(),
      source: "SITE_TRANSFER",
      reference: transfer.id,
    },
  });

  await tx.inventoryTransferCustodyEvent.create({
    data: {
      transferId: transfer.id,
      siteId: transfer.sourceSiteId,
      actorId: input.actorId,
      type: "EXCEPTION",
      note: input.reason.trim(),
    },
  });

  const updated = await tx.inventoryTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "CANCELLED",
      cancelledById: input.actorId,
      cancelledAt: new Date(),
      note: transfer.note
        ? `${transfer.note} | Cancelled: ${input.reason.trim()}`
        : `Cancelled: ${input.reason.trim()}`,
    },
  });

  return { transfer: updated, sourceBalance: updatedBalance, transaction };
}

export async function createRecallCase(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    actorId: string;
    productId: string;
    lotNumber?: string | null;
    reference: string;
    reason: string;
  },
) {
  const product = await tx.product.findUnique({
    where: { id: input.productId },
    include: { medication: true, manufacturer: true },
  });
  if (!product) {
    throw new InventoryError(404, "PRODUCT_NOT_FOUND", "Product not found.");
  }

  const lotNumber = input.lotNumber?.trim() || null;
  const lotNumberSearch = lotNumber ? normalizeLot(lotNumber) : null;

  const existing = await tx.recallCase.findFirst({
    where: {
      siteId: input.siteId,
      productId: input.productId,
      lotNumberSearch,
      reference: input.reference.trim(),
      status: "ACTIVE",
    },
  });
  if (existing) {
    throw new InventoryError(
      409,
      "RECALL_ALREADY_ACTIVE",
      "An active recall case already exists for this reference and scope.",
      { recallCaseId: existing.id },
    );
  }

  const recall = await tx.recallCase.create({
    data: {
      siteId: input.siteId,
      productId: input.productId,
      lotNumber,
      lotNumberSearch,
      reference: input.reference.trim(),
      reason: input.reason.trim(),
      createdById: input.actorId,
    },
  });

  // A recall invalidates any in-progress dispense part that contains the
  // recalled physical source. Release the entire fill reservation so staff
  // cannot accidentally continue with a now-incomplete mixture of sources.
  const reservedSources = await tx.fillProductSource.findMany({
    where: {
      productId: input.productId,
      committedAt: null,
      returnedAt: null,
      fill: {
        prescription: { siteId: input.siteId },
      },
      ...(lotNumberSearch
        ? { productLot: { lotNumberSearch } }
        : {}),
    },
    select: {
      fillId: true,
      quantity: true,
      fill: {
        select: {
          prescriptionId: true,
          prescription: {
            select: {
              status: true,
              heldFromStatus: true,
            },
          },
        },
      },
    },
  });

  const reservedAffected = reservedSources.reduce(
    (sum, source) => sum.plus(source.quantity),
    new Prisma.Decimal(0),
  );
  const affectedReservedFillIds = [
    ...new Set(reservedSources.map((source) => source.fillId)),
  ];

  for (const fillId of affectedReservedFillIds) {
    const source = reservedSources.find((item) => item.fillId === fillId)!;
    await releaseInventoryReservation(tx, {
      fillId,
      siteId: input.siteId,
      actorId: input.actorId,
      reason: `Recall ${input.reference.trim()} invalidated a reserved product source`,
    });

    if (source.fill.prescription.status === "PHARMACIST_REVIEW") {
      await tx.prescription.update({
        where: { id: source.fill.prescriptionId },
        data: { status: "PRODUCT_FILL" },
      });
    } else if (
      source.fill.prescription.status === "ON_HOLD" &&
      source.fill.prescription.heldFromStatus === "PHARMACIST_REVIEW"
    ) {
      await tx.prescription.update({
        where: { id: source.fill.prescriptionId },
        data: { heldFromStatus: "PRODUCT_FILL" },
      });
    }
  }

  // Re-read balances after releasing affected reservations. This ensures the
  // just-released recalled quantity is immediately quarantined too.
  const balances = await tx.inventoryBalance.findMany({
    where: {
      siteId: input.siteId,
      productId: input.productId,
      ...(lotNumberSearch
        ? { productLot: { lotNumberSearch } }
        : {}),
    },
    include: {
      productLot: true,
      productExpiration: true,
    },
  });

  const holds = [];
  for (const balance of balances) {
    const available = balance.onHandQuantity
      .minus(balance.reservedQuantity)
      .minus(balance.quarantinedQuantity);

    if (available.gt(0)) {
      const held = await quarantineInventory(tx, {
        balanceId: balance.id,
        siteId: input.siteId,
        actorId: input.actorId,
        quantity: available,
        reasonCode: "RECALL",
        note: `Recall ${input.reference.trim()}: ${input.reason.trim()}`,
        recallCaseId: recall.id,
      });
      holds.push(held.hold);
    }
  }

  // Sold split-source fills must be matched through immutable source history,
  // not only the legacy first-source compatibility fields on PrescriptionFill.
  const soldSourceRows = await tx.fillProductSource.findMany({
    where: {
      productId: input.productId,
      returnedAt: null,
      fill: {
        status: "SOLD",
        prescription: { siteId: input.siteId },
      },
      ...(lotNumberSearch
        ? { productLot: { lotNumberSearch } }
        : {}),
    },
    select: { fillId: true },
  });

  // Keep the legacy match as a compatibility fallback for any historical row
  // that predates FillProductSource backfill.
  const legacyAffectedFills = await tx.prescriptionFill.findMany({
    where: {
      prescription: { siteId: input.siteId },
      productId: input.productId,
      status: "SOLD",
      ...(lotNumberSearch
        ? { productLot: { lotNumberSearch } }
        : {}),
    },
    select: { id: true },
  });

  const affectedSoldFillIds = [
    ...new Set([
      ...soldSourceRows.map((source) => source.fillId),
      ...legacyAffectedFills.map((fill) => fill.id),
    ]),
  ];

  if (affectedSoldFillIds.length > 0) {
    await tx.recallAffectedFill.createMany({
      data: affectedSoldFillIds.map((fillId) => ({
        recallCaseId: recall.id,
        fillId,
      })),
      skipDuplicates: true,
    });
  }

  return {
    recall,
    product,
    holds,
    matchedBalanceCount: balances.length,
    quarantinedHoldCount: holds.length,
    reservedAffectedQuantity: reservedAffected,
    invalidatedReservedFillCount: affectedReservedFillIds.length,
    affectedSoldFillCount: affectedSoldFillIds.length,
  };
}

export async function closeRecallCase(
  tx: Prisma.TransactionClient,
  input: {
    recallCaseId: string;
    siteId: string;
    actorId: string;
    closureNote: string;
  },
) {
  const recall = await tx.recallCase.findFirst({
    where: { id: input.recallCaseId, siteId: input.siteId },
  });

  if (!recall) {
    throw new InventoryError(
      404,
      "RECALL_NOT_FOUND",
      "Recall case not found.",
    );
  }
  if (recall.status !== "ACTIVE") {
    throw new InventoryError(
      409,
      "RECALL_ALREADY_CLOSED",
      "Only an active recall case can be closed.",
    );
  }

  return tx.recallCase.update({
    where: { id: recall.id },
    data: {
      status: "CLOSED",
      closedById: input.actorId,
      closedAt: new Date(),
      closureNote: input.closureNote.trim(),
    },
  });
}

export async function createPurchaseOrder(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    actorId: string;
    orderNumber: string;
    supplierName: string;
    note?: string | null;
    lines: Array<{
      productId: string;
      quantityOrdered: Prisma.Decimal | number | string;
      unitCost?: Prisma.Decimal | number | string | null;
    }>;
  },
) {
  if (input.lines.length === 0) {
    throw new InventoryError(
      400,
      "PURCHASE_ORDER_LINES_REQUIRED",
      "At least one purchase-order line is required.",
    );
  }

  const uniqueProductIds = new Set(input.lines.map((line) => line.productId));
  if (uniqueProductIds.size !== input.lines.length) {
    throw new InventoryError(
      400,
      "DUPLICATE_PURCHASE_ORDER_PRODUCT",
      "Each product/NDC may appear only once on a purchase order.",
    );
  }

  const products = await tx.product.findMany({
    where: {
      id: { in: [...uniqueProductIds] },
      active: true,
    },
    select: { id: true },
  });
  if (products.length !== uniqueProductIds.size) {
    throw new InventoryError(
      404,
      "PURCHASE_ORDER_PRODUCT_NOT_FOUND",
      "One or more active purchase-order products were not found.",
    );
  }

  return tx.purchaseOrder.create({
    data: {
      siteId: input.siteId,
      orderNumber: input.orderNumber.trim(),
      supplierName: input.supplierName.trim(),
      note: input.note?.trim() || null,
      createdById: input.actorId,
      lines: {
        create: input.lines.map((line) => {
          const quantityOrdered = positive(
            line.quantityOrdered,
            "ordered quantity",
          );
          const unitCost =
            line.unitCost === null || line.unitCost === undefined
              ? null
              : decimal(line.unitCost);
          if (unitCost && unitCost.lt(0)) {
            throw new InventoryError(
              400,
              "INVALID_UNIT_COST",
              "Unit cost cannot be negative.",
            );
          }
          return {
            productId: line.productId,
            quantityOrdered,
            unitCost,
          };
        }),
      },
    },
    include: {
      createdBy: {
        select: { id: true, displayName: true, role: true },
      },
      lines: {
        include: {
          product: {
            include: { medication: true, manufacturer: true },
          },
          receipts: true,
        },
      },
    },
  });
}

export async function receivePurchaseOrderLine(
  tx: Prisma.TransactionClient,
  input: {
    purchaseOrderId: string;
    lineId: string;
    siteId: string;
    actorId: string;
    quantity: Prisma.Decimal | number | string;
    lotNumber: string;
    expirationDate: Date;
    invoiceReference?: string | null;
    locationId?: string | null;
    idempotencyKey?: string | null;
  },
) {
  if (input.idempotencyKey) {
    const existingReceipt = await tx.purchaseOrderReceipt.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: {
        inventoryBalance: true,
        purchaseOrderLine: { include: { purchaseOrder: true } },
        inventoryTransaction: true,
      },
    });
    if (existingReceipt) {
      return {
        purchaseOrder: existingReceipt.purchaseOrderLine.purchaseOrder,
        receipt: existingReceipt,
        balance: existingReceipt.inventoryBalance,
        transaction: existingReceipt.inventoryTransaction,
        traceability: null,
        replayed: true,
      };
    }
  }

  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "PurchaseOrderLine" WHERE "id" = ${input.lineId} FOR UPDATE`,
  );

  const line = await tx.purchaseOrderLine.findFirst({
    where: {
      id: input.lineId,
      purchaseOrderId: input.purchaseOrderId,
      purchaseOrder: { siteId: input.siteId },
    },
    include: {
      purchaseOrder: true,
      product: true,
    },
  });

  if (!line) {
    throw new InventoryError(
      404,
      "PURCHASE_ORDER_LINE_NOT_FOUND",
      "Purchase-order line not found.",
    );
  }

  if (line.purchaseOrder.status === "CANCELLED") {
    throw new InventoryError(
      409,
      "PURCHASE_ORDER_CANCELLED",
      "A cancelled purchase order cannot receive stock.",
    );
  }

  const quantity = positive(input.quantity);
  const remaining = line.quantityOrdered.minus(line.quantityReceived);
  if (quantity.gt(remaining)) {
    throw new InventoryError(
      409,
      "PURCHASE_ORDER_OVER_RECEIPT",
      "Received quantity cannot exceed the outstanding ordered quantity.",
      {
        quantityOrdered: line.quantityOrdered.toString(),
        quantityReceived: line.quantityReceived.toString(),
        remainingQuantity: remaining.toString(),
        attemptedReceipt: quantity.toString(),
      },
    );
  }

  if (!input.lotNumber.trim() || Number.isNaN(input.expirationDate.getTime())) {
    throw new InventoryError(
      400,
      "TRACEABILITY_REQUIRED",
      "A valid lot number and expiration date are required for purchase-order receiving.",
    );
  }

  const traceability = await upsertTraceability(tx, {
    siteId: input.siteId,
    productId: line.productId,
    lotNumber: input.lotNumber.trim(),
    expirationDate: input.expirationDate,
  });

  const received = await receiveInventory(tx, {
    siteId: input.siteId,
    actorId: input.actorId,
    productId: line.productId,
    productLotId: traceability.lot.id,
    productExpirationId: traceability.expiration.id,
    quantity,
    source: "PURCHASE_ORDER",
    reference: line.purchaseOrder.orderNumber,
    reason: `PO ${line.purchaseOrder.orderNumber} receipt from ${line.purchaseOrder.supplierName}`,
    locationId: input.locationId,
    idempotencyKey: input.idempotencyKey?.trim() || null,
    unitCost: line.unitCost,
  });

  const receipt = await tx.purchaseOrderReceipt.create({
    data: {
      purchaseOrderLineId: line.id,
      actorId: input.actorId,
      inventoryBalanceId: received.balance.id,
      inventoryTransactionId: received.transaction.id,
      quantity,
      lotNumber: input.lotNumber.trim(),
      expirationDate: input.expirationDate,
      invoiceReference: input.invoiceReference?.trim() || null,
      unitCost: line.unitCost,
      extendedCost: line.unitCost ? line.unitCost.mul(quantity) : null,
      idempotencyKey: input.idempotencyKey?.trim() || null,
    },
  });

  await tx.purchaseOrderLine.update({
    where: { id: line.id },
    data: {
      quantityReceived: line.quantityReceived.plus(quantity),
    },
  });

  const lines = await tx.purchaseOrderLine.findMany({
    where: { purchaseOrderId: input.purchaseOrderId },
    select: { quantityOrdered: true, quantityReceived: true },
  });

  const allReceived = lines.every((item) =>
    item.quantityReceived.gte(item.quantityOrdered),
  );
  const anyReceived = lines.some((item) => item.quantityReceived.gt(0));

  const purchaseOrder = await tx.purchaseOrder.update({
    where: { id: input.purchaseOrderId },
    data: {
      status: allReceived
        ? "RECEIVED"
        : anyReceived
          ? "PARTIALLY_RECEIVED"
          : "OPEN",
    },
  });

  return {
    purchaseOrder,
    receipt,
    balance: received.balance,
    transaction: received.transaction,
    traceability,
    replayed: false,
  };
}

export async function cancelPurchaseOrder(
  tx: Prisma.TransactionClient,
  input: {
    purchaseOrderId: string;
    siteId: string;
    actorId: string;
  },
) {
  const order = await tx.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, siteId: input.siteId },
  });
  if (!order) {
    throw new InventoryError(
      404,
      "PURCHASE_ORDER_NOT_FOUND",
      "Purchase order not found.",
    );
  }
  if (order.status === "CANCELLED") {
    return order;
  }
  if (order.status === "RECEIVED") {
    throw new InventoryError(
      409,
      "PURCHASE_ORDER_ALREADY_RECEIVED",
      "A fully received purchase order cannot be cancelled.",
    );
  }

  return tx.purchaseOrder.update({
    where: { id: order.id },
    data: {
      status: "CANCELLED",
      cancelledById: input.actorId,
      cancelledAt: new Date(),
    },
  });
}
