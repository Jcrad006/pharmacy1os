import {
  Prisma,
  type InventoryDemandSource,
  type InventoryExceptionType,
  type InventoryStockState,
} from "@prisma/client";
import { InventoryError } from "./inventoryError.js";

function decimal(value: Prisma.Decimal | number | string) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function availableQuantity(balance: {
  onHandQuantity: Prisma.Decimal;
  reservedQuantity: Prisma.Decimal;
  quarantinedQuantity: Prisma.Decimal;
}) {
  return balance.onHandQuantity
    .minus(balance.reservedQuantity)
    .minus(balance.quarantinedQuantity);
}

async function findDefaultLocation(
  tx: Prisma.TransactionClient,
  siteId: string,
  state: InventoryStockState,
) {
  const location = await tx.inventoryLocation.findFirst({
    where: {
      siteId,
      active: true,
      ...(state === "QUARANTINED"
        ? { isQuarantine: true }
        : {
            OR: [
              { isDefaultReceiving: true },
              { isDefaultDispensing: true },
            ],
          }),
    },
    orderBy:
      state === "QUARANTINED"
        ? [{ isQuarantine: "desc" }, { code: "asc" }]
        : [
            { isDefaultReceiving: "desc" },
            { isDefaultDispensing: "desc" },
            { code: "asc" },
          ],
  });

  if (!location) {
    throw new InventoryError(
      409,
      "INVENTORY_LOCATION_REQUIRED",
      state === "QUARANTINED"
        ? "A quarantine inventory location is required for this pharmacy site."
        : "A default receiving/dispensing inventory location is required for this pharmacy site.",
    );
  }

  return location;
}

async function validateLocation(
  tx: Prisma.TransactionClient,
  siteId: string,
  locationId: string,
) {
  const location = await tx.inventoryLocation.findFirst({
    where: { id: locationId, siteId, active: true },
  });
  if (!location) {
    throw new InventoryError(
      404,
      "INVENTORY_LOCATION_NOT_FOUND",
      "Inventory location not found at this pharmacy site.",
    );
  }
  return location;
}

export async function adjustStockPosition(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    inventoryBalanceId: string;
    state: InventoryStockState;
    delta: Prisma.Decimal | number | string;
    locationId?: string | null;
  },
) {
  const delta = decimal(input.delta);
  if (delta.eq(0)) return [];

  if (delta.gt(0)) {
    const location = input.locationId
      ? await validateLocation(tx, input.siteId, input.locationId)
      : await findDefaultLocation(tx, input.siteId, input.state);

    const position = await tx.inventoryStockPosition.upsert({
      where: {
        inventoryBalanceId_locationId_state: {
          inventoryBalanceId: input.inventoryBalanceId,
          locationId: location.id,
          state: input.state,
        },
      },
      update: {
        quantity: { increment: delta },
      },
      create: {
        inventoryBalanceId: input.inventoryBalanceId,
        locationId: location.id,
        state: input.state,
        quantity: delta,
      },
      include: { location: true },
    });
    return [position];
  }

  let remaining = delta.abs();
  const positions = await tx.inventoryStockPosition.findMany({
    where: {
      inventoryBalanceId: input.inventoryBalanceId,
      state: input.state,
      quantity: { gt: 0 },
      ...(input.locationId ? { locationId: input.locationId } : {}),
    },
    include: { location: true },
  });

  positions.sort((a, b) => {
    if (a.location.isDefaultDispensing !== b.location.isDefaultDispensing) {
      return a.location.isDefaultDispensing ? -1 : 1;
    }
    return a.location.code.localeCompare(b.location.code);
  });

  const total = positions.reduce(
    (sum, position) => sum.plus(position.quantity),
    new Prisma.Decimal(0),
  );
  if (total.lt(remaining)) {
    throw new InventoryError(
      409,
      "STOCK_POSITION_INCONSISTENT",
      "Physical stock-position quantity is insufficient for this inventory movement.",
      {
        inventoryBalanceId: input.inventoryBalanceId,
        state: input.state,
        positionQuantity: total.toString(),
        requestedQuantity: remaining.toString(),
      },
    );
  }

  const updated = [];
  for (const position of positions) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(position.quantity, remaining);
    const next = await tx.inventoryStockPosition.update({
      where: { id: position.id },
      data: { quantity: position.quantity.minus(take) },
      include: { location: true },
    });
    updated.push(next);
    remaining = remaining.minus(take);
  }

  return updated;
}

