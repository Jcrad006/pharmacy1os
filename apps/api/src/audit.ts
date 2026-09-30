import type { Prisma } from "@prisma/client";

export async function writeAuditEvent(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    actorId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    requestId?: string;
    metadata?: Prisma.InputJsonValue;
  },
) {
  return tx.auditEvent.create({
    data: {
      siteId: input.siteId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      requestId: input.requestId,
      metadata: input.metadata,
    },
  });
}
