import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";
process.env.DOCUMENT_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DOCUMENT_STORAGE_ROOT = resolve(
  tmpdir(),
  "pharmacy1os-stage3l-" + process.pid,
);

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };
const internHeaders = { "x-dev-user": "dev-intern" };
const cashierHeaders = { "x-dev-user": "dev-cashier" };
const siteId = "site-demo-001";
const prescriberId = "prescriber-demo-001";

async function createPatient() {
  return db.patient.create({
    data: {
      id: "patient-3l-" + randomUUID(),
      siteId,
      firstName: "Stage3L",
      lastName: "Document-" + randomUUID().slice(0, 8),
      dateOfBirth: new Date("1985-04-03T00:00:00.000Z"),
    },
  });
}

async function createRx(
  patientId: string,
  sourceType: "PAPER" | "ELECTRONIC",
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId,
      prescriberId,
      medicationName: "Stage 3L Test Drug 10 mg tablet",
      rxNumber: "3L-" + randomUUID().slice(0, 12),
      sig: "Take one tablet once daily",
      quantityWritten: 30,
      refillsAllowed: 2,
      sourceType,
      ...(sourceType === "ELECTRONIC"
        ? {
            electronicMessageId: "ERX-" + randomUUID(),
            electronicRawMessage:
              "<NewRx><Directions>Take one tablet once daily</Directions></NewRx>",
          }
        : {}),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().prescription as {
    id: string;
    sourceType: string;
    electronicMessageId: string | null;
  };
}

