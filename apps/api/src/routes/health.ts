import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { getDocumentVaultRecoveryState } from "../vaultCoordination.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_request, reply) => {
    const checks = {
      database: false,
      documentVaultRecoveryRequired: false,
    };

    try {
      await db.$queryRawUnsafe("SELECT 1");
      checks.database = true;
    } catch {
      checks.database = false;
    }

    const recovery = await getDocumentVaultRecoveryState().catch(() => ({
      reason: "Recovery state could not be read.",
    }));
    checks.documentVaultRecoveryRequired = Boolean(recovery);

    const healthy =
      checks.database && !checks.documentVaultRecoveryRequired;

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      service: "pharmacy1os-api",
      timestamp: new Date().toISOString(),
      checks,
    });
  });
}
