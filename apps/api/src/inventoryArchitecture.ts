import {
  Prisma,
  type InventoryLocationType,
} from "@prisma/client";

export class InventoryArchitectureError extends Error {
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

export async function resolveEffectiveInventoryPolicy(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    medicationId?: string | null;
    productId?: string | null;
  },
) {
  const keys = [
    input.productId ? `PRODUCT:${input.productId}` : null,
    input.medicationId ? `MEDICATION:${input.medicationId}` : null,
    "SITE",
  ].filter(Boolean) as string[];

  const policies = await tx.inventoryPolicy.findMany({
    where: {
      siteId: input.siteId,
      policyKey: { in: keys },
    },
  });

  return (
    keys
      .map((key) => policies.find((policy) => policy.policyKey === key))
      .find(Boolean) ?? null
  );
}

export async function resolveInventoryLocation(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    locationId?: string | null;
    preferredTypes?: InventoryLocationType[];
  },
) {
  if (input.locationId) {
    const location = await tx.inventoryLocation.findFirst({
      where: {
        id: input.locationId,
        siteId: input.siteId,
        active: true,
      },
    });
    if (!location) {
      throw new InventoryArchitectureError(
        404,
        "INVENTORY_LOCATION_NOT_FOUND",
        "Inventory location was not found at this pharmacy site.",
      );
    }
    return location;
  }

  const preferredTypes: InventoryLocationType[] =
    input.preferredTypes && input.preferredTypes.length > 0
      ? input.preferredTypes
      : ["RECEIVING", "DISPENSING", "UNASSIGNED"];

  for (const type of preferredTypes) {
    const location = await tx.inventoryLocation.findFirst({
      where: {
        siteId: input.siteId,
        type,
        active: true,
      },
      orderBy: [{ pickPriority: "asc" }, { code: "asc" }],
    });
    if (location) return location;
  }

  return tx.inventoryLocation.create({
    data: {
      siteId: input.siteId,
      code: "UNASSIGNED",
      name: "Unassigned stock",
      type: "UNASSIGNED",
      pickPriority: 1000,
    },
  });
}

export async function addInventoryPosition(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    balanceId: string;
    quantity: Prisma.Decimal | number | string;
    actorId: string;
    locationId?: string | null;
    reason?: string | null;
    preferredTypes?: InventoryLocationType[];
  },
) {
  const quantity = decimal(input.quantity);
  if (quantity.lte(0)) return null;

  const location = await resolveInventoryLocation(tx, {
    siteId: input.siteId,
    locationId: input.locationId,
    preferredTypes: input.preferredTypes,
  });

  const existing = await tx.inventoryPosition.findUnique({
    where: {
      inventoryBalanceId_locationId: {
        inventoryBalanceId: input.balanceId,
        locationId: location.id,
      },
    },
  });

  const position = existing
    ? await tx.inventoryPosition.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity.plus(quantity) },
      })
    : await tx.inventoryPosition.create({
        data: {
          inventoryBalanceId: input.balanceId,
          locationId: location.id,
          quantity,
        },
      });

  const movement = await tx.inventoryLocationMovement.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: input.balanceId,
      fromLocationId: null,
      toLocationId: location.id,
      fromPositionId: null,
      toPositionId: position.id,
      quantity,
      actorId: input.actorId,
      reason: input.reason?.trim() || "Stock placed into physical location",
    },
  });

  return { position, location, movement };
}

