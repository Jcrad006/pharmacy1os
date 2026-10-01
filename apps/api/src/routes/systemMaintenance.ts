import type { FastifyInstance, FastifyReply } from "fastify";
import { writeAuditEvent } from "../audit.js";
import {
  createBackupSet,
  listBackupSets,
  listIntegrityReports,
  scanDocumentVaultIntegrity,
  verifyBackupSet,
} from "../backupIntegrity.js";
import { db } from "../db.js";
import { DocumentVaultError } from "../documentVault.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof AccessError || error instanceof DocumentVaultError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error instanceof DocumentVaultError
        ? { code: error.code, details: error.details }
        : {}),
    });
  }
  throw error;
}

export async function systemMaintenanceRoutes(app: FastifyInstance) {
  app.get("/system/backups", async (request, reply) => {
    try {
      await resolveDevelopmentActor(request, "system:backup");
      return { backups: await listBackupSets() };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/system/backups", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "system:backup");
      const backup = await createBackupSet();

      await writeAuditEvent(db, {
        siteId: actor.siteId,
        actorId: actor.id,
        action: "SYSTEM_BACKUP_CREATED",
        entityType: "BackupSet",
        entityId: backup.backupId,
        requestId: request.id,
        metadata: {
          scope: "GLOBAL_DATABASE_AND_DOCUMENT_VAULT",
          documentCount: backup.documentCount,
          databaseBytes: backup.databaseBytes,
          documentBytes: backup.documentBytes,
          integrityStatus: backup.integrityStatus,
          integrityReportId: backup.integrityReportId,
        },
      });

      return reply.code(201).send({ backup });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/system/backups/:id/verify", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "system:backup");
      const backupId = (request.params as { id: string }).id;
      const verification = await verifyBackupSet(backupId);

      await writeAuditEvent(db, {
        siteId: actor.siteId,
        actorId: actor.id,
        action: "SYSTEM_BACKUP_VERIFIED",
        entityType: "BackupSet",
        entityId: backupId,
        requestId: request.id,
        metadata: {
          scope: "GLOBAL_DATABASE_AND_DOCUMENT_VAULT",
          status: verification.status,
          findingCount: verification.findings.length,
        },
      });

      return { verification };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/system/document-vault/integrity-scan", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "system:backup");
      const report = await scanDocumentVaultIntegrity();

      await writeAuditEvent(db, {
        siteId: actor.siteId,
        actorId: actor.id,
        action: "DOCUMENT_VAULT_INTEGRITY_SCANNED",
        entityType: "DocumentVault",
        entityId: report.reportId,
        requestId: request.id,
        metadata: {
          scope: "GLOBAL_DOCUMENT_VAULT",
          status: report.status,
          documentCount: report.documentCount,
          checkedFileCount: report.checkedFileCount,
          orphanFileCount: report.orphanFileCount,
          findingCount: report.findings.length,
        },
      });

      return { report };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/system/document-vault/integrity-reports", async (request, reply) => {
    try {
      await resolveDevelopmentActor(request, "system:backup");
      return { reports: await listIntegrityReports() };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
