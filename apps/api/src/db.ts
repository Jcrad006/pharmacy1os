import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { pharmacyDb?: PrismaClient };

export const db =
  globalForPrisma.pharmacyDb ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.pharmacyDb = db;
}
