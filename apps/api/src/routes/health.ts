import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    service: "pharmacy1os-api",
    timestamp: new Date().toISOString(),
  }));
}