export async function moveStockState(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    inventoryBalanceId: string;
    quantity: Prisma.Decimal | number | string;
    fromState: InventoryStockState;
    toState: InventoryStockState;
    toLocationId?: string | null;
  },
) {
  const quantity = decimal(input.quantity);
  if (quantity.lte(0)) {
    throw new InventoryError(
      400,
      "INVALID_POSITION_QUANTITY",
      "Physical stock movement quantity must be greater than zero.",
    );
  }
  await adjustStockPosition(tx, {
    siteId: input.siteId,
    inventoryBalanceId: input.inventoryBalanceId,
    state: input.fromState,
    delta: quantity.negated(),
  });
  return adjustStockPosition(tx, {
    siteId: input.siteId,
    inventoryBalanceId: input.inventoryBalanceId,
    state: input.toState,
    delta: quantity,
    locationId: input.toLocationId,
  });
}

export async function moveStockLocation(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    inventoryBalanceId: string;
    actorId: string;
    fromLocationId: string;
    toLocationId: string;
    state: InventoryStockState;
    quantity: Prisma.Decimal | number | string;
    reason: string;
  },
) {
  const quantity = decimal(input.quantity);
  if (quantity.lte(0)) {
    throw new InventoryError(
      400,
      "INVALID_POSITION_QUANTITY",
      "Location movement quantity must be greater than zero.",
    );
  }
  await validateLocation(tx, input.siteId, input.fromLocationId);
  await validateLocation(tx, input.siteId, input.toLocationId);

  await adjustStockPosition(tx, {
    siteId: input.siteId,
    inventoryBalanceId: input.inventoryBalanceId,
    state: input.state,
    delta: quantity.negated(),
    locationId: input.fromLocationId,
  });
  await adjustStockPosition(tx, {
    siteId: input.siteId,
    inventoryBalanceId: input.inventoryBalanceId,
    state: input.state,
    delta: quantity,
    locationId: input.toLocationId,
  });

  return tx.inventoryTransaction.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: input.inventoryBalanceId,
      actorId: input.actorId,
      type: "MOVE_LOCATION",
      onHandDelta: 0,
      reservedDelta: 0,
      quarantinedDelta: 0,
      source: "LOCATION_MOVE",
      reference: `${input.fromLocationId}->${input.toLocationId}`,
      reason: input.reason.trim(),
    },
  });
}

export async function getInventoryPolicy(
  tx: Prisma.TransactionClient,
  siteId: string,
  productId?: string | null,
) {
  if (productId) {
    const productPolicy = await tx.inventoryPolicy.findFirst({
      where: {
        siteId,
        productId,
        scope: "PRODUCT",
        active: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (productPolicy) return productPolicy;
  }

  return tx.inventoryPolicy.findFirst({
    where: {
      siteId,
      scope: "SITE",
      active: true,
      policyKey: "SITE_DEFAULT",
    },
  });
}

export async function createOrUpdateFillDemand(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    source: InventoryDemandSource;
    note?: string | null;
  },
) {
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: input.fillId },
    include: {
      prescription: {
        select: { siteId: true, medicationId: true },
      },
    },
  });
  if (!fill || !fill.prescription.medicationId || !fill.quantity) {
    return null;
  }

  const demand = await tx.inventoryDemand.upsert({
    where: { fillId: fill.id },
    update: {
      requiredQuantity: fill.quantity,
      neededBy: fill.scheduledFor,
      note: input.note?.trim() || null,
      source: input.source,
      status: { set: "OPEN" },
      fulfilledAt: null,
    },
    create: {
      siteId: fill.prescription.siteId,
      medicationId: fill.prescription.medicationId,
      fillId: fill.id,
      source: input.source,
      requiredQuantity: fill.quantity,
      neededBy: fill.scheduledFor,
      note: input.note?.trim() || null,
    },
  });

  await reconcileDemandAvailability(
    tx,
    fill.prescription.siteId,
    fill.prescription.medicationId,
  );

  return tx.inventoryDemand.findUnique({ where: { id: demand.id } });
}

