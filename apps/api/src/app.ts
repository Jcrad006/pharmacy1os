import cors from "@fastify/cors";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { prescriptionRoutes } from "./routes/prescriptions.js";

export function buildApp() {
  const app = Fastify({
    logger: true,
    requestIdHeader: "x-request-id",
  });

  app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  });

  app.register(healthRoutes);
  app.register(prescriptionRoutes, { prefix: "/api" });

  return app;
}
