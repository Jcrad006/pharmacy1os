import type { FillStatus } from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";

type RulePrescription = {
  id: string;
  siteId: string;
  expirationDate: Date | null;
  doNotFillBefore: Date | null;
  minimumDaysBetweenFills: number | null;
  fills: Array<{ status: FillStatus; soldAt: Date | null }>;
};

export type DispensingRuleCode =
  | "RX_EXPIRED"
  | "DO_NOT_FILL_BEFORE"
  | "REFILL_TOO_SOON";

export type DispensingRuleBlock = {
  code: DispensingRuleCode;
  title: string;
  message: string;
  eligibleAt?: Date;
};

function endOfUtcDay(value: Date) {
  const result = new Date(value);
  result.setUTCHours(23, 59, 59, 999);
  return result;
}

export function evaluateDispensingDateRuleBlocks(
  prescription: RulePrescription,
  targetDate: Date,
): DispensingRuleBlock[] {
  const blocks: DispensingRuleBlock[] = [];

  if (
    prescription.expirationDate &&
    targetDate.getTime() > endOfUtcDay(prescription.expirationDate).getTime()
  ) {
    blocks.push({
      code: "RX_EXPIRED",
      title: "Prescription expired",
      message: "This prescription is past its configured expiration date.",
    });
  }

  if (
    prescription.doNotFillBefore &&
    targetDate.getTime() < prescription.doNotFillBefore.getTime()
  ) {
    blocks.push({
      code: "DO_NOT_FILL_BEFORE",
      title: "Do-not-fill-before date",
      message: "This fill is earlier than the prescription's do-not-fill-before date.",
      eligibleAt: prescription.doNotFillBefore,
    });
  }

  const minimumDays = prescription.minimumDaysBetweenFills ?? 0;
  if (minimumDays > 0) {
    const lastSoldAt = prescription.fills
      .filter((fill) => fill.status === "SOLD" && fill.soldAt)
      .map((fill) => fill.soldAt as Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    if (lastSoldAt) {
      const eligibleAt = new Date(
        lastSoldAt.getTime() + minimumDays * 24 * 60 * 60 * 1000,
      );

      if (targetDate.getTime() < eligibleAt.getTime()) {
        blocks.push({
          code: "REFILL_TOO_SOON",
          title: "Refill too soon",
          message: `This synthetic date rule requires at least ${minimumDays} day(s) between sold fills.`,
          eligibleAt,
        });
      }
    }
  }

  return blocks;
}

export function evaluateDispensingDateRules(
  prescription: RulePrescription,
  targetDate: Date,
): DispensingRuleBlock | null {
  return evaluateDispensingDateRuleBlocks(prescription, targetDate)[0] ?? null;
}

export async function reconcileDateRuleIssues(input: {
  prescription: RulePrescription;
  targetDate: Date;
  actorId: string;
  requestId?: string;
}) {
  const activeCodes = new Set(
    evaluateDispensingDateRuleBlocks(input.prescription, input.targetDate).map(
      (block) => block.code,
    ),
  );

  const openDateIssues = await db.durIssue.findMany({
    where: {
      prescriptionId: input.prescription.id,
      source: "SYNTHETIC_DATE_RULE",
      status: "OPEN",
    },
  });

  const staleIssues = openDateIssues.filter(
    (issue) => !activeCodes.has(issue.code as DispensingRuleCode),
  );

  if (staleIssues.length === 0) return [];

  return db.$transaction(async (tx) => {
    const resolved = [];

    for (const issue of staleIssues) {
      const updated = await tx.durIssue.update({
        where: { id: issue.id },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          resolutionNote:
            "Automatically resolved because the synthetic dispensing date rule no longer blocks the intended fill date.",
          resolvedAutomatically: true,
          resolvedById: null,
        },
      });

      await writeAuditEvent(tx, {
        siteId: input.prescription.siteId,
        actorId: input.actorId,
        action: "DUR_ISSUE_AUTO_RESOLVED",
        entityType: "DurIssue",
        entityId: issue.id,
        requestId: input.requestId,
        metadata: {
          prescriptionId: input.prescription.id,
          code: issue.code,
          targetDate: input.targetDate.toISOString(),
        },
      });

      resolved.push(updated);
    }

    return resolved;
  });
}

export async function recordDateRuleIssue(input: {
  prescription: RulePrescription;
  block: DispensingRuleBlock;
  actorId: string;
  requestId?: string;
}) {
  const existing = await db.durIssue.findFirst({
    where: {
      prescriptionId: input.prescription.id,
      code: input.block.code,
      source: "SYNTHETIC_DATE_RULE",
      status: "OPEN",
    },
  });

  const description = input.block.eligibleAt
    ? `${input.block.message} Eligible at: ${input.block.eligibleAt.toISOString()}`
    : input.block.message;

  if (existing) {
    if (
      existing.eligibleAt?.getTime() !== input.block.eligibleAt?.getTime() ||
      existing.description !== description
    ) {
      return db.durIssue.update({
        where: { id: existing.id },
        data: {
          eligibleAt: input.block.eligibleAt ?? null,
          description,
        },
      });
    }
    return existing;
  }

  return db.$transaction(async (tx) => {
    const issue = await tx.durIssue.create({
      data: {
        prescriptionId: input.prescription.id,
        code: input.block.code,
        title: input.block.title,
        description,
        severity: input.block.code === "RX_EXPIRED" ? "HIGH" : "WARNING",
        source: "SYNTHETIC_DATE_RULE",
        eligibleAt: input.block.eligibleAt,
      },
    });

    await writeAuditEvent(tx, {
      siteId: input.prescription.siteId,
      actorId: input.actorId,
      action: "DUR_ISSUE_OPENED",
      entityType: "DurIssue",
      entityId: issue.id,
      requestId: input.requestId,
      metadata: {
        prescriptionId: input.prescription.id,
        code: input.block.code,
        eligibleAt: input.block.eligibleAt?.toISOString() ?? null,
      },
    });

    return issue;
  });
}
