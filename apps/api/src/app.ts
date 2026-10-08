import cors from "@fastify/cors";
import Fastify from "fastify";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { healthRoutes } from "./routes/health.js";
import { developmentRoutes } from "./routes/development.js";
import { authRoutes } from "./routes/auth.js";
import { staffRoutes } from "./routes/staff.js";
import { privilegedAccessRoutes } from "./routes/privilegedAccess.js";
import { workforceSecurityRoutes } from "./routes/workforceSecurity.js";
import { registerSecurityMonitoring, securityMonitoringRoutes } from "./security/securityMonitoring.js";
import { assertRuntimeSafetyConfiguration } from "./security/runtimeSafety.js";
import { patientRoutes } from "./routes/patients.js";
import { prescriberRoutes } from "./routes/prescribers.js";
import { prescriptionRoutes } from "./routes/prescriptions.js";
import { clinicalRoutes } from "./routes/clinical.js";
import { exceptionRoutes } from "./routes/exceptions.js";
import { catalogRoutes } from "./routes/catalog.js";
import { receivingRoutes } from "./routes/receiving.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { inventoryOperationsRoutes } from "./routes/inventoryOperations.js";
import { inventoryArchitectureRoutes } from "./routes/inventoryArchitecture.js";
import { thirdPartyRoutes } from "./routes/thirdParty.js";
import { posRoutes } from "./routes/pos.js";
import { documentRoutes } from "./routes/documents.js";
import { systemMaintenanceRoutes } from "./routes/systemMaintenance.js";

type BuildAppOptions = {
  serveWeb?: boolean;
  webDistPath?: string;
};

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string) {
  return contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function buildApp(options: BuildAppOptions = {}) {
  // Enforce this gate even for alternative server entrypoints/inject harnesses.
  assertRuntimeSafetyConfiguration();
  const app = Fastify({
    logger: true,
    requestIdHeader: "x-request-id",
    bodyLimit: 36 * 1024 * 1024,
  });

  registerSecurityMonitoring(app);

  app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    );
    if (request.url === "/api" || request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "private, no-store");
    }
    return payload;
  });

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: "/api" });
  app.register(staffRoutes, { prefix: "/api" });
  app.register(privilegedAccessRoutes, { prefix: "/api" });
  app.register(workforceSecurityRoutes, { prefix: "/api" });
  app.register(securityMonitoringRoutes, { prefix: "/api" });
  app.register(developmentRoutes, { prefix: "/api" });
  app.register(patientRoutes, { prefix: "/api" });
  app.register(prescriberRoutes, { prefix: "/api" });
  app.register(prescriptionRoutes, { prefix: "/api" });
  app.register(clinicalRoutes, { prefix: "/api" });
  app.register(exceptionRoutes, { prefix: "/api" });
  app.register(catalogRoutes, { prefix: "/api" });
  app.register(receivingRoutes, { prefix: "/api" });
  app.register(inventoryRoutes, { prefix: "/api" });
  app.register(inventoryOperationsRoutes, { prefix: "/api" });
  app.register(inventoryArchitectureRoutes, { prefix: "/api" });
  app.register(thirdPartyRoutes, { prefix: "/api" });
  app.register(posRoutes, { prefix: "/api" });
  app.register(documentRoutes, { prefix: "/api" });
  app.register(systemMaintenanceRoutes, { prefix: "/api" });

  if (options.serveWeb) {
    const webRoot = resolve(
      options.webDistPath ??
        fileURLToPath(new URL("../../web/dist/", import.meta.url)),
    );
    const webRootPrefix = `${webRoot}${sep}`;

    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.url === "/api" ||
        request.url.startsWith("/api/") ||
        request.url === "/health"
      ) {
        return reply.code(404).send({ error: "Route not found." });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return reply.code(404).send({ error: "Route not found." });
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(request.url.split("?")[0] ?? "/");
      } catch {
        return reply.code(400).send({ error: "Invalid request path." });
      }

      const relativePath =
        pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      let candidate = resolve(webRoot, relativePath);

      if (!candidate.startsWith(webRootPrefix)) {
        return reply.code(404).send({ error: "Route not found." });
      }

      if (!(await isFile(candidate))) {
        if (extname(relativePath)) {
          return reply.code(404).send({ error: "Asset not found." });
        }

        candidate = resolve(webRoot, "index.html");
        if (!(await isFile(candidate))) {
          return reply.code(503).send({
            error:
              "The workstation web build is unavailable. Run the web build before starting hosted mode.",
          });
        }
      }

      const content = await readFile(candidate);
      return reply.type(contentTypeFor(candidate)).send(content);
    });
  }

  return app;
}