export async function fulfillDemandForFill(
  tx: Prisma.TransactionClient,
  fillId: string,
  productId?: string | null,
) {
  const demand = await tx.inventoryDemand.findUnique({ where: { fillId } });
  if (!demand) return null;
  return tx.inventoryDemand.update({
    where: { id: demand.id },
    data: {
      productId: productId ?? demand.productId,
      status: "FULFILLED",
      availableQuantity: demand.requiredQuantity,
      fulfilledAt: new Date(),
    },
  });
}

export async function cancelDemandForFill(
  tx: Prisma.TransactionClient,
  fillId: string,
) {
  const demand = await tx.inventoryDemand.findUnique({ where: { fillId } });
  if (!demand || demand.status === "FULFILLED") return demand;
  return tx.inventoryDemand.update({
    where: { id: demand.id },
    data: { status: "CANCELLED" },
  });
}

export async function reconcileDemandAvailability(
  tx: Prisma.TransactionClient,
  siteId: string,
  medicationId: string,
) {
  const balances = await tx.inventoryBalance.findMany({
    where: {
      siteId,
      product: { medicationId },
    },
    select: {
      onHandQuantity: true,
      reservedQuantity: true,
      quarantinedQuantity: true,
    },
  });
  const available = balances.reduce(
    (sum, balance) => sum.plus(availableQuantity(balance)),
    new Prisma.Decimal(0),
  );

  const demands = await tx.inventoryDemand.findMany({
    where: {
      siteId,
      medicationId,
      status: { in: ["OPEN", "READY"] },
    },
    orderBy: [{ neededBy: "asc" }, { createdAt: "asc" }],
  });

  for (const demand of demands) {
    await tx.inventoryDemand.update({
      where: { id: demand.id },
      data: {
        availableQuantity: available,
        status: available.gte(demand.requiredQuantity) ? "READY" : "OPEN",
      },
    });
  }

  return { availableQuantity: available, demandCount: demands.length };
}

export async function getFefoRecommendation(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    productId: string;
    quantity: Prisma.Decimal | number | string;
  },
) {
  const quantity = decimal(input.quantity);
  const policy = await getInventoryPolicy(tx, input.siteId, input.productId);
  const minShelfLifeDays = policy?.minShelfLifeDays ?? 30;
  const shelfLifeCutoff = new Date(
    Date.now() + minShelfLifeDays * 24 * 60 * 60 * 1000,
  );

  const balances = await tx.inventoryBalance.findMany({
    where: {
      siteId: input.siteId,
      productId: input.productId,
      productExpiration: {
        expirationDate: { gte: shelfLifeCutoff },
      },
    },
    include: {
      productLot: true,
      productExpiration: true,
      stockPositions: {
        where: { quantity: { gt: 0 } },
        include: { location: true },
      },
    },
    orderBy: { productExpiration: { expirationDate: "asc" } },
  });

  let remaining = quantity;
  const picks = [];
  for (const balance of balances) {
    if (remaining.lte(0)) break;
    const available = availableQuantity(balance);
    if (available.lte(0)) continue;
    const take = Prisma.Decimal.min(available, remaining);
    picks.push({
      balanceId: balance.id,
      productLotId: balance.productLotId,
      lotNumber: balance.productLot.lotNumber,
      expirationDate: balance.productExpiration.expirationDate,
      quantity: take.toString(),
      availableQuantity: available.toString(),
      locations: balance.stockPositions
        .filter((position) => position.state === "AVAILABLE")
        .map((position) => ({
          locationId: position.locationId,
          code: position.location.code,
          name: position.location.name,
          quantity: position.quantity.toString(),
        })),
    });
    remaining = remaining.minus(take);
  }

  return {
    requestedQuantity: quantity.toString(),
    recommendedQuantity: quantity.minus(remaining).toString(),
    shortageQuantity: remaining.toString(),
    fefoEnabled: policy?.fefoEnabled ?? true,
    minShelfLifeDays,
    picks,
  };
}