export async function removeInventoryPosition(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    balanceId: string;
    quantity: Prisma.Decimal | number | string;
    actorId: string;
    locationId?: string | null;
    reason?: string | null;
  },
) {
  let remaining = decimal(input.quantity);
  if (remaining.lte(0)) return { removed: new Prisma.Decimal(0), movements: [] };

  const positions = await tx.inventoryPosition.findMany({
    where: {
      inventoryBalanceId: input.balanceId,
      quantity: { gt: 0 },
      location: {
        siteId: input.siteId,
        active: true,
        ...(input.locationId ? { id: input.locationId } : {}),
      },
    },
    include: { location: true },
    orderBy: [
      { location: { pickPriority: "asc" } },
      { updatedAt: "asc" },
    ],
  });

  const total = positions.reduce(
    (sum, position) => sum.plus(position.quantity),
    new Prisma.Decimal(0),
  );

  if (total.lt(remaining)) {
    throw new InventoryArchitectureError(
      409,
      "INVENTORY_LOCATION_COVERAGE_INSUFFICIENT",
      "Physical-location quantities do not cover the requested inventory movement.",
      {
        inventoryBalanceId: input.balanceId,
        positionedQuantity: total.toString(),
        requestedQuantity: remaining.toString(),
      },
    );
  }

  const movements = [];
  const requested = remaining;

  for (const position of positions) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(position.quantity, remaining);

    const updated = await tx.inventoryPosition.update({
      where: { id: position.id },
      data: { quantity: position.quantity.minus(take) },
    });

    movements.push(
      await tx.inventoryLocationMovement.create({
        data: {
          siteId: input.siteId,
          inventoryBalanceId: input.balanceId,
          fromLocationId: position.locationId,
          toLocationId: null,
          fromPositionId: position.id,
          toPositionId: null,
          quantity: take,
          actorId: input.actorId,
          reason:
            input.reason?.trim() || "Stock removed from physical location",
        },
      }),
    );

    remaining = remaining.minus(take);
    void updated;
  }

  return { removed: requested, movements };
}

export async function moveInventoryPosition(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    balanceId: string;
    fromLocationId: string;
    toLocationId: string;
    quantity: Prisma.Decimal | number | string;
    actorId: string;
    reason?: string | null;
  },
) {
  const quantity = decimal(input.quantity);
  if (quantity.lte(0)) {
    throw new InventoryArchitectureError(
      400,
      "INVALID_LOCATION_MOVE_QUANTITY",
      "Location movement quantity must be greater than zero.",
    );
  }
  if (input.fromLocationId === input.toLocationId) {
    throw new InventoryArchitectureError(
      400,
      "LOCATION_MOVE_SAME_LOCATION",
      "Source and destination locations must be different.",
    );
  }

  const [fromLocation, toLocation] = await Promise.all([
    resolveInventoryLocation(tx, {
      siteId: input.siteId,
      locationId: input.fromLocationId,
    }),
    resolveInventoryLocation(tx, {
      siteId: input.siteId,
      locationId: input.toLocationId,
    }),
  ]);

  const from = await tx.inventoryPosition.findUnique({
    where: {
      inventoryBalanceId_locationId: {
        inventoryBalanceId: input.balanceId,
        locationId: fromLocation.id,
      },
    },
  });

  if (!from || from.quantity.lt(quantity)) {
    throw new InventoryArchitectureError(
      409,
      "INSUFFICIENT_LOCATION_QUANTITY",
      "The source location does not contain enough quantity for this move.",
      {
        availableQuantity: from?.quantity.toString() ?? "0",
        requestedQuantity: quantity.toString(),
      },
    );
  }

  const existingTo = await tx.inventoryPosition.findUnique({
    where: {
      inventoryBalanceId_locationId: {
        inventoryBalanceId: input.balanceId,
        locationId: toLocation.id,
      },
    },
  });

  const updatedFrom = await tx.inventoryPosition.update({
    where: { id: from.id },
    data: { quantity: from.quantity.minus(quantity) },
  });

  const updatedTo = existingTo
    ? await tx.inventoryPosition.update({
        where: { id: existingTo.id },
        data: { quantity: existingTo.quantity.plus(quantity) },
      })
    : await tx.inventoryPosition.create({
        data: {
          inventoryBalanceId: input.balanceId,
          locationId: toLocation.id,
          quantity,
        },
      });

  const movement = await tx.inventoryLocationMovement.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: input.balanceId,
      fromLocationId: fromLocation.id,
      toLocationId: toLocation.id,
      fromPositionId: updatedFrom.id,
      toPositionId: updatedTo.id,
      quantity,
      actorId: input.actorId,
      reason: input.reason?.trim() || "Internal inventory location move",
    },
  });

  return { from: updatedFrom, to: updatedTo, movement };
}

