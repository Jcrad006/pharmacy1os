import cors from "@fastify/cors";
import Fastify from "fastify";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { healthRoutes } from "./routes/health.js";
import { developmentRoutes } from "./routes/development.js";
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
  const app = Fastify({
    logger: true,
    requestIdHeader: "x-request-id",
    bodyLimit: 36 * 1024 * 1024,
  });

  app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  });

  app.register(healthRoutes);
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
