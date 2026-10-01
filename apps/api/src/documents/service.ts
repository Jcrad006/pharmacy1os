import {
  Prisma,
  type DocumentSourceType,
  type PrescriptionChangeCommunicationMethod,
  type PrescriptionChangeType,
} from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import {
  assertSupportedUploadedMimeType,
  decodeDocumentBase64,
  DocumentVaultError,
  removeStoredDocument,
  renderElectronicPrescriptionSvg,
  storeImmutableDocument,
} from "../documentVault.js";
import { withDocumentVaultWriteLease } from "../vaultCoordination.js";

export type DocumentActorContext = {
  siteId: string;
  actorId: string;
  requestId?: string;
};

export type ChangeRecordInput = {
  changeType?: PrescriptionChangeType;
  whatChanged?: string;
  reason?: string;
  communicationMethod?: PrescriptionChangeCommunicationMethod | null;
  contactedParty?: string | null;
  authorizingPrescriber?: string | null;
  note?: string | null;
};

export type AnnotationInput = {
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  change?: ChangeRecordInput;
};

const changeTypes = new Set<PrescriptionChangeType>([
  "SIG",
  "QUANTITY",
  "REFILLS",
  "DRUG",
  "STRENGTH",
  "DOSAGE_FORM",
  "DAW",
  "PRESCRIBER",
  "WRITTEN_DATE",
  "OTHER",
]);

const communicationMethods = new Set<PrescriptionChangeCommunicationMethod>([
  "PHONE",
  "FAX",
  "ELECTRONIC",
  "IN_PERSON",
  "OTHER",
]);

