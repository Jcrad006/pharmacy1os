import type { FastifyRequest } from "fastify";
import type { User } from "@prisma/client";
import { db } from "../db.js";
import { roleHasPermission, type Permission, type Role } from "./roles.js";
import { authenticateSession } from "./sessions.js";

export class AccessError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function readHeader(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function resolveDevelopmentActor(
  request: FastifyRequest,
  permission?: Permission,
): Promise<User> {
  if (process.env.AUTH_MODE === "oidc") {
    const authenticated = await authenticateSession(request, permission);
    return authenticated.actor;
  }
  if (process.env.AUTH_MODE === "production" || process.env.NODE_ENV === "production" ||
      process.env.ALLOW_DEV_IDENTITY !== "true") {
    throw new AccessError(503, "Development identity mode is disabled.");
  }

  const externalAuthId = readHeader(request, "x-dev-user");
  if (!externalAuthId) {
    throw new AccessError(
      401,
      "Select a synthetic development user and send it in the x-dev-user header.",
    );
  }

  const actor = await db.user.findUnique({ where: { externalAuthId } });
  if (!actor || !actor.active) {
    throw new AccessError(401, "Synthetic development user is invalid or inactive.");
  }

  if (permission && !roleHasPermission(actor.role as Role, permission)) {
    throw new AccessError(403, `Role ${actor.role} lacks permission ${permission}.`);
  }

  return actor;
}
