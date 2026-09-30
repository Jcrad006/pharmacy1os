import type { FastifyInstance } from "fastify";

export async function prescriptionRoutes(app: FastifyInstance) {
  app.get("/prescriptions/queue", async () => ({
    notice: "Development-only placeholder. No PHI is stored or returned.",
    items: [],
  }));
}
