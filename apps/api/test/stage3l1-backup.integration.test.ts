import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBackupSet,
  listBackupSets,
  restoreBackupSet,
  scanDocumentVaultIntegrity,
  verifyBackupSet,
  type VaultDocumentRecord,
} from "../src/backupIntegrity.js";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import {
  getDocumentStoragePath,
  readImmutableDocument,
  readStoredDocumentPayload,
} from "../src/documentVault.js";
import {
  clearDocumentVaultRecoveryRequired,
  withExclusiveDocumentVaultLock,
} from "../src/vaultCoordination.js";

process.env.ALLOW_DEV_IDENTITY = "true";
process.env.DOCUMENT_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DOCUMENT_STORAGE_ROOT = resolve(
  tmpdir(),
  "pharmacy1os-stage3l1-vault-" + process.pid,
);
process.env.BACKUP_ROOT = resolve(
  tmpdir(),
  "pharmacy1os-stage3l1-backups-" + process.pid,
);
process.env.DOCUMENT_VAULT_LOCK_TIMEOUT_MS = "2000";
process.env.BACKUP_SIGNING_KEY =
  "stage3l1-backup-signing-key-0123456789abcdef0123456789abcdef";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };
const adminHeaders = { "x-dev-user": "dev-admin" };
const siteId = "site-demo-001";
const prescriberId = "prescriber-demo-001";

let patientId = "";
let prescriptionId = "";
let documentRecord!: VaultDocumentRecord;
let originalBytes!: Buffer;
let backupId = "";

async function createPrescriptionDocument() {
  patientId = "patient-3l1-" + randomUUID();
  await db.patient.create({
    data: {
      id: patientId,
      siteId,
      firstName: "Stage3L1",
      lastName: "Backup-" + randomUUID().slice(0, 8),
      dateOfBirth: new Date("1980-01-01T00:00:00.000Z"),
    },
  });

  const prescription = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId,
      prescriberId,
      medicationName: "Stage 3L.1 Test Tablet",
      rxNumber: "3L1-" + randomUUID().slice(0, 12),
      sig: "Take one tablet daily",
      quantityWritten: 30,
      refillsAllowed: 1,
      sourceType: "PAPER",
    },
  });
  expect(prescription.statusCode).toBe(201);
  prescriptionId = prescription.json().prescription.id;

  originalBytes = Buffer.from(
    "stage-3l1-immutable-document-" + randomUUID(),
    "utf8",
  );
  const upload = await app.inject({
    method: "POST",
    url: "/api/prescriptions/" + prescriptionId + "/documents/original",
    headers: technicianHeaders,
    payload: {
      sourceType: "SCAN",
      mimeType: "image/png",
      originalFilename: "stage3l1-rx.png",
      base64Data: originalBytes.toString("base64"),
    },
  });
  expect(upload.statusCode).toBe(201);

  const stored = await db.document.findUniqueOrThrow({
    where: { id: upload.json().document.id },
    select: {
      id: true,
      siteId: true,
      storageKey: true,
      sha256: true,
      byteSize: true,
      encrypted: true,
    },
  });
  documentRecord = stored;
}

async function fakeDump(destination: string) {
  await writeFile(
    destination,
    "-- Pharmacy1OS Stage 3L.1 synthetic PostgreSQL dump\nSELECT 1;\n",
  );
}

beforeAll(async () => {
  await rm(process.env.DOCUMENT_STORAGE_ROOT!, {
    recursive: true,
    force: true,
  });
  await rm(process.env.BACKUP_ROOT!, {
    recursive: true,
    force: true,
  });
  await app.ready();
  await createPrescriptionDocument();
});

afterAll(async () => {
  await db.document.deleteMany({
    where: { id: documentRecord?.id },
  });
  await db.prescription.deleteMany({
    where: { id: prescriptionId },
  });
  await db.patient.deleteMany({
    where: { id: patientId },
  });
  await app.close();
  await db.$disconnect();
  await rm(process.env.DOCUMENT_STORAGE_ROOT!, {
    recursive: true,
    force: true,
  });
  await rm(process.env.BACKUP_ROOT!, {
    recursive: true,
    force: true,
  });
});

