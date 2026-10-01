import { Prisma, type PrismaClient } from "@prisma/client";

type DbLike = Pick<
  PrismaClient,
  "inventoryLocation" | "inventoryPolicy" | "inventoryBalance" | "inventoryStockPosition"
>;

export async function ensureSiteInventoryInfrastructure(
  db: DbLike,
  siteId: string,
) {
  const storage = await db.inventoryLocation.upsert({
    where: {
      siteId_code: {
        siteId,
        code: "STORAGE",
      },
    },
    update: {
      name: "Primary Stock",
      type: "SHELF",
      active: true,
      isDefaultReceiving: true,
      isDefaultDispensing: true,
      isQuarantine: false,
    },
    create: {
      id: `location-storage-${siteId}`,
      siteId,
      code: "STORAGE",
      name: "Primary Stock",
      type: "SHELF",
      active: true,
      isDefaultReceiving: true,
      isDefaultDispensing: true,
      isQuarantine: false,
    },
  });

  const willCall = await db.inventoryLocation.upsert({
    where: {
      siteId_code: {
        siteId,
        code: "WILL-CALL",
      },
    },
    update: {
      name: "Will Call",
      type: "WILL_CALL",
      active: true,
      isDefaultReceiving: false,
      isDefaultDispensing: false,
      isQuarantine: false,
      barcode: `WC-DEFAULT-${siteId}`,
    },
    create: {
      id: `location-will-call-${siteId}`,
      siteId,
      code: "WILL-CALL",
      name: "Will Call",
      type: "WILL_CALL",
      active: true,
      isDefaultReceiving: false,
      isDefaultDispensing: false,
      isQuarantine: false,
      barcode: `WC-DEFAULT-${siteId}`,
    },
  });

  const quarantine = await db.inventoryLocation.upsert({
    where: {
      siteId_code: {
        siteId,
        code: "QUARANTINE",
      },
    },
    update: {
      name: "Quarantine",
      type: "QUARANTINE",
      active: true,
      isDefaultReceiving: false,
      isDefaultDispensing: false,
      isQuarantine: true,
    },
    create: {
      id: `location-quarantine-${siteId}`,
      siteId,
      code: "QUARANTINE",
      name: "Quarantine",
      type: "QUARANTINE",
      active: true,
      isDefaultReceiving: false,
      isDefaultDispensing: false,
      isQuarantine: true,
    },
  });

  const policy = await db.inventoryPolicy.upsert({
    where: {
      siteId_policyKey: {
        siteId,
        policyKey: "SITE_DEFAULT",
      },
    },
    update: {
      scope: "SITE",
      active: true,
    },
    create: {
      id: `policy-default-${siteId}`,
      siteId,
      scope: "SITE",
      policyKey: "SITE_DEFAULT",
      minShelfLifeDays: 30,
      expirationWarningDays: 90,
      fefoEnabled: true,
      staleReservationHours: 24,
      staleTransferHours: 48,
      purchaseOrderOverdueDays: 3,
      active: true,
    },
  });

  const balances = await db.inventoryBalance.findMany({
    where: { siteId },
    select: {
      id: true,
      onHandQuantity: true,
      quarantinedQuantity: true,
      stockPositions: {
        select: {
          id: true,
          state: true,
          quantity: true,
        },
      },
    },
  });

  for (const balance of balances) {
    const availableTarget = Prisma.Decimal.max(
      balance.onHandQuantity.minus(balance.quarantinedQuantity),
      new Prisma.Decimal(0),
    );
    const quarantinedTarget = Prisma.Decimal.max(
      balance.quarantinedQuantity,
      new Prisma.Decimal(0),
    );

    const availablePositions = balance.stockPositions.filter(
      (position) => position.state === "AVAILABLE",
    );
    const quarantinedPositions = balance.stockPositions.filter(
      (position) => position.state === "QUARANTINED",
    );

    if (availablePositions.length === 0 && availableTarget.gt(0)) {
      await db.inventoryStockPosition.create({
        data: {
          inventoryBalanceId: balance.id,
          locationId: storage.id,
          state: "AVAILABLE",
          quantity: availableTarget,
        },
      });
    }

    if (quarantinedPositions.length === 0 && quarantinedTarget.gt(0)) {
      await db.inventoryStockPosition.create({
        data: {
          inventoryBalanceId: balance.id,
          locationId: quarantine.id,
          state: "QUARANTINED",
          quantity: quarantinedTarget,
        },
      });
    }
  }

  return { storage, quarantine, willCall, policy };
}
