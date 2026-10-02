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
  structuredValue?: unknown;
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
    requiresStructuredApply: input.changeType !== "OTHER",
    afterValue:
      input.structuredValue === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(input.structuredValue)) as Prisma.InputJsonValue),
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


function structuredChangeValue(value: unknown): Prisma.InputJsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function applyPrescriptionChangeRecord(
  changeRecordId: string,
  structuredValue: unknown,
  context: DocumentActorContext,
) {
  return db.$transaction(async (tx) => {
    const record = await tx.prescriptionChangeRecord.findFirst({
      where: {
        id: changeRecordId,
        siteId: context.siteId,
        status: "ACTIVE",
      },
      include: {
        prescription: {
          include: {
            fills: {
              where: { status: { in: ["SCHEDULED", "IN_PROGRESS", "READY"] } },
              select: { id: true, status: true },
            },
          },
        },
      },
    });
    if (!record) {
      throw new DocumentVaultError(
        404,
        "PRESCRIPTION_CHANGE_NOT_FOUND",
        "Active prescription change record not found.",
      );
    }
    if (!record.requiresStructuredApply) {
      throw new DocumentVaultError(
        409,
        "PRESCRIPTION_CHANGE_NO_STRUCTURED_APPLY",
        "This documentation-only change does not map to a structured prescription field.",
      );
    }
    if (record.appliedAt) {
      throw new DocumentVaultError(
        409,
        "PRESCRIPTION_CHANGE_ALREADY_APPLIED",
        "This documented prescription change has already been applied to structured prescription data.",
      );
    }
    if (record.prescription.fills.length > 0) {
      throw new DocumentVaultError(
        409,
        "PRESCRIPTION_CHANGE_REQUIRES_FILL_RESET",
        "Resolve or cancel the active/scheduled fill before applying a documented prescription change.",
        {
          fillIds: record.prescription.fills.map((fill) => fill.id),
        },
      );
    }

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Prescription" WHERE "id" = ${record.prescriptionId} FOR UPDATE`,
    );
    const rx = await tx.prescription.findUniqueOrThrow({
      where: { id: record.prescriptionId },
    });

    if (!["RECEIVED", "DATA_ENTRY", "DUR_REVIEW", "ON_HOLD"].includes(rx.status)) {
      throw new DocumentVaultError(
        409,
        "PRESCRIPTION_CHANGE_STATE_BLOCKED",
        "Structured prescription changes must be applied before Product Fill begins.",
        { status: rx.status },
      );
    }

    let appliedField: string;
    let beforeValue: unknown;
    const data: Prisma.PrescriptionUpdateInput = {
      version: { increment: 1 },
    };

    switch (record.changeType) {
      case "SIG": {
        const value = typeof structuredValue === "string" ? structuredValue.trim() : "";
        if (!value) {
          throw new DocumentVaultError(400, "STRUCTURED_SIG_REQUIRED", "A nonblank SIG is required.");
        }
        appliedField = "sig";
        beforeValue = rx.sig;
        data.sig = value;
        break;
      }
      case "QUANTITY": {
        const value = Number(structuredValue);
        if (!Number.isFinite(value) || value <= 0) {
          throw new DocumentVaultError(400, "STRUCTURED_QUANTITY_INVALID", "Quantity must be greater than zero.");
        }
        appliedField = "quantityWritten";
        beforeValue = rx.quantityWritten?.toString() ?? null;
        data.quantityWritten = value;
        break;
      }
      case "REFILLS": {
        const value = Number(structuredValue);
        if (!Number.isInteger(value) || value < rx.refillsUsed) {
          throw new DocumentVaultError(
            400,
            "STRUCTURED_REFILLS_INVALID",
            "Refills must be a whole number not less than fills already used.",
          );
        }
        appliedField = "refillsAllowed";
        beforeValue = rx.refillsAllowed;
        data.refillsAllowed = value;
        break;
      }
      case "STRENGTH": {
        const value = typeof structuredValue === "string" ? structuredValue.trim() : "";
        if (!value) throw new DocumentVaultError(400, "STRUCTURED_STRENGTH_REQUIRED", "Strength is required.");
        appliedField = "strength";
        beforeValue = rx.strength;
        data.strength = value;
        break;
      }
      case "DOSAGE_FORM": {
        const value = typeof structuredValue === "string" ? structuredValue.trim() : "";
        if (!value) throw new DocumentVaultError(400, "STRUCTURED_DOSAGE_FORM_REQUIRED", "Dosage form is required.");
        appliedField = "dosageForm";
        beforeValue = rx.dosageForm;
        data.dosageForm = value;
        break;
      }
      case "DAW": {
        if (
          structuredValue !== "UNSPECIFIED" &&
          structuredValue !== "SELECTION_PERMITTED" &&
          structuredValue !== "DISPENSE_AS_WRITTEN"
        ) {
          throw new DocumentVaultError(400, "STRUCTURED_DAW_INVALID", "Invalid product-selection directive.");
        }
        appliedField = "productSelectionDirective";
        beforeValue = rx.productSelectionDirective;
        data.productSelectionDirective = structuredValue;
        if (structuredValue === "DISPENSE_AS_WRITTEN" && !rx.prescribedProductId) {
          throw new DocumentVaultError(
            409,
            "DAW_PRESCRIBED_PRODUCT_REQUIRED",
            "A prescribed product/NDC must be identified before applying Dispense As Written.",
          );
        }
        break;
      }
      case "WRITTEN_DATE": {
        if (typeof structuredValue !== "string") {
          throw new DocumentVaultError(400, "STRUCTURED_WRITTEN_DATE_INVALID", "Written date must be an ISO date string.");
        }
        const value = new Date(structuredValue);
        if (Number.isNaN(value.getTime())) {
          throw new DocumentVaultError(400, "STRUCTURED_WRITTEN_DATE_INVALID", "Written date is invalid.");
        }
        appliedField = "writtenDate";
        beforeValue = rx.writtenDate?.toISOString() ?? null;
        data.writtenDate = value;
        break;
      }
      case "DRUG": {
        const medicationId = typeof structuredValue === "string" ? structuredValue.trim() : "";
        const medication = medicationId
          ? await tx.medication.findFirst({
              where: { id: medicationId, active: true },
            })
          : null;
        if (!medication) {
          throw new DocumentVaultError(400, "STRUCTURED_DRUG_INVALID", "Select an active Drug catalog entry.");
        }
        appliedField = "medicationId";
        beforeValue = rx.medicationId;
        data.medication = { connect: { id: medication.id } };
        data.medicationName = medication.genericName;
        data.strength = medication.strength;
        data.dosageForm = medication.dosageForm;
        if (rx.prescribedProductId) {
          const prescribed = await tx.product.findUnique({
            where: { id: rx.prescribedProductId },
            select: { medicationId: true },
          });
          if (!prescribed || prescribed.medicationId !== medication.id) {
            data.prescribedProduct = { disconnect: true };
            data.productSelectionDirective = "UNSPECIFIED";
          }
        }
        break;
      }
      case "PRESCRIBER": {
        const prescriberId = typeof structuredValue === "string" ? structuredValue.trim() : "";
        const prescriber = prescriberId
          ? await tx.prescriber.findFirst({
              where: { id: prescriberId, siteId: context.siteId },
              select: { id: true },
            })
          : null;
        if (!prescriber) {
          throw new DocumentVaultError(400, "STRUCTURED_PRESCRIBER_INVALID", "Select a prescriber at this pharmacy site.");
        }
        appliedField = "prescriberId";
        beforeValue = rx.prescriberId;
        data.prescriber = { connect: { id: prescriber.id } };
        break;
      }
      default:
        throw new DocumentVaultError(
          409,
          "STRUCTURED_CHANGE_UNSUPPORTED",
          "This change type cannot be applied automatically to structured prescription data.",
          { changeType: record.changeType },
        );
    }

    if (rx.status === "DUR_REVIEW") {
      data.status = "DATA_ENTRY";
    } else if (rx.status === "ON_HOLD" && rx.heldFromStatus === "DUR_REVIEW") {
      data.heldFromStatus = "DATA_ENTRY";
    }

    const updated = await tx.prescription.update({
      where: { id: rx.id },
      data,
    });

    const effectiveAfterValue =
      appliedField === "quantityWritten"
        ? updated.quantityWritten?.toString() ?? null
        : appliedField === "writtenDate"
          ? updated.writtenDate?.toISOString() ?? null
          : (updated as unknown as Record<string, unknown>)[appliedField] ?? structuredValue;

    const applied = await tx.prescriptionChangeRecord.update({
      where: { id: record.id },
      data: {
        appliedField,
        beforeValue: structuredChangeValue(beforeValue),
        afterValue: structuredChangeValue(effectiveAfterValue),
        appliedAt: new Date(),
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
      action: "PRESCRIPTION_DOCUMENTED_CHANGE_APPLIED",
      entityType: "PrescriptionChangeRecord",
      entityId: record.id,
      requestId: context.requestId,
      metadata: {
        prescriptionId: rx.id,
        changeType: record.changeType,
        appliedField,
        beforeValue: structuredChangeValue(beforeValue),
        afterValue: structuredChangeValue(effectiveAfterValue),
        workflowResetTo:
          rx.status === "DUR_REVIEW" ||
          (rx.status === "ON_HOLD" && rx.heldFromStatus === "DUR_REVIEW")
            ? "DATA_ENTRY"
            : null,
      },
    });

    return { changeRecord: applied, prescription: updated };
  });
}
