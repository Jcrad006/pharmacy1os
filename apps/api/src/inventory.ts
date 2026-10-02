import {
  Prisma,
  type InventoryDispositionType,
  type InventoryHoldReason,
} from "@prisma/client";

import { InventoryError } from "./inventoryError.js";
export { InventoryError } from "./inventoryError.js";
import {
  adjustStockPosition,
  fulfillDemandForFill,
  reconcileDemandAvailability,
  moveStockState,
} from "./inventoryArchitecture.js";
import {
  calculateNcPatientDiscardDate,
  ensureBiologicCommunicationTask,
} from "./productFillCompliance.js";
import { requestFingerprint } from "./idempotency.js";

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

export async function assertFillPhysicalSourcesDispensable(
  tx: Prisma.TransactionClient,
  input: { fillId: string; siteId: string; at?: Date },
) {
  const fill = await tx.prescriptionFill.findFirst({
    where: { id: input.fillId, prescription: { siteId: input.siteId } },
    include: {
      productSources: {
        include: {
          productLot: true,
          productExpiration: true,
        },
      },
    },
  });
  if (!fill) {
    throw new InventoryError(404, "FILL_NOT_FOUND", "Fill not found.");
  }

  const at = input.at ?? new Date();
  for (const source of fill.productSources) {
    const recall = await tx.recallCase.findFirst({
      where: {
        siteId: input.siteId,
        productId: source.productId,
        status: "ACTIVE",
        OR: [
          { lotNumberSearch: null },
          { lotNumberSearch: source.productLot.lotNumberSearch },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    if (recall) {
      throw new InventoryError(
        409,
        "READY_FILL_RECALLED",
        "This fill contains a recalled NDC/lot and cannot be sold or handed to the patient.",
        {
          fillId: fill.id,
          sourceId: source.id,
          recallCaseId: recall.id,
          reference: recall.reference,
          ndc: source.ndcSnapshot,
          lotNumber: source.lotNumberSnapshot,
        },
      );
    }

    const expirationEnd = new Date(source.expirationSnapshot);
    expirationEnd.setUTCHours(23, 59, 59, 999);
    if (expirationEnd.getTime() < at.getTime()) {
      throw new InventoryError(
        409,
        "READY_FILL_EXPIRED",
        "This fill contains product that has expired since verification and cannot be sold or handed to the patient.",
        {
          fillId: fill.id,
          sourceId: source.id,
          ndc: source.ndcSnapshot,
          lotNumber: source.lotNumberSnapshot,
          expirationDate: source.expirationSnapshot.toISOString(),
        },
      );
    }
  }
  return fill;
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
    locationId?: string | null;
    idempotencyKey?: string | null;
    unitCost?: number | string | Prisma.Decimal | null;
  },
) {
  const quantity = positiveQuantity(input.quantity);
  const idempotencyFingerprint = input.idempotencyKey
    ? requestFingerprint("inventory-receive", {
        siteId: input.siteId,
        productId: input.productId,
        productLotId: input.productLotId,
        productExpirationId: input.productExpirationId,
        quantity: quantity.toString(),
        source: input.source?.trim() || null,
        reference: input.reference?.trim() || null,
        reason: input.reason?.trim() || null,
        locationId: input.locationId ?? null,
        unitCost:
          input.unitCost === null || input.unitCost === undefined
            ? null
            : decimal(input.unitCost).toString(),
      })
    : null;

  if (input.idempotencyKey) {
    const existing = await tx.inventoryTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { inventoryBalance: true },
    });
    if (existing) {
      if (
        existing.type !== "RECEIVE" ||
        existing.siteId !== input.siteId ||
        !existing.idempotencyFingerprint ||
        existing.idempotencyFingerprint !== idempotencyFingerprint
      ) {
        throw new InventoryError(
          409,
          "IDEMPOTENCY_KEY_CONFLICT",
          "This idempotency key was already used for a different inventory request.",
          {
            transactionId: existing.id,
            type: existing.type,
            existingSiteId: existing.siteId,
          },
        );
      }
      return {
        balance: existing.inventoryBalance,
        transaction: existing,
        quarantineHold: null,
        replayed: true,
      };
    }
  }

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

  await adjustStockPosition(tx, {
    siteId: input.siteId,
    inventoryBalanceId: locked.id,
    state: "AVAILABLE",
    delta: quantity,
    locationId: input.locationId,
  });

  const unitCost =
    input.unitCost === null || input.unitCost === undefined
      ? null
      : decimal(input.unitCost);
  if (unitCost && unitCost.lt(0)) {
    throw new InventoryError(
      400,
      "INVALID_ACQUISITION_COST",
      "Acquisition unit cost cannot be negative.",
    );
  }

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
      idempotencyKey: input.idempotencyKey?.trim() || null,
      idempotencyFingerprint,
      unitCost,
      extendedCost: unitCost ? unitCost.mul(quantity) : null,
    },
  });

  const product = await tx.product.findUnique({
    where: { id: input.productId },
    select: { medicationId: true },
  });
  if (product) {
    await reconcileDemandAvailability(tx, input.siteId, product.medicationId);
  }

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