describe("Stage 3L.1 coordinated backup and vault integrity", () => {
  it("reports PASS for a valid document and WARN for an orphan without treating it as referenced corruption", async () => {
    const pass = await scanDocumentVaultIntegrity({
      persist: false,
      documents: [documentRecord],
    });
    expect(pass.status).toBe("PASS");
    expect(pass.documentCount).toBe(1);
    expect(pass.checkedFileCount).toBe(1);
    expect(pass.findings).toHaveLength(0);

    const orphanKey =
      "originals/" + siteId + "/orphan-" + randomUUID() + ".p1doc";
    const orphanPath = getDocumentStoragePath(orphanKey);
    await mkdir(dirname(orphanPath), { recursive: true });
    await writeFile(orphanPath, "unreferenced");

    const warn = await scanDocumentVaultIntegrity({
      persist: false,
      documents: [documentRecord],
    });
    expect(warn.status).toBe("WARN");
    expect(warn.orphanFileCount).toBe(1);
    expect(warn.findings[0]?.type).toBe("ORPHAN_FILE");

    await unlink(orphanPath);
  });

  it("publishes only a self-verifying coordinated backup set", async () => {
    const result = await createBackupSet({
      tooling: {
        dumpDatabase: fakeDump,
        listDocuments: async () => [documentRecord],
      },
    });
    backupId = result.backupId;
    expect(result.documentCount).toBe(1);
    expect(result.integrityStatus).toBe("PASS");

    const backups = await listBackupSets();
    expect(backups.some((item) => item.backupId === backupId)).toBe(true);

    const verification = await verifyBackupSet(backupId);
    expect(verification.status).toBe("PASS");
    expect(verification.findings).toHaveLength(0);
    expect(verification.manifest?.documentVault.documentCount).toBe(1);

    const rootEntries = await readdir(process.env.BACKUP_ROOT!);
    expect(rootEntries.some((name) => name.startsWith(".incomplete-"))).toBe(
      false,
    );
  });

  it("detects manifest tampering even when the attacker recomputes the plain SHA-256 checksum", async () => {
    const backupDirectory = resolve(process.env.BACKUP_ROOT!, backupId);
    const manifestPath = resolve(backupDirectory, "manifest.json");
    const hashPath = resolve(backupDirectory, "manifest.sha256");
    const originalManifest = await readFile(manifestPath);
    const originalHash = await readFile(hashPath);

    const parsed = JSON.parse(originalManifest.toString("utf8")) as Record<
      string,
      unknown
    >;
    parsed.applicationVersion = "attacker-rewritten-version";
    const tamperedManifest = Buffer.from(
      JSON.stringify(parsed, null, 2) + "\n",
      "utf8",
    );
    await writeFile(manifestPath, tamperedManifest);
    await writeFile(
      hashPath,
      createHash("sha256").update(tamperedManifest).digest("hex") + "\n",
    );

    const verification = await verifyBackupSet(backupId);
    expect(verification.status).toBe("FAIL");
    expect(
      verification.findings.some(
        (item) => item.type === "MANIFEST_SIGNATURE_MISMATCH",
      ),
    ).toBe(true);

    await writeFile(manifestPath, originalManifest);
    await writeFile(hashPath, originalHash);
    expect((await verifyBackupSet(backupId)).status).toBe("PASS");
  });

  it("blocks document writes while the coordinated exclusive lock is active", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });

    const exclusive = withExclusiveDocumentVaultLock("BACKUP", async () => {
      await hold;
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    const blocked = await app.inject({
      method: "POST",
      url: "/api/prescriptions/" + prescriptionId + "/documents/original",
      headers: technicianHeaders,
      payload: {
        sourceType: "SCAN",
        mimeType: "image/png",
        originalFilename: "blocked.png",
        base64Data: Buffer.from("blocked-write").toString("base64"),
      },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().code).toBe("DOCUMENT_VAULT_BACKUP_IN_PROGRESS");

    release();
    await exclusive;
  });

  it("classifies a missing database-referenced source as FAIL and restores it from the coordinated backup", async () => {
    const sourcePath = getDocumentStoragePath(documentRecord.storageKey);
    await unlink(sourcePath);

    const failed = await scanDocumentVaultIntegrity({
      persist: false,
      documents: [documentRecord],
    });
    expect(failed.status).toBe("FAIL");
    expect(failed.findings.some((item) => item.type === "MISSING_FILE")).toBe(
      true,
    );

    const restored = await restoreBackupSet(backupId, {
      offlineConfirmed: true,
      tooling: {
        restoreDatabase: async () => undefined,
        listDocuments: async () => [documentRecord],
      },
    });
    expect(restored.status).toBe("COMPLETE");

    const bytes = await readImmutableDocument({
      storageKey: documentRecord.storageKey,
      encrypted: documentRecord.encrypted,
    });
    expect(bytes.equals(originalBytes)).toBe(true);

    const post = await scanDocumentVaultIntegrity({
      persist: false,
      documents: [documentRecord],
    });
    expect(post.status).toBe("PASS");
  });

  it("rolls the vault back when the database restore step fails", async () => {
    const beforePayload = await readStoredDocumentPayload(
      documentRecord.storageKey,
    );

    await expect(
      restoreBackupSet(backupId, {
        offlineConfirmed: true,
        tooling: {
          restoreDatabase: async () => {
            throw new Error("synthetic database restore failure");
          },
          listDocuments: async () => [documentRecord],
        },
      }),
    ).rejects.toThrow("synthetic database restore failure");

    const afterPayload = await readStoredDocumentPayload(
      documentRecord.storageKey,
    );
    expect(afterPayload.equals(beforePayload)).toBe(true);
  });

  it("rejects a tampered backup and never permits it to restore", async () => {
    const verification = await verifyBackupSet(backupId);
    const document = verification.manifest?.documentVault.documents[0];
    expect(document).toBeTruthy();

    const payloadPath = resolve(
      process.env.BACKUP_ROOT!,
      backupId,
      "documents",
      document!.storageKey,
    );
    const originalBackupPayload = await readFile(payloadPath);
    await writeFile(
      payloadPath,
      Buffer.concat([originalBackupPayload, Buffer.from("tamper")]),
    );

    const tampered = await verifyBackupSet(backupId);
    expect(tampered.status).toBe("FAIL");
    expect(
      tampered.findings.some(
        (item) =>
          item.type === "DOCUMENT_PAYLOAD_HASH_MISMATCH" ||
          item.type === "DOCUMENT_PAYLOAD_SIZE_MISMATCH",
      ),
    ).toBe(true);

    await expect(
      restoreBackupSet(backupId, {
        offlineConfirmed: true,
        tooling: {
          restoreDatabase: async () => undefined,
          listDocuments: async () => [documentRecord],
        },
      }),
    ).rejects.toMatchObject({ code: "BACKUP_VERIFICATION_FAILED" });

    await writeFile(payloadPath, originalBackupPayload);
    expect((await verifyBackupSet(backupId)).status).toBe("PASS");
  });

  it("does not publish an incomplete backup when database export fails", async () => {
    const before = await listBackupSets();

    await expect(
      createBackupSet({
        tooling: {
          dumpDatabase: async () => {
            throw new Error("synthetic dump failure");
          },
          listDocuments: async () => [documentRecord],
        },
      }),
    ).rejects.toThrow("synthetic dump failure");

    const after = await listBackupSets();
    expect(after.map((item) => item.backupId)).toEqual(
      before.map((item) => item.backupId),
    );
    const rootEntries = await readdir(process.env.BACKUP_ROOT!);
    expect(rootEntries.some((name) => name.startsWith(".incomplete-"))).toBe(
      false,
    );
  });

  it("keeps document writes fail-closed after a post-restore integrity failure", async () => {
    const deliberatelyWrongRecord = {
      ...documentRecord,
      sha256: "0".repeat(64),
    };

    try {
      await expect(
        restoreBackupSet(backupId, {
          offlineConfirmed: true,
          tooling: {
            restoreDatabase: async () => undefined,
            listDocuments: async () => [deliberatelyWrongRecord],
          },
        }),
      ).rejects.toMatchObject({ code: "RESTORE_POSTCHECK_FAILED" });

      const blocked = await app.inject({
        method: "POST",
        url: "/api/prescriptions/" + prescriptionId + "/documents/original",
        headers: technicianHeaders,
        payload: {
          sourceType: "SCAN",
          mimeType: "image/png",
          originalFilename: "blocked-after-failed-restore.png",
          base64Data: Buffer.from("must-remain-blocked").toString("base64"),
        },
      });
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json().code).toBe(
        "DOCUMENT_VAULT_RESTORE_RECOVERY_REQUIRED",
      );
    } finally {
      await clearDocumentVaultRecoveryRequired();
    }
  });

  it("restricts maintenance endpoints to administrators", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/api/system/backups",
      headers: technicianHeaders,
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/system/backups",
      headers: adminHeaders,
    });
    expect(allowed.statusCode).toBe(200);
    expect(Array.isArray(allowed.json().backups)).toBe(true);
  });
});
