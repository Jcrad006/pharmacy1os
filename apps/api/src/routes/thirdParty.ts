import type {
  BillingNdcStrategy,
  ClaimStandard,
  CoverageRelationship,
} from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import {
  AccessError,
  resolveDevelopmentActor,
} from "../security/devIdentity.js";
import {
  adjudicateFillClaims,
  assertNoActivePaidClaimsForPatientCoverageMutation,
  ClaimError,
  markLabelPrintJobPrinted,
  reverseClaimTransaction,
} from "../claims/service.js";

const claimStandards = new Set<ClaimStandard>(["D0", "F6"]);
const billingStrategies = new Set<BillingNdcStrategy>([
  "MAJORITY_SOURCE",
  "REQUIRE_MANUAL_SELECTION",
  "SINGLE_SOURCE_ONLY",
  "PAYER_CONFIGURED",
]);
const relationships = new Set<CoverageRelationship>([
  "SELF",
  "SPOUSE",
  "CHILD",
  "OTHER",
]);

function parseOptionalDate(value?: string | null) {
  if (value === null || value === undefined || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

export async function thirdPartyRoutes(app: FastifyInstance) {
  app.get("/third-party/payers", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:read");
      const payers = await db.payer.findMany({
        where: { siteId: actor.siteId },
        orderBy: [{ active: "desc" }, { name: "asc" }],
      });
      return { payers };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/third-party/payers", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:write");
      const body = (request.body ?? {}) as {
        name?: string;
        bin?: string;
        pcn?: string;
        defaultGroupId?: string;
        claimStandard?: ClaimStandard;
        billingNdcStrategy?: BillingNdcStrategy;
      };
      const name = body.name?.trim();
      if (!name) {
        return reply.code(400).send({ error: "Payer name is required." });
      }
      if (body.claimStandard && !claimStandards.has(body.claimStandard)) {
        return reply.code(400).send({ error: "Invalid claim standard." });
      }
      if (
        body.billingNdcStrategy &&
        !billingStrategies.has(body.billingNdcStrategy)
      ) {
        return reply.code(400).send({ error: "Invalid billing NDC strategy." });
      }

      const payer = await db.$transaction(async (tx) => {
        const created = await tx.payer.create({
          data: {
            siteId: actor.siteId,
            name,
            bin: body.bin?.trim() || null,
            pcn: body.pcn?.trim() || null,
            defaultGroupId: body.defaultGroupId?.trim() || null,
            claimStandard: body.claimStandard ?? "D0",
            billingNdcStrategy:
              body.billingNdcStrategy ?? "MAJORITY_SOURCE",
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PAYER_CREATED",
          entityType: "Payer",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            name: created.name,
            bin: created.bin,
            pcn: created.pcn,
            claimStandard: created.claimStandard,
            billingNdcStrategy: created.billingNdcStrategy,
          },
        });
        return created;
      });

      return reply.code(201).send({ payer });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch("/third-party/payers/:id", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:override");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as {
        name?: string;
        bin?: string | null;
        pcn?: string | null;
        defaultGroupId?: string | null;
        claimStandard?: ClaimStandard;
        billingNdcStrategy?: BillingNdcStrategy;
        active?: boolean;
      };
      if (body.claimStandard && !claimStandards.has(body.claimStandard)) {
        return reply.code(400).send({ error: "Invalid claim standard." });
      }
      if (
        body.billingNdcStrategy &&
        !billingStrategies.has(body.billingNdcStrategy)
      ) {
        return reply.code(400).send({ error: "Invalid billing NDC strategy." });
      }

      const existing = await db.payer.findFirst({
        where: { id, siteId: actor.siteId },
      });
      if (!existing) {
        return reply.code(404).send({ error: "Payer not found." });
      }

      const payer = await db.$transaction(async (tx) => {
        const updated = await tx.payer.update({
          where: { id },
          data: {
            name: body.name?.trim() || undefined,
            bin:
              body.bin === undefined ? undefined : body.bin?.trim() || null,
            pcn:
              body.pcn === undefined ? undefined : body.pcn?.trim() || null,
            defaultGroupId:
              body.defaultGroupId === undefined
                ? undefined
                : body.defaultGroupId?.trim() || null,
            claimStandard: body.claimStandard,
            billingNdcStrategy: body.billingNdcStrategy,
            active: body.active,
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PAYER_UPDATED",
          entityType: "Payer",
          entityId: id,
          requestId: request.id,
          metadata: {
            before: existing,
            after: updated,
          },
        });
        return updated;
      });
      return { payer };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/patients/:id/coverages", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:read");
      const patientId = (request.params as { id: string }).id;
      const patient = await db.patient.findFirst({
        where: { id: patientId, siteId: actor.siteId },
        select: { id: true },
      });
      if (!patient) {
        return reply.code(404).send({ error: "Patient not found." });
      }

      const coverages = await db.patientCoverage.findMany({
        where: { patientId, siteId: actor.siteId },
        include: { payer: true },
        orderBy: { position: "asc" },
      });
      return { coverages };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.put("/patients/:id/coverages/:position", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:write");
      const params = request.params as { id: string; position: string };
      const position = Number.parseInt(params.position, 10);
      if (!Number.isInteger(position) || position < 1 || position > 4) {
        return reply.code(400).send({
          error: "Coverage position must be between 1 and 4.",
        });
      }

      const body = (request.body ?? {}) as {
        payerId?: string;
        memberId?: string;
        personCode?: string | null;
        groupId?: string | null;
        relationship?: CoverageRelationship;
        cardholderName?: string | null;
        cardholderDateOfBirth?: string | null;
        effectiveDate?: string | null;
        terminationDate?: string | null;
        active?: boolean;
      };
      const memberId = body.memberId?.trim();
      if (!body.payerId || !memberId) {
        return reply.code(400).send({
          error: "payerId and memberId are required.",
        });
      }
      if (body.relationship && !relationships.has(body.relationship)) {
        return reply.code(400).send({ error: "Invalid coverage relationship." });
      }

      const cardholderDateOfBirth = parseOptionalDate(
        body.cardholderDateOfBirth,
      );
      const effectiveDate = parseOptionalDate(body.effectiveDate);
      const terminationDate = parseOptionalDate(body.terminationDate);
      if (
        cardholderDateOfBirth === "invalid" ||
        effectiveDate === "invalid" ||
        terminationDate === "invalid"
      ) {
        return reply.code(400).send({ error: "Invalid coverage date." });
      }
      if (
        effectiveDate &&
        terminationDate &&
        terminationDate.getTime() < effectiveDate.getTime()
      ) {
        return reply.code(400).send({
          error: "Coverage termination date cannot precede effective date.",
        });
      }

      const [patient, payer] = await Promise.all([
        db.patient.findFirst({
          where: { id: params.id, siteId: actor.siteId },
        }),
        db.payer.findFirst({
          where: { id: body.payerId, siteId: actor.siteId, active: true },
        }),
      ]);
      if (!patient) {
        return reply.code(404).send({ error: "Patient not found." });
      }
      if (!payer) {
        return reply.code(404).send({ error: "Active payer not found." });
      }

      await assertNoActivePaidClaimsForPatientCoverageMutation(
        patient.id,
        actor.siteId,
      );

      const coverage = await db.$transaction(async (tx) => {
        const existing = await tx.patientCoverage.findUnique({
          where: {
            patientId_position: {
              patientId: patient.id,
              position,
            },
          },
          include: { payer: true },
        });

        const saved = await tx.patientCoverage.upsert({
          where: {
            patientId_position: {
              patientId: patient.id,
              position,
            },
          },
          update: {
            siteId: actor.siteId,
            payerId: payer.id,
            memberId,
            personCode: body.personCode?.trim() || null,
            groupId: body.groupId?.trim() || payer.defaultGroupId || null,
            relationship: body.relationship ?? "SELF",
            cardholderName: body.cardholderName?.trim() || null,
            cardholderDateOfBirth,
            effectiveDate,
            terminationDate,
            active: body.active ?? true,
          },
          create: {
            siteId: actor.siteId,
            patientId: patient.id,
            payerId: payer.id,
            position,
            memberId,
            personCode: body.personCode?.trim() || null,
            groupId: body.groupId?.trim() || payer.defaultGroupId || null,
            relationship: body.relationship ?? "SELF",
            cardholderName: body.cardholderName?.trim() || null,
            cardholderDateOfBirth,
            effectiveDate,
            terminationDate,
            active: body.active ?? true,
          },
          include: { payer: true },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PATIENT_COVERAGE_UPSERTED",
          entityType: "PatientCoverage",
          entityId: saved.id,
          requestId: request.id,
          metadata: {
            patientId: patient.id,
            position,
            previousPayerId: existing?.payerId ?? null,
            payerId: payer.id,
            payerName: payer.name,
            memberIdChanged: existing
              ? existing.memberId !== memberId
              : true,
            active: saved.active,
          },
        });
        return saved;
      });

      return { coverage };
    } catch (error) {
      if (error instanceof AccessError || error instanceof ClaimError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof ClaimError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });

  app.delete("/patients/:id/coverages/:position", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:write");
      const params = request.params as { id: string; position: string };
      const position = Number.parseInt(params.position, 10);
      if (!Number.isInteger(position) || position < 1 || position > 4) {
        return reply.code(400).send({
          error: "Coverage position must be between 1 and 4.",
        });
      }

      const coverage = await db.patientCoverage.findUnique({
        where: {
          patientId_position: {
            patientId: params.id,
            position,
          },
        },
        include: { patient: true, payer: true },
      });
      if (!coverage || coverage.siteId !== actor.siteId) {
        return reply.code(404).send({ error: "Coverage not found." });
      }

      await assertNoActivePaidClaimsForPatientCoverageMutation(
        coverage.patientId,
        actor.siteId,
      );

      await db.$transaction(async (tx) => {
        await tx.patientCoverage.delete({ where: { id: coverage.id } });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PATIENT_COVERAGE_REMOVED",
          entityType: "PatientCoverage",
          entityId: coverage.id,
          requestId: request.id,
          metadata: {
            patientId: params.id,
            position,
            payerId: coverage.payerId,
            payerName: coverage.payer.name,
          },
        });
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof AccessError || error instanceof ClaimError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof ClaimError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });

  app.get("/third-party/workspace", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:read");
      const query = request.query as { query?: string };
      const search = query.query?.trim();
      const patients = await db.patient.findMany({
        where: {
          siteId: actor.siteId,
          ...(search
            ? {
                OR: [
                  { firstName: { contains: search, mode: "insensitive" } },
                  { lastName: { contains: search, mode: "insensitive" } },
                  { phone: { contains: search } },
                ],
              }
            : {}),
        },
        include: {
          coverages: {
            include: { payer: true },
            orderBy: { position: "asc" },
          },
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        take: 100,
      });

      const payers = await db.payer.findMany({
        where: { siteId: actor.siteId, active: true },
        orderBy: { name: "asc" },
      });

      const recentClaims = await db.claimTransaction.findMany({
        where: { siteId: actor.siteId },
        include: {
          payer: true,
          fill: {
            include: {
              prescription: { include: { patient: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 300,
      });
      const reversedIds = new Set(
        recentClaims
          .filter(
            (claim) =>
              claim.operation === "REVERSAL" &&
              claim.outcome === "REVERSED" &&
              claim.originalTransactionId,
          )
          .map((claim) => claim.originalTransactionId as string),
      );
      const latestByCoverage = new Map<string, (typeof recentClaims)[number]>();
      for (const claim of recentClaims) {
        if (
          claim.operation !== "SUBMIT" ||
          reversedIds.has(claim.id)
        ) {
          continue;
        }
        const key = `${claim.fillId}:${claim.coveragePosition}`;
        if (!latestByCoverage.has(key)) {
          latestByCoverage.set(key, claim);
        }
      }
      const claimIssues = Array.from(latestByCoverage.values())
        .filter(
          (claim) =>
            claim.outcome === "REJECTED" || claim.outcome === "ERROR",
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const printQueue = await db.labelPrintJob.findMany({
        where: { siteId: actor.siteId, status: "QUEUED" },
        include: {
          label: {
            include: {
              fill: {
                include: {
                  prescription: { include: { patient: true } },
                },
              },
            },
          },
        },
        orderBy: { queuedAt: "asc" },
        take: 100,
      });

      return {
        patients,
        payers,
        claimIssues,
        printQueue,
        maxCoveragePositions: 4,
      };
    } catch (error) {
      if (error instanceof AccessError || error instanceof ClaimError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof ClaimError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });

  app.get("/fills/:id/claims", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:read");
      const fillId = (request.params as { id: string }).id;
      const fill = await db.prescriptionFill.findFirst({
        where: { id: fillId, prescription: { siteId: actor.siteId } },
        select: { id: true },
      });
      if (!fill) {
        return reply.code(404).send({ error: "Fill not found." });
      }

      const transactions = await db.claimTransaction.findMany({
        where: { fillId, siteId: actor.siteId },
        include: {
          payer: true,
          createdBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
        orderBy: [
          { coveragePosition: "asc" },
          { createdAt: "asc" },
        ],
      });
      const labels = await db.prescriptionLabel.findMany({
        where: { fillId, siteId: actor.siteId },
        include: { printJobs: { orderBy: { queuedAt: "asc" } } },
        orderBy: { version: "asc" },
      });
      return { transactions, labels };
    } catch (error) {
      if (error instanceof AccessError || error instanceof ClaimError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof ClaimError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });

  app.post("/fills/:id/adjudicate", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:write");
      const fillId = (request.params as { id: string }).id;
      const result = await adjudicateFillClaims(fillId, {
        siteId: actor.siteId,
        actorId: actor.id,
        requestId: request.id,
        retryRejected: true,
      });
      return { adjudication: result };
    } catch (error) {
      if (error instanceof AccessError || error instanceof ClaimError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof ClaimError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });

  app.post("/third-party/claims/:id/reverse", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:override");
      const claimId = (request.params as { id: string }).id;
      const result = await reverseClaimTransaction(claimId, {
        siteId: actor.siteId,
        actorId: actor.id,
        requestId: request.id,
      });
      return result;
    } catch (error) {
      if (error instanceof AccessError || error instanceof ClaimError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof ClaimError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });

  app.post("/third-party/print-jobs/:id/printed", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const printJobId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as { printerName?: string | null };
      const printJob = await markLabelPrintJobPrinted(
        printJobId,
        {
          siteId: actor.siteId,
          actorId: actor.id,
          requestId: request.id,
        },
        body.printerName,
      );
      return { printJob };
    } catch (error) {
      if (error instanceof AccessError || error instanceof ClaimError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof ClaimError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });
}