export async function getFillSourceReservationSummary(
  tx: Prisma.TransactionClient,
  fillId: string,
) {
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: fillId },
    select: { id: true, quantity: true, inventoryReservedAt: true },
  });
  if (!fill) {
    throw new InventoryError(404, "FILL_NOT_FOUND", "Fill not found.");
  }

  const required = positiveQuantity(fill.quantity);
  const sources = await tx.fillProductSource.findMany({
    where: { fillId },
    include: {
      product: { include: { manufacturer: true, medication: true } },
      manufacturer: true,
      productLot: true,
      productExpiration: true,
      inventoryBalance: true,
    },
    orderBy: { sequence: "asc" },
  });
  const reservedTotal = sources.reduce(
    (sum, source) => sum.plus(source.quantity),
    new Prisma.Decimal(0),
  );

  return {
    fill,
    sources,
    requiredQuantity: required,
    reservedQuantity: reservedTotal,
    remainingQuantity: Prisma.Decimal.max(
      required.minus(reservedTotal),
      new Prisma.Decimal(0),
    ),
    complete: reservedTotal.eq(required),
  };
}

export async function reserveInventorySourceForFill(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    siteId: string;
    actorId: string;
    productId: string;
    productLotId: string;
    productExpirationId: string;
    quantity: Prisma.Decimal | number | string;
  },
) {
  const quantity = positiveQuantity(input.quantity);
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: input.fillId },
    select: {
      id: true,
      quantity: true,
      inventoryReservedAt: true,
      inventoryCommittedAt: true,
      inventoryReturnedAt: true,
      billingProductId: true,
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

  const required = positiveQuantity(fill.quantity);
  const existingSources = await tx.fillProductSource.findMany({
    where: { fillId: fill.id },
    orderBy: { sequence: "asc" },
  });

  if (existingSources.length >= 4) {
    throw new InventoryError(
      409,
      "FILL_SOURCE_LIMIT_REACHED",
      "A dispense part may use no more than four physical product sources.",
    );
  }

  const alreadyReserved = existingSources.reduce(
    (sum, source) => sum.plus(source.quantity),
    new Prisma.Decimal(0),
  );
  const remaining = required.minus(alreadyReserved);
  if (remaining.lte(0)) {
    throw new InventoryError(
      409,
      "FILL_ALREADY_FULLY_SOURCED",
      "The full physical dispense quantity has already been allocated.",
    );
  }
  if (quantity.gt(remaining)) {
    throw new InventoryError(
      409,
      "FILL_SOURCE_QUANTITY_EXCEEDS_REMAINDER",
      "This source quantity exceeds the remaining physical dispense quantity.",
      {
        requestedQuantity: quantity.toString(),
        remainingQuantity: remaining.toString(),
      },
    );
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
    include: {
      product: {
        include: { manufacturer: true, medication: true },
      },
      productLot: true,
      productExpiration: true,
    },
  });

  if (!balance) {
    throw new InventoryError(
      409,
      "INVENTORY_NOT_RECEIVED",
      "No on-hand inventory has been received for this NDC, lot, and expiration.",
    );
  }

  if (
    existingSources.some(
      (source) => source.inventoryBalanceId === balance.id,
    )
  ) {
    throw new InventoryError(
      409,
      "FILL_SOURCE_ALREADY_SELECTED",
      "This exact NDC/lot/expiration source is already part of the fill.",
    );
  }

  const locked = await lockBalance(tx, balance.id);
  await ensureBalanceNotRecalled(tx, {
    siteId: input.siteId,
    balanceId: locked.id,
  });

  const available = locked.onHandQuantity
    .minus(locked.reservedQuantity)
    .minus(locked.quarantinedQuantity);
  if (available.lt(quantity)) {
    throw new InventoryError(
      409,
      "INSUFFICIENT_INVENTORY",
      "There is not enough available inventory in this product source.",
      {
        balanceId: locked.id,
        availableQuantity: available.toString(),
        requestedQuantity: quantity.toString(),
      },
    );
  }

  const usedSequences = new Set(existingSources.map((source) => source.sequence));
  const sequence = [1, 2, 3, 4].find((value) => !usedSequences.has(value));
  if (!sequence) {
    throw new InventoryError(
      409,
      "FILL_SOURCE_LIMIT_REACHED",
      "A dispense part may use no more than four physical product sources.",
    );
  }

  const source = await tx.fillProductSource.create({
    data: {
      fillId: fill.id,
      sequence,
      productId: balance.productId,
      manufacturerId: balance.product.manufacturerId,
      productLotId: balance.productLotId,
      productExpirationId: balance.productExpirationId,
      inventoryBalanceId: balance.id,
      quantity,
      ndcSnapshot: balance.product.ndc,
      manufacturerSnapshot: balance.product.manufacturer.name,
      lotNumberSnapshot: balance.productLot.lotNumber,
      expirationSnapshot: balance.productExpiration.expirationDate,
    },
  });

  const updatedBalance = await tx.inventoryBalance.update({
    where: { id: locked.id },
    data: {
      reservedQuantity: locked.reservedQuantity.plus(quantity),
    },
  });

  const reservedAt = fill.inventoryReservedAt ?? new Date();
  await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: locked.id,
      fillId: fill.id,
      actorId: input.actorId,
      type: "RESERVE",
      onHandDelta: 0,
      reservedDelta: quantity,
      reason: `Product Fill source #${sequence} reserved`,
      reference: source.id,
    },
  });

  const positions = await tx.inventoryStockPosition.findMany({
    where: {
      inventoryBalanceId: locked.id,
      state: "AVAILABLE",
      quantity: { gt: 0 },
    },
    include: { location: true },
  });
  const activePositionAllocations = await tx.inventoryAllocation.findMany({
    where: {
      inventoryBalanceId: locked.id,
      status: "ACTIVE",
      inventoryStockPositionId: { not: null },
    },
    select: {
      inventoryStockPositionId: true,
      quantity: true,
    },
  });
  const reservedByPosition = new Map<string, Prisma.Decimal>();
  for (const allocation of activePositionAllocations) {
    if (!allocation.inventoryStockPositionId) continue;
    reservedByPosition.set(
      allocation.inventoryStockPositionId,
      (reservedByPosition.get(allocation.inventoryStockPositionId) ??
        new Prisma.Decimal(0)).plus(allocation.quantity),
    );
  }

  positions.sort((a, b) => {
    if (a.location.isDefaultDispensing !== b.location.isDefaultDispensing) {
      return a.location.isDefaultDispensing ? -1 : 1;
    }
    return a.location.code.localeCompare(b.location.code);
  });

  let positionRemainder = new Prisma.Decimal(quantity);
  const positionPlan: Array<{
    positionId: string;
    locationId: string;
    quantity: Prisma.Decimal;
  }> = [];
  for (const position of positions) {
    if (positionRemainder.lte(0)) break;
    const positionAvailable = Prisma.Decimal.max(
      position.quantity.minus(
        reservedByPosition.get(position.id) ?? new Prisma.Decimal(0),
      ),
      new Prisma.Decimal(0),
    );
    if (positionAvailable.lte(0)) continue;
    const take = Prisma.Decimal.min(positionAvailable, positionRemainder);
    positionPlan.push({
      positionId: position.id,
      locationId: position.locationId,
      quantity: take,
    });
    positionRemainder = positionRemainder.minus(take);
  }

  if (positionRemainder.gt(0)) {
    throw new InventoryError(
      409,
      "STOCK_POSITION_INCONSISTENT",
      "Available inventory exists in the balance but cannot be traced to enough physical AVAILABLE stock positions.",
      {
        balanceId: locked.id,
        requestedQuantity: quantity.toString(),
        unlocatedQuantity: positionRemainder.toString(),
      },
    );
  }

  for (const planned of positionPlan) {
    await tx.inventoryAllocation.create({
      data: {
        siteId: input.siteId,
        fillId: fill.id,
        inventoryBalanceId: locked.id,
        fillProductSourceId: source.id,
        actorId: input.actorId,
        inventoryStockPositionId: planned.positionId,
        quantity: planned.quantity,
        status: "ACTIVE",
      },
    });
  }

  const productIds = new Set([
    ...existingSources.map((item) => item.productId),
    balance.productId,
  ]);
  const firstSource = existingSources[0] ?? source;
  const totalReserved = alreadyReserved.plus(quantity);
  const complete = totalReserved.eq(required);
  const verifiedAt = complete ? new Date() : null;

  await tx.prescriptionFill.update({
    where: { id: fill.id },
    data: {
      productId: firstSource.productId,
      productLotId: firstSource.productLotId,
      productExpirationId: firstSource.productExpirationId,
      scannedNdc:
        existingSources[0]?.ndcSnapshot ?? balance.product.ndc,
      scannedLotNumber:
        existingSources[0]?.lotNumberSnapshot ?? balance.productLot.lotNumber,
      scannedExpiration:
        existingSources[0]?.expirationSnapshot ??
        balance.productExpiration.expirationDate,
      inventoryBalanceId: firstSource.inventoryBalanceId,
      inventoryReservedAt: reservedAt,
      inventoryCommittedAt: null,
      inventoryReturnedAt: null,
      productVerifiedAt: verifiedAt,
      billingProductId:
        productIds.size === 1 ? balance.productId : null,
    },
  });

  if (complete) {
    await fulfillDemandForFill(tx, fill.id, balance.productId);
  }

  return {
    source,
    balance: updatedBalance,
    sourceQuantity: quantity,
    totalReserved,
    requiredQuantity: required,
    remainingQuantity: Prisma.Decimal.max(
      required.minus(totalReserved),
      new Prisma.Decimal(0),
    ),
    complete,
    reservedAt,
  };
}

