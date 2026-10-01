import { Prisma } from "@prisma/client";

export class InventoryError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

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

  return { balance: updated, transaction };
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

  if (fill.inventoryBalanceId && fill.inventoryReservedAt) {
    await releaseInventoryReservation(tx, {
      fillId: fill.id,
      siteId: input.siteId,
      actorId: input.actorId,
      reason: "Product rescanned during Product Fill",
    });
  }

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
  const available = locked.onHandQuantity.minus(locked.reservedQuantity);

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
  if (newOnHand.lt(0) || newOnHand.lt(balance.reservedQuantity)) {
    throw new InventoryError(
      409,
      "INVENTORY_ADJUSTMENT_CONFLICT",
      "The adjustment would make on-hand inventory negative or lower than reserved inventory.",
      {
        onHandQuantity: balance.onHandQuantity.toString(),
        reservedQuantity: balance.reservedQuantity.toString(),
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
    },
  });

  return { balance: updated, transaction };
}
