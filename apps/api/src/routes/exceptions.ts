import type { DurSeverity } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type ExceptionKind =
  | "CLINICAL_ISSUE"
  | "ON_HOLD"
  | "PHARMACIST_REVIEW"
  | "SCHEDULED_FILL";

type ExceptionItem = {
  id: string;
  kind: ExceptionKind;
  prescriptionId: string;
  rxNumber: string | null;
  patientName: string;
  medicationName: string;
  title: string;
  detail: string | null;
  severity: "INFO" | "WARNING" | "HIGH";
  dueAt: string | null;
  createdAt: string;
};

function severityRank(severity: ExceptionItem["severity"]) {
  return severity === "HIGH" ? 3 : severity === "WARNING" ? 2 : 1;
}

function normalizeDurSeverity(severity: DurSeverity): ExceptionItem["severity"] {
  return severity;
}

export async function exceptionRoutes(app: FastifyInstance) {
  app.get("/exceptions", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const query = request.query as {
        kind?: ExceptionKind;
        query?: string;
        limit?: string;
      };
      const search = String(query.query ?? "").trim().toLowerCase();
      const kinds = new Set<ExceptionKind>([
        "CLINICAL_ISSUE",
        "ON_HOLD",
        "PHARMACIST_REVIEW",
        "SCHEDULED_FILL",
      ]);

      if (query.kind && !kinds.has(query.kind)) {
        return reply.code(400).send({ error: "Invalid exception kind." });
      }

      const parsedLimit = Number.parseInt(String(query.limit ?? "200"), 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(300, Math.max(1, parsedLimit))
        : 200;

      const [openIssues, held, pharmacistReview, scheduledFills] =
        await Promise.all([
          db.durIssue.findMany({
            where: {
              status: "OPEN",
              prescription: { siteId: actor.siteId },
            },
            include: {
              prescription: {
                include: { patient: true },
              },
            },
            orderBy: { createdAt: "asc" },
            take: limit,
          }),
          db.prescription.findMany({
            where: { siteId: actor.siteId, status: "ON_HOLD" },
            include: { patient: true },
            orderBy: { updatedAt: "asc" },
            take: limit,
          }),
          db.prescription.findMany({
            where: { siteId: actor.siteId, status: "PHARMACIST_REVIEW" },
            include: { patient: true },
            orderBy: { updatedAt: "asc" },
            take: limit,
          }),
          db.prescriptionFill.findMany({
            where: {
              status: "SCHEDULED",
              prescription: { siteId: actor.siteId },
            },
            include: {
              prescription: {
                include: { patient: true },
              },
            },
            orderBy: { scheduledFor: "asc" },
            take: limit,
          }),
        ]);

      const items: ExceptionItem[] = [
        ...openIssues.map((issue) => ({
          id: `dur:${issue.id}`,
          kind: "CLINICAL_ISSUE" as const,
          prescriptionId: issue.prescriptionId,
          rxNumber: issue.prescription.rxNumber,
          patientName: `${issue.prescription.patient.lastName}, ${issue.prescription.patient.firstName}`,
          medicationName: issue.prescription.medicationName,
          title: issue.title,
          detail: issue.description,
          severity: normalizeDurSeverity(issue.severity),
          dueAt: null,
          createdAt: issue.createdAt.toISOString(),
        })),
        ...held.map((rx) => ({
          id: `hold:${rx.id}`,
          kind: "ON_HOLD" as const,
          prescriptionId: rx.id,
          rxNumber: rx.rxNumber,
          patientName: `${rx.patient.lastName}, ${rx.patient.firstName}`,
          medicationName: rx.medicationName,
          title: "Prescription on hold",
          detail: rx.heldFromStatus
            ? `Held from ${rx.heldFromStatus.replaceAll("_", " ")}`
            : null,
          severity: "WARNING" as const,
          dueAt: null,
          createdAt: rx.updatedAt.toISOString(),
        })),
        ...pharmacistReview.map((rx) => ({
          id: `review:${rx.id}`,
          kind: "PHARMACIST_REVIEW" as const,
          prescriptionId: rx.id,
          rxNumber: rx.rxNumber,
          patientName: `${rx.patient.lastName}, ${rx.patient.firstName}`,
          medicationName: rx.medicationName,
          title: "Pharmacist verification required",
          detail: "Prescription is waiting for final pharmacist review.",
          severity: "WARNING" as const,
          dueAt: null,
          createdAt: rx.updatedAt.toISOString(),
        })),
        ...scheduledFills.map((fill) => ({
          id: `scheduled:${fill.id}`,
          kind: "SCHEDULED_FILL" as const,
          prescriptionId: fill.prescriptionId,
          rxNumber: fill.prescription.rxNumber,
          patientName: `${fill.prescription.patient.lastName}, ${fill.prescription.patient.firstName}`,
          medicationName: fill.prescription.medicationName,
          title: `Scheduled fill #${fill.fillNumber}`,
          detail: fill.scheduledFor
            ? `Scheduled for ${fill.scheduledFor.toISOString()}`
            : "Scheduled fill",
          severity: "INFO" as const,
          dueAt: fill.scheduledFor?.toISOString() ?? null,
          createdAt: fill.createdAt.toISOString(),
        })),
      ];

      const filtered = items
        .filter((item) => !query.kind || item.kind === query.kind)
        .filter((item) => {
          if (!search) return true;
          return [
            item.rxNumber ?? "",
            item.patientName,
            item.medicationName,
            item.title,
            item.detail ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(search);
        })
        .sort((a, b) => {
          const severity = severityRank(b.severity) - severityRank(a.severity);
          if (severity !== 0) return severity;

          const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
          const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
          if (aDue !== bDue) return aDue - bDue;

          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        })
        .slice(0, limit);

      return {
        exceptions: filtered,
        summary: {
          total: filtered.length,
          clinical: filtered.filter((item) => item.kind === "CLINICAL_ISSUE").length,
          onHold: filtered.filter((item) => item.kind === "ON_HOLD").length,
          pharmacistReview: filtered.filter(
            (item) => item.kind === "PHARMACIST_REVIEW",
          ).length,
          scheduled: filtered.filter((item) => item.kind === "SCHEDULED_FILL").length,
        },
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
