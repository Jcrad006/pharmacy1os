import type { FillStatus } from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";

type RulePrescription = {
  id: string;
  siteId: string;
  expirationDate: Date | null;
  doNotFillBefore: Date | null;
  minimumDaysBetweenFills: number | null;
  fills: Array<{
    status: FillStatus;
    soldAt: Date | null;
  }>;
};

export type DispensingRuleBlock = {
  code: "RX_EXPIRED" | "DO_NOT_FILL_BEFORE" | "REFILL_TOO_SOON";
  title: string;
  message: string;
  eligibleAt?: Date;
};

function endOfUtcDay(value: Date) {
  const result = new Date(value);
  result.setUTCHours(23, 59, 59, 999);
  return result;
}

export function evaluateDispensingDateRules(
  prescription: RulePrescription,
  targetDate: Date,
): DispensingRuleBlock | null {
  if (
    prescription.expirationDate &&
    targetDate.getTime() > endOfUtcDay(prescription.expirationDate).getTime()
  ) {
    return {
      code: "RX_EXPIRED",
      title: "Prescription expired",
      message: "This prescription is past its configured expiration date.",
    };
  }

  if (
    prescription.doNotFillBefore &&
    targetDate.getTime() < prescription.doNotFillBefore.getTime()
  ) {
    return {
      code: "DO_NOT_FILL_BEFORE",
      title: "Do-not-fill-before date",
      message: "This fill is earlier than the prescription's do-not-fill-before date.",
      eligibleAt: prescription.doNotFillBefore,
    };
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
        return {
          code: "REFILL_TOO_SOON",
          title: "Refill too soon",
          message: `This synthetic date rule requires at least ${minimumDays} day(s) between sold fills.`,
          eligibleAt,
        };
      }
    }
  }

  return null;
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
      status: "OPEN",
    },
  });

  if (existing) return existing;

  return db.$transaction(async (tx) => {
    const issue = await tx.durIssue.create({
      data: {
        prescriptionId: input.prescription.id,
        code: input.block.code,
        title: input.block.title,
        description: input.block.eligibleAt
          ? `${input.block.message} Eligible at: ${input.block.eligibleAt.toISOString()}`
          : input.block.message,
        severity: input.block.code === "RX_EXPIRED" ? "HIGH" : "WARNING",
        source: "SYNTHETIC_DATE_RULE",
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