export async function projectBalanceAsOf(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    inventoryBalanceId: string;
    asOf: Date;
  },
) {
  const balance = await tx.inventoryBalance.findFirst({
    where: { id: input.inventoryBalanceId, siteId: input.siteId },
    include: {
      product: { include: { medication: true, manufacturer: true } },
      productLot: true,
      productExpiration: true,
    },
  });
  if (!balance) {
    throw new InventoryError(
      404,
      "INVENTORY_NOT_FOUND",
      "Inventory balance not found.",
    );
  }

  const aggregate = await tx.inventoryTransaction.aggregate({
    where: {
      inventoryBalanceId: balance.id,
      occurredAt: { lte: input.asOf },
    },
    _sum: {
      onHandDelta: true,
      reservedDelta: true,
      quarantinedDelta: true,
      extendedCost: true,
    },
  });

  const onHand = aggregate._sum.onHandDelta ?? new Prisma.Decimal(0);
  const reserved = aggregate._sum.reservedDelta ?? new Prisma.Decimal(0);
  const quarantined =
    aggregate._sum.quarantinedDelta ?? new Prisma.Decimal(0);

  return {
    balance,
    asOf: input.asOf,
    onHandQuantity: onHand,
    reservedQuantity: reserved,
    quarantinedQuantity: quarantined,
    availableQuantity: onHand.minus(reserved).minus(quarantined),
    recordedAcquisitionCost:
      aggregate._sum.extendedCost ?? new Prisma.Decimal(0),
  };
}

type DetectedException = {
  fingerprint: string;
  type: InventoryExceptionType;
  severity: "INFO" | "WARNING" | "HIGH";
  entityType: string;
  entityId?: string | null;
  title: string;
  detail: string;
};