export async function removeInventorySourceForFill(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    sourceId: string;
    siteId: string;
    actorId: string;
    reason: string;
  },
) {
  const source = await tx.fillProductSource.findFirst({
    where: {
      id: input.sourceId,
      fillId: input.fillId,
      fill: { prescription: { siteId: input.siteId } },
    },
    include: { product: true },
  });

  if (!source) {
    throw new InventoryError(
      404,
      "FILL_SOURCE_NOT_FOUND",
      "Fill product source not found.",
    );
  }
  if (source.committedAt) {
    throw new InventoryError(
      409,
      "FILL_SOURCE_ALREADY_COMMITTED",
      "A committed product source cannot be removed from the fill.",
    );
  }

  const balance = await lockBalance(tx, source.inventoryBalanceId);
  if (balance.reservedQuantity.lt(source.quantity)) {
    throw new InventoryError(
      409,
      "INVENTORY_RESERVATION_INCONSISTENT",
      "The inventory balance no longer contains the source reservation.",
    );
  }

  await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      reservedQuantity: balance.reservedQuantity.minus(source.quantity),
    },
  });
  await tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      fillId: input.fillId,
      actorId: input.actorId,
      type: "RELEASE",
      onHandDelta: 0,
      reservedDelta: source.quantity.negated(),
      reason: input.reason,
      reference: source.id,
    },
  });
  await tx.inventoryAllocation.updateMany({
    where: {
      fillId: input.fillId,
      fillProductSourceId: source.id,
      status: "ACTIVE",
    },
    data: { status: "RELEASED", resolvedAt: new Date() },
  });
  await tx.fillProductSource.delete({ where: { id: source.id } });

  const remainingSources = await tx.fillProductSource.findMany({
    where: { fillId: input.fillId },
    orderBy: { sequence: "asc" },
  });
  const fill = await tx.prescriptionFill.findUniqueOrThrow({
    where: { id: input.fillId },
    select: { quantity: true },
  });
  const required = positiveQuantity(fill.quantity);
  const totalReserved = remainingSources.reduce(
    (sum, item) => sum.plus(item.quantity),
    new Prisma.Decimal(0),
  );
  const first = remainingSources[0] ?? null;
  const productIds = new Set(remainingSources.map((item) => item.productId));

  await tx.prescriptionFill.update({
    where: { id: input.fillId },
    data: {
      productId: first?.productId ?? null,
      productLotId: first?.productLotId ?? null,
      productExpirationId: first?.productExpirationId ?? null,
      scannedNdc: first?.ndcSnapshot ?? null,
      scannedLotNumber: first?.lotNumberSnapshot ?? null,
      scannedExpiration: first?.expirationSnapshot ?? null,
      inventoryBalanceId: first?.inventoryBalanceId ?? null,
      inventoryReservedAt:
        remainingSources.length > 0 ? new Date() : null,
      productVerifiedAt: totalReserved.eq(required) ? new Date() : null,
      billingProductId:
        remainingSources.length > 0 && productIds.size === 1
          ? first!.productId
          : null,
    },
  });

  const demand = await tx.inventoryDemand.findUnique({
    where: { fillId: input.fillId },
  });
  if (demand?.status === "FULFILLED") {
    await tx.inventoryDemand.update({
      where: { id: demand.id },
      data: { status: "OPEN", fulfilledAt: null },
    });
  }

  await reconcileDemandAvailability(
    tx,
    input.siteId,
    source.product.medicationId,
  );

  return getFillSourceReservationSummary(tx, input.fillId);
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
      inventoryCommittedAt: true,
    },
  });
  if (!fill || fill.inventoryCommittedAt) return null;

  const allocations = await tx.inventoryAllocation.findMany({
    where: { fillId: fill.id, status: "ACTIVE" },
    include: {
      inventoryBalance: {
        include: { product: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (allocations.length === 0) return null;

  const medicationIds = new Set<string>();
  for (const allocation of allocations) {
    const balance = await lockBalance(tx, allocation.inventoryBalanceId);
    if (balance.reservedQuantity.lt(allocation.quantity)) {
      throw new InventoryError(
        409,
        "INVENTORY_RESERVATION_INCONSISTENT",
        "An inventory source reservation is smaller than its allocated quantity.",
        {
          balanceId: balance.id,
          reservedQuantity: balance.reservedQuantity.toString(),
          allocationQuantity: allocation.quantity.toString(),
        },
      );
    }

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        reservedQuantity: balance.reservedQuantity.minus(allocation.quantity),
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
        reservedDelta: allocation.quantity.negated(),
        reason: input.reason,
        reference: allocation.fillProductSourceId,
      },
    });
    await tx.inventoryAllocation.update({
      where: { id: allocation.id },
      data: { status: "RELEASED", resolvedAt: new Date() },
    });
    medicationIds.add(allocation.inventoryBalance.product.medicationId);
  }

  await tx.fillProductSource.deleteMany({
    where: { fillId: fill.id, committedAt: null },
  });

  await tx.prescriptionFill.update({
    where: { id: fill.id },
    data: {
      inventoryReservedAt: null,
      productVerifiedAt: null,
      billingProductId: null,
    },
  });

  for (const medicationId of medicationIds) {
    await reconcileDemandAvailability(tx, input.siteId, medicationId);
  }

  return { releasedAllocationCount: allocations.length };
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
    select: { quantity: true, inventoryCommittedAt: true },
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

  const activeAllocations = await tx.inventoryAllocation.count({
    where: { fillId: input.fillId, status: "ACTIVE" },
  });
  if (activeAllocations > 0) {
    await releaseInventoryReservation(tx, {
      fillId: input.fillId,
      siteId: input.siteId,
      actorId: input.actorId,
      reason: "Product rescanned during Product Fill",
    });
  }

  const quantity = positiveQuantity(fill.quantity);
  const result = await reserveInventorySourceForFill(tx, {
    ...input,
    quantity,
  });

  return {
    balance: result.balance,
    quantity,
    reservedAt: result.reservedAt,
  };
}

export async function resizeInventoryReservationForFill(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    siteId: string;
    actorId: string;
    targetQuantity: Prisma.Decimal | number | string;
    reason: string;
  },
) {
  const targetQuantity = positiveQuantity(input.targetQuantity);
  const sources = await tx.fillProductSource.findMany({
    where: { fillId: input.fillId },
    orderBy: { sequence: "asc" },
  });

  if (sources.length === 0) {
    throw new InventoryError(
      409,
      "PARTIAL_RESERVATION_TRACEABILITY_MISSING",
      "The existing reservation has no physical product-source traceability.",
    );
  }

  const sourcePlan = sources.map((source) => ({
    productId: source.productId,
    productLotId: source.productLotId,
    productExpirationId: source.productExpirationId,
    quantity: source.quantity,
  }));

  await releaseInventoryReservation(tx, {
    fillId: input.fillId,
    siteId: input.siteId,
    actorId: input.actorId,
    reason: input.reason,
  });

  let remaining = targetQuantity;
  for (const planned of sourcePlan) {
    if (remaining.lte(0)) break;
    const quantity = Prisma.Decimal.min(planned.quantity, remaining);
    await reserveInventorySourceForFill(tx, {
      fillId: input.fillId,
      siteId: input.siteId,
      actorId: input.actorId,
      productId: planned.productId,
      productLotId: planned.productLotId,
      productExpirationId: planned.productExpirationId,
      quantity,
    });
    remaining = remaining.minus(quantity);
  }

  if (remaining.gt(0)) {
    throw new InventoryError(
      409,
      "PARTIAL_RESERVATION_RESIZE_FAILED",
      "The prior product sources could not satisfy the requested partial quantity.",
      { remainingQuantity: remaining.toString() },
    );
  }

  return getFillSourceReservationSummary(tx, input.fillId);
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
      inventoryCommittedAt: true,
      dispensedInOriginalContainer: true,
    },
  });

  if (!fill) {
    throw new InventoryError(404, "FILL_NOT_FOUND", "Fill not found.");
  }
  if (fill.inventoryCommittedAt) {
    return { committedAt: fill.inventoryCommittedAt };
  }

  const required = positiveQuantity(fill.quantity);
  const allocations = await tx.inventoryAllocation.findMany({
    where: { fillId: fill.id, status: "ACTIVE" },
    include: {
      inventoryBalance: true,
      fillProductSource: true,
      inventoryStockPosition: {
        include: { location: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const allocated = allocations.reduce(
    (sum, allocation) => sum.plus(allocation.quantity),
    new Prisma.Decimal(0),
  );

  if (allocations.length === 0 || !allocated.eq(required)) {
    throw new InventoryError(
      409,
      "INVENTORY_RESERVATION_REQUIRED",
      "Physical product sources must reserve the entire dispense-part quantity before pharmacist verification.",
      {
        requiredQuantity: required.toString(),
        allocatedQuantity: allocated.toString(),
      },
    );
  }

  const committedAt = new Date();
  const sourceExpirations: Date[] = [];

  for (const allocation of allocations) {
    const balance = await lockBalance(tx, allocation.inventoryBalanceId);
    await ensureBalanceNotRecalled(tx, {
      siteId: input.siteId,
      balanceId: balance.id,
    });

    if (
      balance.reservedQuantity.lt(allocation.quantity) ||
      balance.onHandQuantity.lt(allocation.quantity)
    ) {
      throw new InventoryError(
        409,
        "INVENTORY_RESERVATION_INCONSISTENT",
        "An inventory balance cannot satisfy its allocated source quantity.",
        {
          balanceId: balance.id,
          onHandQuantity: balance.onHandQuantity.toString(),
          reservedQuantity: balance.reservedQuantity.toString(),
          sourceQuantity: allocation.quantity.toString(),
        },
      );
    }

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        onHandQuantity: balance.onHandQuantity.minus(allocation.quantity),
        reservedQuantity: balance.reservedQuantity.minus(allocation.quantity),
      },
    });
    await adjustStockPosition(tx, {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      state: "AVAILABLE",
      delta: allocation.quantity.negated(),
      locationId: allocation.inventoryStockPosition?.locationId ?? undefined,
    });
    await tx.inventoryTransaction.create({
      data: {
        siteId: input.siteId,
        inventoryBalanceId: balance.id,
        fillId: fill.id,
        actorId: input.actorId,
        type: "DISPENSE",
        onHandDelta: allocation.quantity.negated(),
        reservedDelta: allocation.quantity.negated(),
        reason: "Pharmacist verification committed dispensed inventory source",
        reference: allocation.fillProductSourceId,
      },
    });
    await tx.inventoryAllocation.update({
      where: { id: allocation.id },
      data: { status: "COMMITTED", resolvedAt: committedAt },
    });

    if (allocation.fillProductSource) {
      sourceExpirations.push(allocation.fillProductSource.expirationSnapshot);
      await tx.fillProductSource.update({
        where: { id: allocation.fillProductSource.id },
        data: { committedAt },
      });
    }
  }

  const patientDiscardDate = fill.dispensedInOriginalContainer
    ? null
    : calculateNcPatientDiscardDate(committedAt, sourceExpirations);

  await tx.prescriptionFill.update({
    where: { id: fill.id },
    data: {
      inventoryCommittedAt: committedAt,
      inventoryReturnedAt: null,
      patientDiscardDate,
    },
  });

  await ensureBiologicCommunicationTask(tx, {
    fillId: fill.id,
    siteId: input.siteId,
    dispensedAt: committedAt,
  });

  return { committedAt, patientDiscardDate };
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
      inventoryCommittedAt: true,
      inventoryReturnedAt: true,
    },
  });

  if (!fill?.inventoryCommittedAt || fill.inventoryReturnedAt) {
    return null;
  }

  const allocations = await tx.inventoryAllocation.findMany({
    where: { fillId: fill.id, status: "COMMITTED" },
    include: {
      inventoryBalance: {
        include: { product: true, productLot: true, productExpiration: true },
      },
      fillProductSource: true,
      inventoryStockPosition: {
        include: { location: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (allocations.length === 0) return null;

  const returnedAt = new Date();
  const medicationIds = new Set<string>();
  for (const allocation of allocations) {
    const balance = await lockBalance(tx, allocation.inventoryBalanceId);
    const recall = await tx.recallCase.findFirst({
      where: {
        siteId: input.siteId,
        productId: allocation.inventoryBalance.productId,
        status: "ACTIVE",
        OR: [
          { lotNumberSearch: null },
          {
            lotNumberSearch:
              allocation.inventoryBalance.productLot.lotNumberSearch,
          },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    const expirationEnd = new Date(
      allocation.fillProductSource?.expirationSnapshot ??
        allocation.inventoryBalance.productExpiration.expirationDate,
    );
    expirationEnd.setUTCHours(23, 59, 59, 999);
    const expired = expirationEnd.getTime() < returnedAt.getTime();

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        onHandQuantity: balance.onHandQuantity.plus(allocation.quantity),
      },
    });
    await adjustStockPosition(tx, {
      siteId: input.siteId,
      inventoryBalanceId: balance.id,
      state: "AVAILABLE",
      delta: allocation.quantity,
      locationId: allocation.inventoryStockPosition?.locationId ?? undefined,
    });
    await tx.inventoryTransaction.create({
      data: {
        siteId: input.siteId,
        inventoryBalanceId: balance.id,
        fillId: fill.id,
        actorId: input.actorId,
        type: "RETURN_TO_STOCK",
        onHandDelta: allocation.quantity,
        reservedDelta: 0,
        reason: input.reason,
        reference: allocation.fillProductSourceId,
      },
    });

    if (recall || expired) {
      await quarantineInventory(tx, {
        balanceId: balance.id,
        siteId: input.siteId,
        actorId: input.actorId,
        quantity: allocation.quantity,
        reasonCode: recall ? "RECALL" : "EXPIRED",
        note: recall
          ? `Returned fill quarantined because recall ${recall.reference} is active.`
          : "Returned fill quarantined because the product is expired.",
        recallCaseId: recall?.id ?? null,
      });
    }

    await tx.inventoryAllocation.update({
      where: { id: allocation.id },
      data: { status: "RETURNED", resolvedAt: returnedAt },
    });
    if (allocation.fillProductSource) {
      await tx.fillProductSource.update({
        where: { id: allocation.fillProductSource.id },
        data: { returnedAt },
      });
    }
    medicationIds.add(allocation.inventoryBalance.product.medicationId);
  }

  await tx.prescriptionFill.update({
    where: { id: fill.id },
    data: { inventoryReturnedAt: returnedAt },
  });

  for (const medicationId of medicationIds) {
    await reconcileDemandAvailability(tx, input.siteId, medicationId);
  }

  return { returnedAt, returnedAllocationCount: allocations.length };
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

  await adjustStockPosition(tx, {
    siteId: input.siteId,
    inventoryBalanceId: balance.id,
    state: "AVAILABLE",
    delta,
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

  const adjustedProduct = await tx.product.findUnique({
    where: { id: balance.productId },
    select: { medicationId: true },
  });
  if (adjustedProduct) {
    await reconcileDemandAvailability(
      tx,
      input.siteId,
      adjustedProduct.medicationId,
    );
  }

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

  await moveStockState(tx, {
    siteId: input.siteId,
    inventoryBalanceId: balance.id,
    quantity,
    fromState: "AVAILABLE",
    toState: "QUARANTINED",
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

  const quarantinedProduct = await tx.product.findUnique({
    where: { id: balance.productId },
    select: { medicationId: true },
  });
  if (quarantinedProduct) {
    await reconcileDemandAvailability(
      tx,
      input.siteId,
      quarantinedProduct.medicationId,
    );
  }

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

  await moveStockState(tx, {
    siteId: input.siteId,
    inventoryBalanceId: balance.id,
    quantity: hold.quantity,
    fromState: "QUARANTINED",
    toState: "AVAILABLE",
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

  const releasedProduct = await tx.product.findUnique({
    where: { id: balance.productId },
    select: { medicationId: true },
  });
  if (releasedProduct) {
    await reconcileDemandAvailability(
      tx,
      input.siteId,
      releasedProduct.medicationId,
    );
  }

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

  await adjustStockPosition(tx, {
    siteId: input.siteId,
    inventoryBalanceId: balance.id,
    state: "QUARANTINED",
    delta: hold.quantity.negated(),
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

  const disposedProduct = await tx.product.findUnique({
    where: { id: balance.productId },
    select: { medicationId: true },
  });
  if (disposedProduct) {
    await reconcileDemandAvailability(
      tx,
      input.siteId,
      disposedProduct.medicationId,
    );
  }

  return { balance: updated, hold: resolved, transaction };
}