beforeAll(async () => {
  await rm(process.env.DOCUMENT_STORAGE_ROOT!, {
    recursive: true,
    force: true,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
  await rm(process.env.DOCUMENT_STORAGE_ROOT!, {
    recursive: true,
    force: true,
  });
});

describe("Stage 3L local document vault and prescription annotation workflow", () => {
  it("stores an immutable encrypted original and keeps visual changes separate and revision-safe", async () => {
    const patient = await createPatient();
    const rx = await createRx(patient.id, "PAPER");
    const sourceBytes = Buffer.from(
      "stage-3l-immutable-prescription-source-" + randomUUID(),
      "utf8",
    );
    const expectedHash = createHash("sha256")
      .update(sourceBytes)
      .digest("hex");

    const upload = await app.inject({
      method: "POST",
      url: "/api/prescriptions/" + rx.id + "/documents/original",
      headers: technicianHeaders,
      payload: {
        sourceType: "SCAN",
        mimeType: "image/png",
        originalFilename: "paper-rx.png",
        base64Data: sourceBytes.toString("base64"),
      },
    });
    expect(upload.statusCode).toBe(201);
    const document = upload.json().document as {
      id: string;
      sha256: string;
      byteSize: number;
      encrypted: boolean;
    };
    expect(document.sha256).toBe(expectedHash);
    expect(document.byteSize).toBe(sourceBytes.length);
    expect(document.encrypted).toBe(true);

    const stored = await db.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    const rawFile = await readFile(
      resolve(process.env.DOCUMENT_STORAGE_ROOT!, stored.storageKey),
    );
    expect(rawFile.equals(sourceBytes)).toBe(false);
    expect(rawFile.subarray(0, 5).toString("utf8")).toBe("P1DV1");

    const contentResponse = await app.inject({
      method: "GET",
      url: "/api/documents/" + document.id + "/content",
      headers: technicianHeaders,
    });
    expect(contentResponse.statusCode).toBe(200);
    expect(contentResponse.rawPayload.equals(sourceBytes)).toBe(true);

    const cashierDenied = await app.inject({
      method: "GET",
      url: "/api/documents/" + document.id + "/content",
      headers: cashierHeaders,
    });
    expect(cashierDenied.statusCode).toBe(403);

    const annotation = await app.inject({
      method: "POST",
      url: "/api/documents/" + document.id + "/annotations",
      headers: technicianHeaders,
      payload: {
        text: "PER MD: TAKE 1 TABLET BID",
        x: 0.2,
        y: 0.35,
        width: 0.45,
        height: 0.12,
        change: {
          changeType: "SIG",
          whatChanged:
            '"Take one tablet once daily" -> "Take one tablet twice daily"',
          reason: "Clarified with prescriber office",
          communicationMethod: "PHONE",
          contactedParty: "Jane Doe, RN",
          authorizingPrescriber: "Demo Prescriber",
          note: "Office confirmed intended directions.",
        },
      },
    });
    expect(annotation.statusCode).toBe(201);
    expect(annotation.json().annotation.text).toBe(
      "PER MD: TAKE 1 TABLET BID",
    );
    expect(annotation.json().annotation.backgroundOpacity).toBe("1");
    expect(annotation.json().annotation.changeRecord.changedBy.role).toBe(
      "TECHNICIAN",
    );

    const annotationId = annotation.json().annotation.id as string;
    const revision = await app.inject({
      method: "POST",
      url: "/api/annotations/" + annotationId + "/supersede",
      headers: internHeaders,
      payload: {
        text: "PER PRESCRIBER: 1 TAB PO BID",
        x: 0.2,
        y: 0.35,
        width: 0.48,
        height: 0.12,
        change: {
          changeType: "SIG",
          whatChanged: "Reworded visual clarification; clinical intent unchanged",
          reason: "Corrected annotation wording for clarity",
          communicationMethod: "PHONE",
          contactedParty: "Jane Doe, RN",
          authorizingPrescriber: "Demo Prescriber",
        },
      },
    });
    expect(revision.statusCode).toBe(200);
    expect(revision.json().annotation.changeRecord.changedBy.role).toBe(
      "INTERN",
    );

    const list = await app.inject({
      method: "GET",
      url: "/api/prescriptions/" + rx.id + "/documents",
      headers: technicianHeaders,
    });
    expect(list.statusCode).toBe(200);
    const annotations = list.json().documents[0].annotations as Array<{
      id: string;
      status: string;
      text: string;
      changeRecord: { status: string };
    }>;
    expect(annotations).toHaveLength(2);
    expect(
      annotations.find((item) => item.id === annotationId)?.status,
    ).toBe("SUPERSEDED");
    expect(
      annotations.find((item) => item.id === annotationId)?.changeRecord
        .status,
    ).toBe("SUPERSEDED");
    expect(
      annotations.filter((item) => item.status === "ACTIVE"),
    ).toHaveLength(1);

    const contentAfterChanges = await app.inject({
      method: "GET",
      url: "/api/documents/" + document.id + "/content",
      headers: technicianHeaders,
    });
    expect(contentAfterChanges.statusCode).toBe(200);
    expect(contentAfterChanges.rawPayload.equals(sourceBytes)).toBe(true);

    const unchanged = await db.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(unchanged.sha256).toBe(expectedHash);
    expect(unchanged.immutable).toBe(true);
  });

  it("renders electronic prescription data into an immutable human-readable visual", async () => {
    const patient = await createPatient();
    const rx = await createRx(patient.id, "ELECTRONIC");
    expect(rx.sourceType).toBe("ELECTRONIC");
    expect(rx.electronicMessageId).toMatch(/^ERX-/);

    const render = await app.inject({
      method: "POST",
      url: "/api/prescriptions/" + rx.id + "/documents/electronic-render",
      headers: technicianHeaders,
      payload: {},
    });
    expect(render.statusCode).toBe(200);
    expect(render.json().document.sourceType).toBe("ELECTRONIC_RENDER");
    expect(render.json().document.mimeType).toBe("image/svg+xml");

    const renderAgain = await app.inject({
      method: "POST",
      url: "/api/prescriptions/" + rx.id + "/documents/electronic-render",
      headers: technicianHeaders,
      payload: {},
    });
    expect(renderAgain.statusCode).toBe(200);
    expect(renderAgain.json().document.id).toBe(
      render.json().document.id,
    );

    const visual = await app.inject({
      method: "GET",
      url: "/api/documents/" + render.json().document.id + "/content",
      headers: technicianHeaders,
    });
    expect(visual.statusCode).toBe(200);
    const svg = visual.rawPayload.toString("utf8");
    expect(svg).toContain("ELECTRONIC PRESCRIPTION");
    expect(svg).toContain("Stage 3L Test Drug 10 mg tablet");
    expect(svg).toContain("Take one tablet once daily");
    expect(svg).toContain("HUMAN-READABLE RENDERING");
    expect(svg).not.toContain("<NewRx>");
  });
});