export async function refreshInventoryExceptions(
  tx: Prisma.TransactionClient,
  siteId: string,
) {
  const sitePolicy = await getInventoryPolicy(tx, siteId);
  const detected: DetectedException[] = [];
  const now = new Date();

  const balances = await tx.inventoryBalance.findMany({
    where: { siteId },
    include: {
      product: { include: { medication: true } },
      productExpiration: true,
      stockPositions: true,
    },
  });

  const byProduct = new Map<string, typeof balances>();
  for (const balance of balances) {
    const group = byProduct.get(balance.productId) ?? [];
    group.push(balance);
    byProduct.set(balance.productId, group);

    const positionTotal = balance.stockPositions.reduce(
      (sum, position) => sum.plus(position.quantity),
      new Prisma.Decimal(0),
    );
    if (!positionTotal.eq(balance.onHandQuantity)) {
      detected.push({
        fingerprint: `position-imbalance:${balance.id}`,
        type: "POSITION_IMBALANCE",
        severity: "HIGH",
        entityType: "InventoryBalance",
        entityId: balance.id,
        title: "Physical location quantities do not match on-hand inventory",
        detail: `Balance ${balance.id} reports ${balance.onHandQuantity.toString()} on hand but ${positionTotal.toString()} across physical positions.`,
      });
    }

    const warningDays =
      (await getInventoryPolicy(tx, siteId, balance.productId))
        ?.expirationWarningDays ??
      sitePolicy?.expirationWarningDays ??
      90;
    const warningDate = new Date(
      now.getTime() + warningDays * 24 * 60 * 60 * 1000,
    );
    if (
      availableQuantity(balance).gt(0) &&
      balance.productExpiration.expirationDate <= warningDate
    ) {
      detected.push({
        fingerprint: `expiring:${balance.id}`,
        type: "EXPIRING_SOON",
        severity:
          balance.productExpiration.expirationDate <= now
            ? "HIGH"
            : "WARNING",
        entityType: "InventoryBalance",
        entityId: balance.id,
        title: "Inventory is expired or approaching expiration",
        detail: `${balance.product.medication.genericName} expires ${balance.productExpiration.expirationDate.toISOString()} with ${availableQuantity(balance).toString()} available.`,
      });
    }
  }

  for (const [productId, productBalances] of byProduct) {
    const policy = await getInventoryPolicy(tx, siteId, productId);
    if (!policy?.reorderPoint) continue;
    const available = productBalances.reduce(
      (sum, balance) => sum.plus(availableQuantity(balance)),
      new Prisma.Decimal(0),
    );
    const medicationId = productBalances[0]?.product.medicationId;
    const existingReorderDemand = await tx.inventoryDemand.findFirst({
      where: {
        siteId,
        productId,
        source: "REORDER",
        status: { in: ["OPEN", "READY"] },
      },
      orderBy: { createdAt: "asc" },
    });

    if (available.lt(policy.reorderPoint)) {
      detected.push({
        fingerprint: `reorder:${productId}`,
        type: "BELOW_REORDER_POINT",
        severity: "WARNING",
        entityType: "Product",
        entityId: productId,
        title: "Inventory below reorder point",
        detail: `Available quantity ${available.toString()} is below reorder point ${policy.reorderPoint.toString()}.`,
      });

      if (medicationId && policy.targetStockLevel) {
        const required = Prisma.Decimal.max(
          policy.targetStockLevel.minus(available),
          new Prisma.Decimal(0),
        );
        if (required.gt(0)) {
          if (existingReorderDemand) {
            await tx.inventoryDemand.update({
              where: { id: existingReorderDemand.id },
              data: {
                requiredQuantity: required,
                availableQuantity: available,
                status: "OPEN",
                note: `Automatic reorder demand to restore target stock ${policy.targetStockLevel.toString()}.`,
              },
            });
          } else {
            await tx.inventoryDemand.create({
              data: {
                siteId,
                medicationId,
                productId,
                source: "REORDER",
                requiredQuantity: required,
                availableQuantity: available,
                status: "OPEN",
                note: `Automatic reorder demand to restore target stock ${policy.targetStockLevel.toString()}.`,
              },
            });
          }
        }
      }
    } else if (existingReorderDemand) {
      await tx.inventoryDemand.update({
        where: { id: existingReorderDemand.id },
        data: {
          status: "CANCELLED",
          availableQuantity: available,
          note: "Automatic reorder demand closed because stock recovered above the reorder point.",
        },
      });
    }
  }

  const staleReservationHours = sitePolicy?.staleReservationHours ?? 24;
  const staleAllocationCutoff = new Date(
    now.getTime() - staleReservationHours * 60 * 60 * 1000,
  );
  const staleAllocations = await tx.inventoryAllocation.findMany({
    where: {
      siteId,
      status: "ACTIVE",
      createdAt: { lt: staleAllocationCutoff },
    },
    include: { fill: { include: { prescription: true } } },
  });
  for (const allocation of staleAllocations) {
    detected.push({
      fingerprint: `stale-allocation:${allocation.id}`,
      type: "STALE_RESERVATION",
      severity: "WARNING",
      entityType: "InventoryAllocation",
      entityId: allocation.id,
      title: "Inventory reservation is stale",
      detail: `Rx ${allocation.fill.prescription.rxNumber ?? allocation.fill.prescriptionId} has held ${allocation.quantity.toString()} units since ${allocation.createdAt.toISOString()}.`,
    });
  }

  const staleTransferHours = sitePolicy?.staleTransferHours ?? 48;
  const staleTransferCutoff = new Date(
    now.getTime() - staleTransferHours * 60 * 60 * 1000,
  );
  const transfers = await tx.inventoryTransfer.findMany({
    where: {
      status: "IN_TRANSIT",
      shippedAt: { lt: staleTransferCutoff },
      OR: [{ sourceSiteId: siteId }, { destinationSiteId: siteId }],
    },
  });
  for (const transfer of transfers) {
    detected.push({
      fingerprint: `stale-transfer:${transfer.id}`,
      type: "TRANSFER_STUCK",
      severity: "WARNING",
      entityType: "InventoryTransfer",
      entityId: transfer.id,
      title: "Inventory transfer remains in transit",
      detail: `Transfer ${transfer.id} has been in transit since ${transfer.shippedAt.toISOString()}.`,
    });
  }

  const overdueDays = sitePolicy?.purchaseOrderOverdueDays ?? 3;
  const overdueCutoff = new Date(
    now.getTime() - overdueDays * 24 * 60 * 60 * 1000,
  );
  const purchaseOrders = await tx.purchaseOrder.findMany({
    where: {
      siteId,
      status: { in: ["OPEN", "PARTIALLY_RECEIVED"] },
      createdAt: { lt: overdueCutoff },
    },
  });
  for (const order of purchaseOrders) {
    detected.push({
      fingerprint: `overdue-po:${order.id}`,
      type: "PURCHASE_ORDER_OVERDUE",
      severity: "INFO",
      entityType: "PurchaseOrder",
      entityId: order.id,
      title: "Purchase order remains outstanding",
      detail: `PO ${order.orderNumber} has remained ${order.status.toLowerCase().replaceAll("_", " ")} since ${order.createdAt.toISOString()}.`,
    });
  }

  const demands = await tx.inventoryDemand.findMany({
    where: { siteId, status: "OPEN" },
  });
  for (const demand of demands) {
    detected.push({
      fingerprint: `open-demand:${demand.id}`,
      type: "UNALLOCATED_DEMAND",
      severity:
        demand.neededBy && demand.neededBy <= now ? "HIGH" : "WARNING",
      entityType: "InventoryDemand",
      entityId: demand.id,
      title: "Inventory demand is not yet coverable",
      detail: `${demand.requiredQuantity.toString()} units are needed${demand.neededBy ? ` by ${demand.neededBy.toISOString()}` : ""}; currently ${demand.availableQuantity.toString()} available.`,
    });
  }

  const missingCostReceipts = await tx.inventoryTransaction.findMany({
    where: {
      siteId,
      type: "RECEIVE",
      unitCost: null,
      occurredAt: {
        gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
      },
    },
    take: 100,
  });
  for (const transaction of missingCostReceipts) {
    detected.push({
      fingerprint: `missing-cost:${transaction.id}`,
      type: "MISSING_ACQUISITION_COST",
      severity: "INFO",
      entityType: "InventoryTransaction",
      entityId: transaction.id,
      title: "Received inventory has no acquisition cost snapshot",
      detail: `Receipt transaction ${transaction.id} has no recorded unit acquisition cost.`,
    });
  }

  const fingerprints = new Set(detected.map((item) => item.fingerprint));

  for (const item of detected) {
    await tx.inventoryException.upsert({
      where: {
        siteId_fingerprint: {
          siteId,
          fingerprint: item.fingerprint,
        },
      },
      update: {
        type: item.type,
        severity: item.severity,
        entityType: item.entityType,
        entityId: item.entityId ?? null,
        title: item.title,
        detail: item.detail,
        lastDetectedAt: now,
        status: "OPEN",
        resolvedAt: null,
        resolvedById: null,
        resolutionNote: null,
      },
      create: {
        siteId,
        fingerprint: item.fingerprint,
        type: item.type,
        severity: item.severity,
        entityType: item.entityType,
        entityId: item.entityId ?? null,
        title: item.title,
        detail: item.detail,
        firstDetectedAt: now,
        lastDetectedAt: now,
      },
    });
  }

  const openExceptions = await tx.inventoryException.findMany({
    where: { siteId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
  });
  const automaticallyManagedTypes: InventoryExceptionType[] = [
    "BELOW_REORDER_POINT",
    "EXPIRING_SOON",
    "STALE_RESERVATION",
    "TRANSFER_STUCK",
    "PURCHASE_ORDER_OVERDUE",
    "UNALLOCATED_DEMAND",
    "POSITION_IMBALANCE",
    "MISSING_ACQUISITION_COST",
  ];

  for (const exception of openExceptions) {
    if (
      automaticallyManagedTypes.includes(exception.type) &&
      !fingerprints.has(exception.fingerprint)
    ) {
      await tx.inventoryException.update({
        where: { id: exception.id },
        data: {
          status: "RESOLVED",
          resolvedAt: now,
          resolutionNote: "Automatically resolved because the condition is no longer detected.",
        },
      });
    }
  }

  return tx.inventoryException.findMany({
    where: { siteId },
    orderBy: [
      { status: "asc" },
      { severity: "desc" },
      { lastDetectedAt: "desc" },
    ],
    take: 250,
  });
}