export async function recordInventoryCostLayer(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    inventoryBalanceId: string;
    productId: string;
    sourceTransactionId: string;
    quantity: Prisma.Decimal | number | string;
    unitCost?: Prisma.Decimal | number | string | null;
    sourceType: string;
    reference?: string | null;
  },
) {
  if (input.unitCost === null || input.unitCost === undefined) return null;

  const quantity = decimal(input.quantity);
  const unitCost = decimal(input.unitCost);
  if (quantity.lte(0) || unitCost.lt(0)) return null;

  return tx.inventoryCostLayer.create({
    data: {
      siteId: input.siteId,
      inventoryBalanceId: input.inventoryBalanceId,
      productId: input.productId,
      sourceTransactionId: input.sourceTransactionId,
      quantityReceived: quantity,
      quantityRemaining: quantity,
      unitCost,
      sourceType: input.sourceType,
      reference: input.reference?.trim() || null,
    },
  });
}

export async function consumeInventoryCostLayers(
  tx: Prisma.TransactionClient,
  input: {
    balanceId: string;
    fillId: string;
    quantity: Prisma.Decimal | number | string;
  },
) {
  let remaining = decimal(input.quantity);
  const layers = await tx.inventoryCostLayer.findMany({
    where: {
      inventoryBalanceId: input.balanceId,
      quantityRemaining: { gt: 0 },
    },
    orderBy: [{ acquiredAt: "asc" }, { id: "asc" }],
  });

  const consumptions = [];
  for (const layer of layers) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(layer.quantityRemaining, remaining);

    await tx.inventoryCostLayer.update({
      where: { id: layer.id },
      data: { quantityRemaining: layer.quantityRemaining.minus(take) },
    });

    consumptions.push(
      await tx.inventoryCostConsumption.create({
        data: {
          inventoryCostLayerId: layer.id,
          inventoryBalanceId: input.balanceId,
          fillId: input.fillId,
          quantity: take,
          unitCost: layer.unitCost,
        },
      }),
    );

    remaining = remaining.minus(take);
  }

  return {
    consumptions,
    uncostedQuantity: remaining,
  };
}

export async function reverseInventoryCostConsumption(
  tx: Prisma.TransactionClient,
  fillId: string,
) {
  const active = await tx.inventoryCostConsumption.findMany({
    where: {
      fillId,
      reversedAt: null,
    },
    include: { inventoryCostLayer: true },
  });

  const reversedAt = new Date();
  for (const consumption of active) {
    await tx.inventoryCostLayer.update({
      where: { id: consumption.inventoryCostLayerId },
      data: {
        quantityRemaining:
          consumption.inventoryCostLayer.quantityRemaining.plus(
            consumption.quantity,
          ),
      },
    });
    await tx.inventoryCostConsumption.update({
      where: { id: consumption.id },
      data: { reversedAt },
    });
  }
  return active.length;
}

export async function depleteInventoryCostLayers(
  tx: Prisma.TransactionClient,
  input: {
    balanceId: string;
    quantity: Prisma.Decimal | number | string;
  },
) {
  let remaining = decimal(input.quantity);
  const layers = await tx.inventoryCostLayer.findMany({
    where: {
      inventoryBalanceId: input.balanceId,
      quantityRemaining: { gt: 0 },
    },
    orderBy: [{ acquiredAt: "asc" }, { id: "asc" }],
  });

  let depletedQuantity = new Prisma.Decimal(0);
  let depletedValue = new Prisma.Decimal(0);

  for (const layer of layers) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(layer.quantityRemaining, remaining);
    await tx.inventoryCostLayer.update({
      where: { id: layer.id },
      data: { quantityRemaining: layer.quantityRemaining.minus(take) },
    });
    depletedQuantity = depletedQuantity.plus(take);
    depletedValue = depletedValue.plus(take.mul(layer.unitCost));
    remaining = remaining.minus(take);
  }

  return {
    depletedQuantity,
    uncoveredQuantity: remaining,
    weightedUnitCost:
      depletedQuantity.gt(0)
        ? depletedValue.div(depletedQuantity)
        : null,
  };
}

