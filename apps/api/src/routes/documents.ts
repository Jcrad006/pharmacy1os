import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  DocumentSourceType,
  PrescriptionChangeCommunicationMethod,
  PrescriptionChangeType,
} from "@prisma/client";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";
import {
  DocumentVaultError,
  readImmutableDocument,
} from "../documentVault.js";
import {
  applyPrescriptionChangeRecord,
  createElectronicPrescriptionRender,
  createPrescriptionAnnotation,
  createPrescriptionSourceDocument,
  documentForRead,
  listPrescriptionDocuments,
  supersedePrescriptionAnnotation,
  type AnnotationInput,
} from "../documents/service.js";

type UploadBody = {
  sourceType?: DocumentSourceType;
  mimeType?: string;
  originalFilename?: string | null;
  base64Data?: string;
};

type AnnotationBody = {
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  change?: {
    changeType?: PrescriptionChangeType;
    whatChanged?: string;
    reason?: string;
    communicationMethod?: PrescriptionChangeCommunicationMethod | null;
    contactedParty?: string | null;
    authorizingPrescriber?: string | null;
    note?: string | null;
    structuredValue?: unknown;
  };
};

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof AccessError || error instanceof DocumentVaultError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error instanceof DocumentVaultError
        ? { code: error.code, details: error.details }
        : {}),
    });
  }
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return reply.code(500).send({
      error: "Document metadata exists, but the local source file is unavailable.",
      code: "DOCUMENT_FILE_MISSING",
    });
  }
  throw error;
}

export async function documentRoutes(app: FastifyInstance) {
  app.get("/prescriptions/:id/documents", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "document:read");
      const prescriptionId = (request.params as { id: string }).id;
      const documents = await listPrescriptionDocuments(prescriptionId, {
        siteId: actor.siteId,
      });
      return { documents };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/prescriptions/:id/documents/original", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "document:upload");
      const prescriptionId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as UploadBody;
      const document = await createPrescriptionSourceDocument(
        prescriptionId,
        body,
        {
          siteId: actor.siteId,
          actorId: actor.id,
          requestId: request.id,
        },
      );
      return reply.code(201).send({ document });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post(
    "/prescriptions/:id/documents/electronic-render",
    async (request, reply) => {
      try {
        const actor = await resolveDevelopmentActor(request, "document:upload");
        const prescriptionId = (request.params as { id: string }).id;
        const document = await createElectronicPrescriptionRender(
          prescriptionId,
          {
            siteId: actor.siteId,
            actorId: actor.id,
            requestId: request.id,
          },
        );
        return { document };
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get("/documents/:id/content", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "document:read");
      const documentId = (request.params as { id: string }).id;
      const document = await documentForRead(documentId, {
        siteId: actor.siteId,
      });
      const bytes = await readImmutableDocument({
        storageKey: document.storageKey,
        encrypted: document.encrypted,
      });

      return reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Disposition",
          `inline; filename="${(document.originalFilename ?? "document").replace(/["\\]/g, "_")}"`,
        )
        .type(document.mimeType)
        .send(bytes);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/documents/:id/annotations", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "document:annotate");
      const documentId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as AnnotationBody;
      const annotation = await createPrescriptionAnnotation(
        documentId,
        body as AnnotationInput,
        {
          siteId: actor.siteId,
          actorId: actor.id,
          requestId: request.id,
        },
      );
      return reply.code(201).send({ annotation });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post(
    "/prescription-changes/:id/apply",
    async (request, reply) => {
      try {
        const actor = await resolveDevelopmentActor(request, "prescription:edit");
        const changeRecordId = (request.params as { id: string }).id;
        const body = (request.body ?? {}) as { structuredValue?: unknown };
        const result = await applyPrescriptionChangeRecord(
          changeRecordId,
          body.structuredValue,
          {
            siteId: actor.siteId,
            actorId: actor.id,
            requestId: request.id,
          },
        );
        return result;
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post("/annotations/:id/supersede", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "document:annotate");
      const annotationId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as AnnotationBody;
      const annotation = await supersedePrescriptionAnnotation(
        annotationId,
        body as AnnotationInput,
        {
          siteId: actor.siteId,
          actorId: actor.id,
          requestId: request.id,
        },
      );
      return { annotation };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
