import type { FastifyInstance } from "fastify";
import { db } from "../db.js";

export async function developmentRoutes(app: FastifyInstance) {
  app.get("/dev/users", async (_request, reply) => {
    if (process.env.ALLOW_DEV_IDENTITY !== "true" || (process.env.AUTH_MODE && process.env.AUTH_MODE !== "development") || process.env.NODE_ENV === "production") {
      return reply.code(404).send({ error: "Not found" });
    }

    const users = await db.user.findMany({
      where: { active: true },
      orderBy: [{ role: "asc" }, { displayName: "asc" }],
      select: {
        externalAuthId: true,
        displayName: true,
        role: true,
        siteId: true,
        site: {
          select: {
            name: true,
          },
        },
      },
    });

    return {
      warning: "Development-only synthetic identities. Not production authentication.",
      users: users
        .filter((user) => user.externalAuthId !== null)
        .map((user) => ({
          externalAuthId: user.externalAuthId,
          displayName: user.displayName,
          role: user.role,
          siteId: user.siteId,
          siteName: user.site.name,
        })),
    };
  });
}
