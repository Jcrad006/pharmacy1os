import {
  Prisma,
  type InventoryDispositionType,
  type InventoryHoldReason,
} from "@prisma/client";

import { InventoryError } from "./inventoryError.js";
export { InventoryError } from "./inventoryError.js";

function decimal(value: Prisma.Decimal | number | string) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function positiveQuantity(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) {
    throw new InventoryError(
      409,
      "FILL_QUANTITY_REQUIRED",
      "A positive fill quantity is required for inventory reservation.",
    );
  }

  const quantity = decimal(value);
  if (quantity.lte(0)) {
    throw new InventoryError(
      409,
      "FILL_QUANTITY_REQUIRED",
      "A positive fill quantity is required for inventory reservation.",
    );
  }
  return quantity;
}

async function lockBalance(tx: Prisma.TransactionClient, balanceId: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "InventoryBalance" WHERE "id" = ${balanceId} FOR UPDATE`,
  );

  const balance = await tx.inventoryBalance.findUnique({
    where: { id: balanceId },
  });

  if (!balance) {
    throw new InventoryError(
      409,
      "INVENTORY_BALANCE_MISSING",
      "The inventory balance no longer exists.",
    );
  }

  return balance;
}

async function ensureBalanceNotRecalled(
  tx: Prisma.TransactionClient,
  input: { siteId: string; balanceId: string },
) {
  const balance = await tx.inventoryBalance.findFirst({
    where: { id: input.balanceId, siteId: input.siteId },
    include: { productLot: true },
  });

  if (!balance) {
    throw new InventoryError(
      404,
      "INVENTORY_NOT_FOUND",
      "Inventory balance not found.",
    );
  }

  const recall = await tx.recallCase.findFirst({
    where: {
      siteId: input.siteId,
      productId: balance.productId,
      status: "ACTIVE",
      OR: [
        { lotNumberSearch: null },
        { lotNumberSearch: balance.productLot.lotNumberSearch },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  if (recall) {
    throw new InventoryError(
      409,
      "INVENTORY_RECALLED",
      "This NDC/lot is under an active recall and cannot be dispensed.",
      {
        recallCaseId: recall.id,
        reference: recall.reference,
        lotNumber: balance.productLot.lotNumber,
      },
    );
  }
}

export async function receiveInventory(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    actorId: string;
    productId: string;
    productLotId: string;
    productExpirationId: string;
    quantity: number | string | Prisma.Decimal;
    source?: string | null;
    reference?: string | null;
    reason?: string | null;
  },
) {
  const quantity = positiveQuantity(input.quantity);

  const balance = await tx.inventoryBalance.upsert({
    where: {
      siteId_productId_productLotId_productExpirationId: {
        siteId: input.siteId,
        productId: input.productId,
        productLotId: input.productLotId,
        productExpirationId: input.productExpirationId,
      },
    },
    update: {},
    create: {
      siteId: input.siteId,
      productId: input.productId,
      productLotId: input.productLotId,
      productExpirationId: input.productExpirationId,
    },
  });

  const locked = await lockBalance(tx, balance.id);
  const updated = await tx.inventoryBalance.update({
    where: { id: locked.id },
    data: {
      onHandQuantity: locked.onHandQuantity.plus(quantity),
    },
  });

  const transaction = await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: locked.id,
      actorId: input.actorId,
      type: "RECEIVE",
      onHandDelta: quantity,
      reservedDelta: 0,
      reason: input.reason?.trim() || "Inventory received",
      source: input.source?.trim() || null,
      reference: input.reference?.trim() || null,
    },
  });

  const lot = await tx.productLot.findUnique({
    where: { id: input.productLotId },
    select: { lotNumber: true, lotNumberSearch: true },
  });

  const recall = lot
    ? await tx.recallCase.findFirst({
        where: {
          siteId: input.siteId,
          productId: input.productId,
          status: "ACTIVE",
          OR: [
            { lotNumberSearch: null },
            { lotNumberSearch: lot.lotNumberSearch },
          ],
        },
        orderBy: { createdAt: "desc" },
      })
    : null;

  if (recall) {
    const held = await quarantineInventory(tx, {
      balanceId: locked.id,
      siteId: input.siteId,
      actorId: input.actorId,
      quantity,
      reasonCode: "RECALL",
      note: `Automatically quarantined on receipt for recall ${recall.reference}`,
      recallCaseId: recall.id,
    });

    return {
      balance: held.balance,
      transaction,
      quarantineHold: held.hold,
    };
  }

  return { balance: updated, transaction, quarantineHold: null };
}

export async function releaseInventoryReservation(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    siteId: string;
    actorId: string;
    reason: string;
  },
) {
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: input.fillId },
    select: {
      id: true,
      quantity: true,
      inventoryBalanceId: true,
      inventoryReservedAt: true,
      inventoryCommittedAt: true,
    },
  });

  if (
    !fill?.inventoryBalanceId ||
    !fill.inventoryReservedAt ||
    fill.inventoryCommittedAt
  ) {
    return null;
  }

  const quantity = positiveQuantity(fill.quantity);
  const balance = await lockBalance(tx, fill.inventoryBalanceId);

  if (balance.reservedQuantity.lt(quantity)) {
    throw new InventoryError(
      409,
      "INVENTORY_RESERVATION_INCONSISTENT",
      "The inventory reservation is smaller than the fill quantity.",
      {
        balanceId: balance.id,
        reservedQuantity: balance.reservedQuantity.toString(),
        fillQuantity: quantity.toString(),
      },
    );
  }

  const updated = await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      reservedQuantity: balance.reservedQuantity.minus(quantity),
    },
  });

  await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      fillId: fill.id,
      actorId: input.actorId,
      type: "RELEASE",
      onHandDelta: 0,
      reservedDelta: quantity.negated(),
      reason: input.reason,
    },
  });

  await tx.prescriptionFill.update({
    where: { id: fill.id },
    data: {
      inventoryReservedAt: null,
    },
  });

  return updated;
}

export async function reserveInventoryForFill(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    siteId: string;
    actorId: string;
    productId: string;
    productLotId: string;
    productExpirationId: string;
  },
) {
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: input.fillId },
    select: {
      id: true,
      quantity: true,
      inventoryBalanceId: true,
      inventoryReservedAt: true,
      inventoryCommittedAt: true,
    },
  });

  if (!fill) {
    throw new InventoryError(404, "FILL_NOT_FOUND", "Fill not found.");
  }

  if (fill.inventoryCommittedAt) {
    throw new InventoryError(
      409,
      "INVENTORY_ALREADY_COMMITTED",
      "Inventory has already been committed for this fill.",
    );
  }

  const quantity = positiveQuantity(fill.quantity);

  const balance = await tx.inventoryBalance.findUnique({
    where: {
      siteId_productId_productLotId_productExpirationId: {
        siteId: input.siteId,
        productId: input.productId,
        productLotId: input.productLotId,
        productExpirationId: input.productExpirationId,
      },
    },
  });

  if (!balance) {
    throw new InventoryError(
      409,
      "INVENTORY_NOT_RECEIVED",
      "No on-hand inventory has been received for this NDC, lot, and expiration.",
    );
  }

  const locked = await lockBalance(tx, balance.id);
  await ensureBalanceNotRecalled(tx, {
    siteId: input.siteId,
    balanceId: locked.id,
  });

  if (
    fill.inventoryBalanceId &&
    fill.inventoryReservedAt &&
    fill.inventoryBalanceId !== locked.id
  ) {
    await releaseInventoryReservation(tx, {
      fillId: fill.id,
      siteId: input.siteId,
      actorId: input.actorId,
      reason: "Product rescanned during Product Fill",
    });
  } else if (
    fill.inventoryBalanceId === locked.id &&
    fill.inventoryReservedAt
  ) {
    return {
      balance: locked,
      quantity,
      reservedAt: fill.inventoryReservedAt,
    };
  }
  const available = locked.onHandQuantity
    .minus(locked.reservedQuantity)
    .minus(locked.quarantinedQuantity);

  if (available.lt(quantity)) {
    throw new InventoryError(
      409,
      "INSUFFICIENT_INVENTORY",
      "There is not enough available inventory for this fill.",
      {
        balanceId: locked.id,
        availableQuantity: available.toString(),
        requestedQuantity: quantity.toString(),
      },
    );
  }

  const updated = await tx.inventoryBalance.update({
    where: { id: locked.id },
    data: {
      reservedQuantity: locked.reservedQuantity.plus(quantity),
    },
  });

  const reservedAt = new Date();
  await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: locked.id,
      fillId: fill.id,
      actorId: input.actorId,
      type: "RESERVE",
      onHandDelta: 0,
      reservedDelta: quantity,
      reason: "Product selected for prescription fill",
    },
  });

  await tx.prescriptionFill.update({
    where: { id: fill.id },
    data: {
      inventoryBalanceId: locked.id,
      inventoryReservedAt: reservedAt,
      inventoryCommittedAt: null,
      inventoryReturnedAt: null,
    },
  });

  return {
    balance: updated,
    quantity,
    reservedAt,
  };
}

export async function commitInventoryForFill(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    siteId: string;
    actorId: string;
  },
) {
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: input.fillId },
    select: {
      id: true,
      quantity: true,
      inventoryBalanceId: true,
      inventoryReservedAt: true,
      inventoryCommittedAt: true,
    },
  });

  if (!fill) {
    throw new InventoryError(404, "FILL_NOT_FOUND", "Fill not found.");
  }

  if (fill.inventoryCommittedAt) {
    return { committedAt: fill.inventoryCommittedAt };
  }

  if (!fill.inventoryBalanceId || !fill.inventoryReservedAt) {
    throw new InventoryError(
      409,
      "INVENTORY_RESERVATION_REQUIRED",
      "A valid inventory reservation is required before pharmacist verification.",
    );
  }

  const quantity = positiveQuantity(fill.quantity);
  const balance = await lockBalance(tx, fill.inventoryBalanceId);
  await ensureBalanceNotRecalled(tx, {
    siteId: input.siteId,
    balanceId: balance.id,
  });

  if (
    balance.reservedQuantity.lt(quantity) ||
    balance.onHandQuantity.lt(quantity)
  ) {
    throw new InventoryError(
      409,
      "INVENTORY_RESERVATION_INCONSISTENT",
      "The inventory balance cannot satisfy the reserved fill quantity.",
      {
        balanceId: balance.id,
        onHandQuantity: balance.onHandQuantity.toString(),
        reservedQuantity: balance.reservedQuantity.toString(),
        fillQuantity: quantity.toString(),
      },
    );
  }

  await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      onHandQuantity: balance.onHandQuantity.minus(quantity),
      reservedQuantity: balance.reservedQuantity.minus(quantity),
    },
  });

  const committedAt = new Date();
  await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      fillId: fill.id,
      actorId: input.actorId,
      type: "DISPENSE",
      onHandDelta: quantity.negated(),
      reservedDelta: quantity.negated(),
      reason: "Pharmacist verification committed dispensed inventory",
    },
  });

  await tx.prescriptionFill.update({
    where: { id: fill.id },
    data: {
      inventoryCommittedAt: committedAt,
      inventoryReturnedAt: null,
    },
  });

  return { committedAt };
}

export async function returnInventoryForFill(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    siteId: string;
    actorId: string;
    reason: string;
  },
) {
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: input.fillId },
    select: {
      id: true,
      quantity: true,
      inventoryBalanceId: true,
      inventoryCommittedAt: true,
      inventoryReturnedAt: true,
    },
  });

  if (
    !fill?.inventoryBalanceId ||
    !fill.inventoryCommittedAt ||
    fill.inventoryReturnedAt
  ) {
    return null;
  }

  const quantity = positiveQuantity(fill.quantity);
  const balance = await lockBalance(tx, fill.inventoryBalanceId);

  const updated = await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      onHandQuantity: balance.onHandQuantity.plus(quantity),
    },
  });

  const returnedAt = new Date();
  await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      fillId: fill.id,
      actorId: input.actorId,
      type: "RETURN_TO_STOCK",
      onHandDelta: quantity,
      reservedDelta: 0,
      reason: input.reason,
    },
  });

  await tx.prescriptionFill.update({
    where: { id: fill.id },
    data: {
      inventoryReturnedAt: returnedAt,
    },
  });

  return { balance: updated, returnedAt };
}

export async function adjustInventoryBalance(
  tx: Prisma.TransactionClient,
  input: {
    balanceId: string;
    siteId: string;
    actorId: string;
    delta: number | string | Prisma.Decimal;
    reason: string;
    source?: string | null;
    reference?: string | null;
  },
) {
  const delta = decimal(input.delta);
  if (delta.eq(0)) {
    throw new InventoryError(
      400,
      "INVENTORY_ADJUSTMENT_ZERO",
      "Inventory adjustment must be non-zero.",
    );
  }

  const balance = await lockBalance(tx, input.balanceId);
  if (balance.siteId !== input.siteId) {
    throw new InventoryError(404, "INVENTORY_NOT_FOUND", "Inventory balance not found.");
  }

  const newOnHand = balance.onHandQuantity.plus(delta);
  const allocated = balance.reservedQuantity.plus(balance.quarantinedQuantity);
  if (newOnHand.lt(0) || newOnHand.lt(allocated)) {
    throw new InventoryError(
      409,
      "INVENTORY_ADJUSTMENT_CONFLICT",
      "The adjustment would make on-hand inventory negative or lower than reserved plus quarantined inventory.",
      {
        onHandQuantity: balance.onHandQuantity.toString(),
        reservedQuantity: balance.reservedQuantity.toString(),
        quarantinedQuantity: balance.quarantinedQuantity.toString(),
        adjustment: delta.toString(),
      },
    );
  }

  const updated = await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: { onHandQuantity: newOnHand },
  });

  const transaction = await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      actorId: input.actorId,
      type: "ADJUSTMENT",
      onHandDelta: delta,
      reservedDelta: 0,
      reason: input.reason.trim(),
      source: input.source?.trim() || null,
      reference: input.reference?.trim() || null,
    },
  });

  return { balance: updated, transaction };
}


export async function quarantineInventory(
  tx: Prisma.TransactionClient,
  input: {
    balanceId: string;
    siteId: string;
    actorId: string;
    quantity: number | string | Prisma.Decimal;
    reasonCode: InventoryHoldReason;
    note?: string | null;
    recallCaseId?: string | null;
  },
) {
  const quantity = positiveQuantity(input.quantity);
  const balance = await lockBalance(tx, input.balanceId);

  if (balance.siteId !== input.siteId) {
    throw new InventoryError(
      404,
      "INVENTORY_NOT_FOUND",
      "Inventory balance not found.",
    );
  }

  const available = balance.onHandQuantity
    .minus(balance.reservedQuantity)
    .minus(balance.quarantinedQuantity);

  if (available.lt(quantity)) {
    throw new InventoryError(
      409,
      "INSUFFICIENT_AVAILABLE_INVENTORY",
      "Only currently available inventory can be quarantined.",
      {
        balanceId: balance.id,
        availableQuantity: available.toString(),
        requestedQuantity: quantity.toString(),
        reservedQuantity: balance.reservedQuantity.toString(),
        quarantinedQuantity: balance.quarantinedQuantity.toString(),
      },
    );
  }

  const hold = await tx.inventoryHold.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      quantity,
      reasonCode: input.reasonCode,
      note: input.note?.trim() || null,
      recallCaseId: input.recallCaseId ?? null,
      createdById: input.actorId,
    },
  });

  const updated = await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      quarantinedQuantity: balance.quarantinedQuantity.plus(quantity),
    },
  });

  const transaction = await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      inventoryHoldId: hold.id,
      actorId: input.actorId,
      type: "QUARANTINE",
      onHandDelta: 0,
      reservedDelta: 0,
      quarantinedDelta: quantity,
      reason: input.note?.trim() || input.reasonCode.replaceAll("_", " "),
      source: "INVENTORY_HOLD",
      reference: hold.id,
    },
  });

  return { balance: updated, hold, transaction };
}

export async function releaseInventoryHold(
  tx: Prisma.TransactionClient,
  input: {
    holdId: string;
    siteId: string;
    actorId: string;
    resolutionNote: string;
  },
) {
  const hold = await tx.inventoryHold.findFirst({
    where: {
      id: input.holdId,
      siteId: input.siteId,
    },
  });

  if (!hold) {
    throw new InventoryError(
      404,
      "INVENTORY_HOLD_NOT_FOUND",
      "Inventory hold not found.",
    );
  }

  if (hold.status !== "ACTIVE") {
    throw new InventoryError(
      409,
      "INVENTORY_HOLD_CLOSED",
      "Only an active inventory hold can be released.",
      { status: hold.status },
    );
  }

  const balance = await lockBalance(tx, hold.inventoryBalanceId);

  if (balance.quarantinedQuantity.lt(hold.quantity)) {
    throw new InventoryError(
      409,
      "QUARANTINE_BALANCE_INCONSISTENT",
      "The quarantined balance is smaller than this active hold.",
      {
        quarantinedQuantity: balance.quarantinedQuantity.toString(),
        holdQuantity: hold.quantity.toString(),
      },
    );
  }

  const updated = await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      quarantinedQuantity: balance.quarantinedQuantity.minus(hold.quantity),
    },
  });

  const transaction = await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      inventoryHoldId: hold.id,
      actorId: input.actorId,
      type: "RELEASE_QUARANTINE",
      onHandDelta: 0,
      reservedDelta: 0,
      quarantinedDelta: hold.quantity.negated(),
      reason: input.resolutionNote.trim(),
      source: "INVENTORY_HOLD",
      reference: hold.id,
    },
  });

  const resolved = await tx.inventoryHold.update({
    where: { id: hold.id },
    data: {
      status: "RELEASED",
      resolvedById: input.actorId,
      resolvedAt: new Date(),
      resolutionNote: input.resolutionNote.trim(),
      dispositionType: null,
    },
  });

  return { balance: updated, hold: resolved, transaction };
}

export async function disposeInventoryHold(
  tx: Prisma.TransactionClient,
  input: {
    holdId: string;
    siteId: string;
    actorId: string;
    dispositionType: InventoryDispositionType;
    resolutionNote: string;
  },
) {
  const hold = await tx.inventoryHold.findFirst({
    where: {
      id: input.holdId,
      siteId: input.siteId,
    },
  });

  if (!hold) {
    throw new InventoryError(
      404,
      "INVENTORY_HOLD_NOT_FOUND",
      "Inventory hold not found.",
    );
  }

  if (hold.status !== "ACTIVE") {
    throw new InventoryError(
      409,
      "INVENTORY_HOLD_CLOSED",
      "Only an active inventory hold can be disposed.",
      { status: hold.status },
    );
  }

  const balance = await lockBalance(tx, hold.inventoryBalanceId);

  if (
    balance.quarantinedQuantity.lt(hold.quantity) ||
    balance.onHandQuantity.lt(hold.quantity)
  ) {
    throw new InventoryError(
      409,
      "QUARANTINE_BALANCE_INCONSISTENT",
      "The physical/quarantined balance cannot satisfy this disposition.",
      {
        onHandQuantity: balance.onHandQuantity.toString(),
        quarantinedQuantity: balance.quarantinedQuantity.toString(),
        holdQuantity: hold.quantity.toString(),
      },
    );
  }

  const updated = await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      onHandQuantity: balance.onHandQuantity.minus(hold.quantity),
      quarantinedQuantity: balance.quarantinedQuantity.minus(hold.quantity),
    },
  });

  const transaction = await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      inventoryHoldId: hold.id,
      actorId: input.actorId,
      type: "DISPOSE",
      onHandDelta: hold.quantity.negated(),
      reservedDelta: 0,
      quarantinedDelta: hold.quantity.negated(),
      reason: input.resolutionNote.trim(),
      source: input.dispositionType,
      reference: hold.id,
    },
  });

  const resolved = await tx.inventoryHold.update({
    where: { id: hold.id },
    data: {
      status: "DISPOSED",
      resolvedById: input.actorId,
      resolvedAt: new Date(),
      resolutionNote: input.resolutionNote.trim(),
      dispositionType: input.dispositionType,
    },
  });

  return { balance: updated, hold: resolved, transaction };
}