export async function weightedUnitCostForBalance(
  tx: Prisma.TransactionClient,
  balanceId: string,
) {
  const layers = await tx.inventoryCostLayer.findMany({
    where: {
      inventoryBalanceId: balanceId,
      quantityRemaining: { gt: 0 },
    },
  });
  let quantity = new Prisma.Decimal(0);
  let value = new Prisma.Decimal(0);
  for (const layer of layers) {
    quantity = quantity.plus(layer.quantityRemaining);
    value = value.plus(layer.quantityRemaining.mul(layer.unitCost));
  }
  return quantity.gt(0) ? value.div(quantity) : null;
}

export async function claimInventoryOperationKey(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    operationType: string;
    idempotencyKey?: string | null;
  },
) {
  const key = input.idempotencyKey?.trim();
  if (!key) return { duplicate: false, record: null };

  const existing = await tx.inventoryOperationKey.findUnique({
    where: {
      siteId_operationType_idempotencyKey: {
        siteId: input.siteId,
        operationType: input.operationType,
        idempotencyKey: key,
      },
    },
  });

  if (existing) {
    return { duplicate: true, record: existing };
  }

  const record = await tx.inventoryOperationKey.create({
    data: {
      siteId: input.siteId,
      operationType: input.operationType,
      idempotencyKey: key,
    },
  });
  return { duplicate: false, record };
}

export async function completeInventoryOperationKey(
  tx: Prisma.TransactionClient,
  id: string | null | undefined,
  input: {
    resultEntityType: string;
    resultEntityId: string;
  },
) {
  if (!id) return null;
  return tx.inventoryOperationKey.update({
    where: { id },
    data: input,
  });
}

export async function reconcileDemandReceipt(
  tx: Prisma.TransactionClient,
  input: {
    purchaseOrderLineId: string;
    receiptQuantity: Prisma.Decimal | number | string;
  },
) {
  let remaining = decimal(input.receiptQuantity);
  const links = await tx.inventoryDemandSupplyLink.findMany({
    where: {
      purchaseOrderLineId: input.purchaseOrderLineId,
      inventoryDemand: {
        status: { in: ["OPEN", "PARTIALLY_SATISFIED"] },
      },
    },
    include: { inventoryDemand: true },
    orderBy: [
      { inventoryDemand: { dueAt: "asc" } },
      { createdAt: "asc" },
    ],
  });

  for (const link of links) {
    if (remaining.lte(0)) break;

    const linkRemaining = link.quantityPlanned.minus(link.quantityReceived);
    const demandRemaining = link.inventoryDemand.quantityRequired.minus(
      link.inventoryDemand.quantitySatisfied,
    );
    const apply = Prisma.Decimal.min(
      remaining,
      Prisma.Decimal.min(linkRemaining, demandRemaining),
    );

    if (apply.lte(0)) continue;

    await tx.inventoryDemandSupplyLink.update({
      where: { id: link.id },
      data: {
        quantityReceived: link.quantityReceived.plus(apply),
      },
    });

    const satisfied = link.inventoryDemand.quantitySatisfied.plus(apply);
    await tx.inventoryDemand.update({
      where: { id: link.inventoryDemandId },
      data: {
        quantitySatisfied: satisfied,
        status: satisfied.gte(link.inventoryDemand.quantityRequired)
          ? "SATISFIED"
          : "PARTIALLY_SATISFIED",
      },
    });

    remaining = remaining.minus(apply);
  }

  return { unappliedQuantity: remaining };
}
