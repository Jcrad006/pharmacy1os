import cors from "@fastify/cors";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { developmentRoutes } from "./routes/development.js";
import { patientRoutes } from "./routes/patients.js";
import { prescriberRoutes } from "./routes/prescribers.js";
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
  app.register(developmentRoutes, { prefix: "/api" });
  app.register(patientRoutes, { prefix: "/api" });
  app.register(prescriberRoutes, { prefix: "/api" });
  app.register(prescriptionRoutes, { prefix: "/api" });

  return app;
}