export const documentInclude = {
  createdBy: {
    select: { id: true, displayName: true, role: true },
  },
  annotations: {
    include: {
      createdBy: {
        select: { id: true, displayName: true, role: true },
      },
      changeRecord: {
        include: {
          changedBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
};

function trimOptional(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validateChange(input: ChangeRecordInput | undefined) {
  if (!input?.changeType || !changeTypes.has(input.changeType)) {
    throw new DocumentVaultError(
      400,
      "CHANGE_TYPE_REQUIRED",
      "Select what kind of prescription change is being documented.",
    );
  }
  const whatChanged = input.whatChanged?.trim();
  const reason = input.reason?.trim();
  if (!whatChanged) {
    throw new DocumentVaultError(
      400,
      "WHAT_CHANGED_REQUIRED",
      "Document what changed separately from the visual annotation text.",
    );
  }
  if (!reason) {
    throw new DocumentVaultError(
      400,
      "CHANGE_REASON_REQUIRED",
      "Document why the prescription change was made.",
    );
  }
  if (
    input.communicationMethod &&
    !communicationMethods.has(input.communicationMethod)
  ) {
    throw new DocumentVaultError(
      400,
      "COMMUNICATION_METHOD_INVALID",
      "Prescription change communication method is invalid.",
    );
  }
  return {
    changeType: input.changeType,
    whatChanged,
    reason,
    communicationMethod: input.communicationMethod ?? null,
    contactedParty: trimOptional(input.contactedParty),
    authorizingPrescriber: trimOptional(input.authorizingPrescriber),
    note: trimOptional(input.note),
  };
}

function validateAnnotation(input: AnnotationInput) {
  const text = input.text?.trim();
  if (!text) {
    throw new DocumentVaultError(
      400,
      "ANNOTATION_TEXT_REQUIRED",
      "Enter the text that should appear in the opaque prescription annotation.",
    );
  }
  if (text.length > 1500) {
    throw new DocumentVaultError(
      400,
      "ANNOTATION_TEXT_TOO_LONG",
      "Visual prescription annotation text must be 1,500 characters or fewer.",
    );
  }

  const values = {
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
  };
  for (const [field, value] of Object.entries(values)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new DocumentVaultError(
        400,
        "ANNOTATION_GEOMETRY_INVALID",
        `Annotation ${field} must be a finite normalized number.`,
      );
    }
  }
  const x = input.x as number;
  const y = input.y as number;
  const width = input.width as number;
  const height = input.height as number;
  if (
    x < 0 ||
    y < 0 ||
    width < 0.01 ||
    height < 0.01 ||
    x > 1 ||
    y > 1 ||
    x + width > 1.000001 ||
    y + height > 1.000001
  ) {
    throw new DocumentVaultError(
      400,
      "ANNOTATION_GEOMETRY_INVALID",
      "Annotation rectangle must remain within the prescription visual.",
    );
  }

  return {
    text,
    x: new Prisma.Decimal(x),
    y: new Prisma.Decimal(y),
    width: new Prisma.Decimal(width),
    height: new Prisma.Decimal(height),
    change: validateChange(input.change),
  };
}

async function prescriptionForSite(prescriptionId: string, siteId: string) {
  const rx = await db.prescription.findFirst({
    where: { id: prescriptionId, siteId },
    include: {
      patient: true,
      prescriber: {
        include: {
          identifiers: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
          addresses: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });
  if (!rx) {
    throw new DocumentVaultError(
      404,
      "PRESCRIPTION_NOT_FOUND",
      "Prescription not found.",
    );
  }
  return rx;
}

export async function listPrescriptionDocuments(
  prescriptionId: string,
  context: Pick<DocumentActorContext, "siteId">,
) {
  await prescriptionForSite(prescriptionId, context.siteId);
  return db.document.findMany({
    where: {
      siteId: context.siteId,
      prescriptionId,
    },
    include: documentInclude,
    orderBy: { createdAt: "asc" },
  });
}

export async function createPrescriptionSourceDocument(
  prescriptionId: string,
  input: {
    sourceType?: DocumentSourceType;
    mimeType?: string;
    originalFilename?: string | null;
    base64Data?: string;
  },
  context: DocumentActorContext,
) {
  const rx = await prescriptionForSite(prescriptionId, context.siteId);
  const sourceType = input.sourceType ?? "SCAN";
  if (sourceType !== "SCAN" && sourceType !== "UPLOAD") {
    throw new DocumentVaultError(
      400,
      "DOCUMENT_SOURCE_INVALID",
      "Uploaded prescription originals must use SCAN or UPLOAD source type.",
    );
  }
  const mimeType = input.mimeType?.trim().toLowerCase();
  if (!mimeType) {
    throw new DocumentVaultError(
      400,
      "DOCUMENT_MIME_TYPE_REQUIRED",
      "Document MIME type is required.",
    );
  }
  assertSupportedUploadedMimeType(mimeType);
  const bytes = decodeDocumentBase64(input.base64Data ?? "");
  return withDocumentVaultWriteLease(async () => {
    const stored = await storeImmutableDocument({
      siteId: context.siteId,
      bytes,
    });

    try {
      return await db.$transaction(async (tx) => {
        const document = await tx.document.create({
          data: {
            id: stored.documentId,
            siteId: context.siteId,
            patientId: rx.patientId,
            prescriptionId: rx.id,
            kind: "PRESCRIPTION_SOURCE",
            sourceType,
            mimeType,
            originalFilename: trimOptional(input.originalFilename),
            storageKey: stored.storageKey,
            sha256: stored.sha256,
            byteSize: stored.byteSize,
            encrypted: stored.encrypted,
            immutable: true,
            createdById: context.actorId,
          },
          include: documentInclude,
        });

        await writeAuditEvent(tx, {
          siteId: context.siteId,
          actorId: context.actorId,
          action: "PRESCRIPTION_DOCUMENT_STORED",
          entityType: "Document",
          entityId: document.id,
          requestId: context.requestId,
          metadata: {
            prescriptionId: rx.id,
            patientId: rx.patientId,
            sourceType,
            mimeType,
            byteSize: stored.byteSize,
            sha256: stored.sha256,
            encrypted: stored.encrypted,
            immutable: true,
          },
        });

        return document;
      });
    } catch (error) {
      await removeStoredDocument(stored.storageKey);
      throw error;
    }
  });
}

export async function createElectronicPrescriptionRender(
  prescriptionId: string,
  context: DocumentActorContext,
) {
  const rx = await prescriptionForSite(prescriptionId, context.siteId);
  if (rx.sourceType !== "ELECTRONIC") {
    throw new DocumentVaultError(
      409,
      "PRESCRIPTION_NOT_ELECTRONIC",
      "Only an electronic prescription can create an electronic visual source.",
    );
  }

  const existing = await db.document.findFirst({
    where: {
      siteId: context.siteId,
      prescriptionId,
      sourceType: "ELECTRONIC_RENDER",
      kind: "PRESCRIPTION_SOURCE",
    },
    include: documentInclude,
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  const bytes = renderElectronicPrescriptionSvg(rx);
  return withDocumentVaultWriteLease(async () => {
    const recheck = await db.document.findFirst({
      where: {
        siteId: context.siteId,
        prescriptionId,
        sourceType: "ELECTRONIC_RENDER",
        kind: "PRESCRIPTION_SOURCE",
      },
      include: documentInclude,
      orderBy: { createdAt: "asc" },
    });
    if (recheck) return recheck;

    const stored = await storeImmutableDocument({
      siteId: context.siteId,
      bytes,
    });

    try {
      return await db.$transaction(async (tx) => {
        const document = await tx.document.create({
          data: {
            id: stored.documentId,
            siteId: context.siteId,
            patientId: rx.patientId,
            prescriptionId: rx.id,
            kind: "PRESCRIPTION_SOURCE",
            sourceType: "ELECTRONIC_RENDER",
            mimeType: "image/svg+xml",
            originalFilename: rx.rxNumber
              ? `eRx-${rx.rxNumber}.svg`
              : `eRx-${rx.id}.svg`,
            storageKey: stored.storageKey,
            sha256: stored.sha256,
            byteSize: stored.byteSize,
            encrypted: stored.encrypted,
            immutable: true,
            createdById: context.actorId,
          },
          include: documentInclude,
        });

        await writeAuditEvent(tx, {
          siteId: context.siteId,
          actorId: context.actorId,
          action: "ELECTRONIC_PRESCRIPTION_RENDERED",
          entityType: "Document",
          entityId: document.id,
          requestId: context.requestId,
          metadata: {
            prescriptionId: rx.id,
            electronicMessageId: rx.electronicMessageId,
            sha256: stored.sha256,
            immutable: true,
          },
        });
        return document;
      });
    } catch (error) {
      await removeStoredDocument(stored.storageKey);
      throw error;
    }
  });
}

export async function documentForRead(
  documentId: string,
  context: Pick<DocumentActorContext, "siteId">,
) {
  const document = await db.document.findFirst({
    where: { id: documentId, siteId: context.siteId },
  });
  if (!document) {
    throw new DocumentVaultError(
      404,
      "DOCUMENT_NOT_FOUND",
      "Document not found.",
    );
  }
  return document;
}

export async function createPrescriptionAnnotation(
  documentId: string,
  input: AnnotationInput,
  context: DocumentActorContext,
) {
  const parsed = validateAnnotation(input);
  const document = await db.document.findFirst({
    where: {
      id: documentId,
      siteId: context.siteId,
      prescriptionId: { not: null },
    },
  });
  if (!document?.prescriptionId) {
    throw new DocumentVaultError(
      404,
      "PRESCRIPTION_DOCUMENT_NOT_FOUND",
      "Prescription document not found.",
    );
  }

  return db.$transaction(async (tx) => {
    const annotation = await tx.prescriptionAnnotation.create({
      data: {
        siteId: context.siteId,
        prescriptionId: document.prescriptionId!,
        documentId: document.id,
        text: parsed.text,
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height,
        backgroundOpacity: new Prisma.Decimal(1),
        status: "ACTIVE",
        createdById: context.actorId,
      },
    });

    const changeRecord = await tx.prescriptionChangeRecord.create({
      data: {
        siteId: context.siteId,
        prescriptionId: document.prescriptionId!,
        annotationId: annotation.id,
        ...parsed.change,
        status: "ACTIVE",
        changedById: context.actorId,
      },
      include: {
        changedBy: {
          select: { id: true, displayName: true, role: true },
        },
      },
    });

    await writeAuditEvent(tx, {
      siteId: context.siteId,
      actorId: context.actorId,
      action: "PRESCRIPTION_VISUAL_ANNOTATION_CREATED",
      entityType: "PrescriptionAnnotation",
      entityId: annotation.id,
      requestId: context.requestId,
      metadata: {
        prescriptionId: document.prescriptionId,
        documentId: document.id,
        changeRecordId: changeRecord.id,
        changeType: changeRecord.changeType,
        whatChanged: changeRecord.whatChanged,
        reason: changeRecord.reason,
        communicationMethod: changeRecord.communicationMethod,
        contactedParty: changeRecord.contactedParty,
        authorizingPrescriber: changeRecord.authorizingPrescriber,
      },
    });

    return tx.prescriptionAnnotation.findUniqueOrThrow({
      where: { id: annotation.id },
      include: {
        createdBy: {
          select: { id: true, displayName: true, role: true },
        },
        changeRecord: {
          include: {
            changedBy: {
              select: { id: true, displayName: true, role: true },
            },
          },
        },
      },
    });
  });
}

export async function supersedePrescriptionAnnotation(
  annotationId: string,
  input: AnnotationInput,
  context: DocumentActorContext,
) {
  const parsed = validateAnnotation(input);
  return db.$transaction(async (tx) => {
    const prior = await tx.prescriptionAnnotation.findFirst({
      where: {
        id: annotationId,
        siteId: context.siteId,
        status: "ACTIVE",
      },
      include: { changeRecord: true },
    });
    if (!prior?.changeRecord) {
      throw new DocumentVaultError(
        404,
        "ACTIVE_ANNOTATION_NOT_FOUND",
        "Active prescription annotation not found.",
      );
    }

    await tx.prescriptionAnnotation.update({
      where: { id: prior.id },
      data: { status: "SUPERSEDED" },
    });
    await tx.prescriptionChangeRecord.update({
      where: { id: prior.changeRecord.id },
      data: { status: "SUPERSEDED" },
    });

    const replacement = await tx.prescriptionAnnotation.create({
      data: {
        siteId: context.siteId,
        prescriptionId: prior.prescriptionId,
        documentId: prior.documentId,
        text: parsed.text,
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height,
        backgroundOpacity: new Prisma.Decimal(1),
        status: "ACTIVE",
        createdById: context.actorId,
        supersedesAnnotationId: prior.id,
      },
    });

    const changeRecord = await tx.prescriptionChangeRecord.create({
      data: {
        siteId: context.siteId,
        prescriptionId: prior.prescriptionId,
        annotationId: replacement.id,
        ...parsed.change,
        status: "ACTIVE",
        changedById: context.actorId,
        supersedesChangeRecordId: prior.changeRecord.id,
      },
    });

    await writeAuditEvent(tx, {
      siteId: context.siteId,
      actorId: context.actorId,
      action: "PRESCRIPTION_VISUAL_ANNOTATION_SUPERSEDED",
      entityType: "PrescriptionAnnotation",
      entityId: replacement.id,
      requestId: context.requestId,
      metadata: {
        prescriptionId: prior.prescriptionId,
        documentId: prior.documentId,
        priorAnnotationId: prior.id,
        priorChangeRecordId: prior.changeRecord.id,
        replacementChangeRecordId: changeRecord.id,
      },
    });

    return tx.prescriptionAnnotation.findUniqueOrThrow({
      where: { id: replacement.id },
      include: {
        createdBy: {
          select: { id: true, displayName: true, role: true },
        },
        changeRecord: {
          include: {
            changedBy: {
              select: { id: true, displayName: true, role: true },
            },
          },
        },
      },
    });
  });
}
