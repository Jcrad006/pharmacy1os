import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { db } from "./db.js";
import {
  decodeStoredDocumentPayload,
  DocumentVaultError,
  getDocumentEncryptionKeyFingerprint,
  getDocumentStorageRoot,
  readImmutableDocument,
  readStoredDocumentPayload,
} from "./documentVault.js";
import { withExclusiveDocumentVaultLock } from "./vaultCoordination.js";

export type VaultIntegrityFindingType =
  | "MISSING_FILE"
  | "HASH_MISMATCH"
  | "SIZE_MISMATCH"
  | "DECRYPTION_FAILED"
  | "READ_ERROR"
  | "ORPHAN_FILE";

export type VaultIntegrityFinding = {
  type: VaultIntegrityFindingType;
  documentId: string | null;
  storageKey: string;
  expectedSha256?: string;
  actualSha256?: string;
  expectedBytes?: number;
  actualBytes?: number;
  detail?: string;
};

export type VaultIntegrityReport = {
  reportVersion: 1;
  reportId: string;
  startedAt: string;
  completedAt: string;
  status: "PASS" | "WARN" | "FAIL";
  documentCount: number;
  checkedFileCount: number;
  orphanFileCount: number;
  findings: VaultIntegrityFinding[];
};

export type BackupManifestDocument = {
  id: string;
  siteId: string;
  storageKey: string;
  logicalSha256: string;
  logicalBytes: number;
  encrypted: boolean;
  payloadSha256: string;
  payloadBytes: number;
};

export type BackupManifest = {
  format: "PHARMACY1OS_BACKUP";
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  applicationVersion: string;
  database: {
    file: "database.sql";
    sha256: string;
    byteSize: number;
    migrations: Array<{
      migrationName: string;
      finishedAt: string | null;
    }>;
  };
  documentVault: {
    encryptionKeyFingerprint: string | null;
    documentCount: number;
    totalLogicalBytes: number;
    totalPayloadBytes: number;
    documents: BackupManifestDocument[];
  };
};

export type BackupVerificationFinding = {
  type:
    | "MANIFEST_HASH_MISMATCH"
    | "DATABASE_DUMP_MISSING"
    | "DATABASE_DUMP_HASH_MISMATCH"
    | "DATABASE_DUMP_SIZE_MISMATCH"
    | "DOCUMENT_PAYLOAD_MISSING"
    | "DOCUMENT_PAYLOAD_HASH_MISMATCH"
    | "DOCUMENT_PAYLOAD_SIZE_MISMATCH"
    | "DOCUMENT_LOGICAL_HASH_MISMATCH"
    | "DOCUMENT_LOGICAL_SIZE_MISMATCH"
    | "DOCUMENT_DECRYPTION_FAILED"
    | "UNLISTED_BACKUP_FILE"
    | "ENCRYPTION_KEY_MISMATCH"
    | "MANIFEST_INVALID";
  storageKey?: string;
  detail: string;
};

export type BackupVerificationReport = {
  backupId: string;
  verifiedAt: string;
  status: "PASS" | "FAIL";
  manifest: BackupManifest | null;
  findings: BackupVerificationFinding[];
};

export type VaultDocumentRecord = {
  id: string;
  siteId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  encrypted: boolean;
};

export type BackupTooling = {
  dumpDatabase?: (destination: string) => Promise<void>;
  restoreDatabase?: (source: string) => Promise<void>;
  listDocuments?: () => Promise<VaultDocumentRecord[]>;
};

function backupRoot() {
  return resolve(
    process.env.BACKUP_ROOT ?? resolve(process.cwd(), "data", "backups"),
  );
}

function safeBackupPath(...parts: string[]) {
  const root = backupRoot();
  const candidate = resolve(root, ...parts);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new DocumentVaultError(
      400,
      "BACKUP_PATH_INVALID",
      "Backup path escaped the configured backup root.",
    );
  }
  return candidate;
}

function validateBackupId(backupId: string) {
  if (!/^backup-[A-Za-z0-9._-]+$/.test(backupId)) {
    throw new DocumentVaultError(
      400,
      "BACKUP_ID_INVALID",
      "Backup identifier is invalid.",
    );
  }
  return backupId;
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function hashBuffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(path: string) {
  return new Promise<{ sha256: string; byteSize: number }>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    let byteSize = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += buffer.length;
      hash.update(buffer);
    });
    stream.on("error", reject);
    stream.on("end", () =>
      resolvePromise({ sha256: hash.digest("hex"), byteSize }),
    );
  });
}

async function walkFiles(root: string, prefix = ""): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(join(root, entry.name), relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath.split(sep).join("/"));
    }
  }
  return files;
}

function errorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function writeJson(path: string, value: unknown) {
  const body = JSON.stringify(value, null, 2) + "\n";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { flag: "wx" });
  return Buffer.from(body, "utf8");
}

async function persistIntegrityReport(report: VaultIntegrityReport) {
  const path = safeBackupPath(
    "integrity-reports",
    `${report.reportId}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
}

async function loadVaultDocuments(): Promise<VaultDocumentRecord[]> {
  return db.document.findMany({
    select: {
      id: true,
      siteId: true,
      storageKey: true,
      sha256: true,
      byteSize: true,
      encrypted: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function scanDocumentVaultIntegrity(options?: {
  persist?: boolean;
  documents?: VaultDocumentRecord[];
}) {
  const startedAt = new Date();
  const documents = options?.documents ?? (await loadVaultDocuments());

  const findings: VaultIntegrityFinding[] = [];
  let checkedFileCount = 0;

  for (const document of documents) {
    try {
      const bytes = await readImmutableDocument({
        storageKey: document.storageKey,
        encrypted: document.encrypted,
      });
      checkedFileCount += 1;
      const actualSha256 = await hashBuffer(bytes);
      if (bytes.length !== document.byteSize) {
        findings.push({
          type: "SIZE_MISMATCH",
          documentId: document.id,
          storageKey: document.storageKey,
          expectedBytes: document.byteSize,
          actualBytes: bytes.length,
        });
      }
      if (actualSha256 !== document.sha256) {
        findings.push({
          type: "HASH_MISMATCH",
          documentId: document.id,
          storageKey: document.storageKey,
          expectedSha256: document.sha256,
          actualSha256,
        });
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        findings.push({
          type: "MISSING_FILE",
          documentId: document.id,
          storageKey: document.storageKey,
          detail: "Database metadata references a source file that does not exist.",
        });
      } else if (
        error instanceof DocumentVaultError &&
        (error.code === "DOCUMENT_ENCRYPTED_PAYLOAD_INVALID" ||
          error.code === "DOCUMENT_ENCRYPTION_KEY_REQUIRED")
      ) {
        findings.push({
          type: "DECRYPTION_FAILED",
          documentId: document.id,
          storageKey: document.storageKey,
          detail: error.message,
        });
      } else if (document.encrypted) {
        findings.push({
          type: "DECRYPTION_FAILED",
          documentId: document.id,
          storageKey: document.storageKey,
          detail: errorMessage(error),
        });
      } else {
        findings.push({
          type: "READ_ERROR",
          documentId: document.id,
          storageKey: document.storageKey,
          detail: errorMessage(error),
        });
      }
    }
  }

  const databaseKeys = new Set(documents.map((document) => document.storageKey));
  const originalsRoot = join(getDocumentStorageRoot(), "originals");
  const physicalFiles = await walkFiles(originalsRoot);
  for (const physicalRelative of physicalFiles) {
    const storageKey = `originals/${physicalRelative}`;
    if (!databaseKeys.has(storageKey)) {
      findings.push({
        type: "ORPHAN_FILE",
        documentId: null,
        storageKey,
        detail: "A vault file exists without a corresponding Document database record.",
      });
    }
  }

  const critical = findings.some((finding) => finding.type !== "ORPHAN_FILE");
  const orphanFileCount = findings.filter(
    (finding) => finding.type === "ORPHAN_FILE",
  ).length;
  const report: VaultIntegrityReport = {
    reportVersion: 1,
    reportId: `integrity-${startedAt
      .toISOString()
      .replace(/[-:.]/g, "")
      .replace("Z", "Z")}-${randomUUID().slice(0, 8)}`,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    status: critical ? "FAIL" : orphanFileCount > 0 ? "WARN" : "PASS",
    documentCount: documents.length,
    checkedFileCount,
    orphanFileCount,
    findings,
  };

  if (options?.persist !== false) {
    await persistIntegrityReport(report);
  }
  return report;
}

function databaseConnection() {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    throw new DocumentVaultError(
      503,
      "DATABASE_URL_REQUIRED",
      "DATABASE_URL is required for coordinated backup and restore.",
    );
  }
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new DocumentVaultError(
      503,
      "DATABASE_URL_UNSUPPORTED",
      "Only PostgreSQL DATABASE_URL values are supported.",
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new DocumentVaultError(
      503,
      "DATABASE_NAME_REQUIRED",
      "DATABASE_URL must include a database name.",
    );
  }
  const args = [
    "--host",
    url.hostname,
    "--port",
    url.port || "5432",
    "--username",
    decodeURIComponent(url.username),
    "--dbname",
    database,
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return { args, env };
}

async function runDatabaseTool(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new DocumentVaultError(
            503,
            "POSTGRES_BACKUP_TOOL_UNAVAILABLE",
            `Required PostgreSQL utility ${executable} is not installed or not executable.`,
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new DocumentVaultError(
            500,
            "POSTGRES_BACKUP_TOOL_FAILED",
            `${executable} exited with status ${String(code)}.`,
            { stderr: stderr.trim() },
          ),
        );
    });
  });
}

async function defaultDumpDatabase(destination: string) {
  const connection = databaseConnection();
  await runDatabaseTool(
    process.env.PG_DUMP_BIN?.trim() || "pg_dump",
    [
      ...connection.args,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--schema=public",
      "--file",
      destination,
    ],
    connection.env,
  );
}

async function defaultRestoreDatabase(source: string) {
  const connection = databaseConnection();
  await runDatabaseTool(
    process.env.PSQL_BIN?.trim() || "psql",
    [
      ...connection.args,
      "--set=ON_ERROR_STOP=1",
      "--single-transaction",
      "--file",
      source,
    ],
    connection.env,
  );
}

async function migrationSnapshot() {
  try {
    const rows = await db.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      'SELECT "migration_name", "finished_at" FROM "_prisma_migrations" WHERE "rolled_back_at" IS NULL ORDER BY "started_at" ASC',
    );
    return rows.map((row) => ({
      migrationName: row.migration_name,
      finishedAt: row.finished_at?.toISOString() ?? null,
    }));
  } catch {
    return [];
  }
}

function newBackupId() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace("Z", "Z");
  return `backup-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function verifyBackupDirectory(
  directory: string,
): Promise<BackupVerificationReport> {
  const findings: BackupVerificationFinding[] = [];
  const manifestPath = join(directory, "manifest.json");
  const manifestHashPath = join(directory, "manifest.sha256");
  let manifest: BackupManifest | null = null;
  let manifestBytes: Buffer | null = null;

  try {
    manifestBytes = await readFile(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8")) as BackupManifest;
    if (
      manifest.format !== "PHARMACY1OS_BACKUP" ||
      manifest.formatVersion !== 1 ||
      !manifest.backupId ||
      !manifest.database?.file ||
      !Array.isArray(manifest.documentVault?.documents)
    ) {
      throw new Error("Unsupported or malformed backup manifest.");
    }
  } catch (error) {
    findings.push({
      type: "MANIFEST_INVALID",
      detail: errorMessage(error),
    });
  }

  if (manifestBytes) {
    try {
      const expectedManifestHash = (await readFile(manifestHashPath, "utf8")).trim();
      const actualManifestHash = await hashBuffer(manifestBytes);
      if (expectedManifestHash !== actualManifestHash) {
        findings.push({
          type: "MANIFEST_HASH_MISMATCH",
          detail: "manifest.json does not match manifest.sha256.",
        });
      }
    } catch (error) {
      findings.push({
        type: "MANIFEST_HASH_MISMATCH",
        detail: `Manifest checksum is unavailable: ${errorMessage(error)}`,
      });
    }
  }

  if (manifest) {
    const currentFingerprint = getDocumentEncryptionKeyFingerprint();
    if (
      manifest.documentVault.encryptionKeyFingerprint &&
      currentFingerprint !== manifest.documentVault.encryptionKeyFingerprint
    ) {
      findings.push({
        type: "ENCRYPTION_KEY_MISMATCH",
        detail:
          "The configured document encryption key does not match the key used for this backup.",
      });
    }

    const databasePath = join(directory, manifest.database.file);
    try {
      const databaseHash = await hashFile(databasePath);
      if (databaseHash.sha256 !== manifest.database.sha256) {
        findings.push({
          type: "DATABASE_DUMP_HASH_MISMATCH",
          detail: "database.sql SHA-256 does not match the manifest.",
        });
      }
      if (databaseHash.byteSize !== manifest.database.byteSize) {
        findings.push({
          type: "DATABASE_DUMP_SIZE_MISMATCH",
          detail: "database.sql byte size does not match the manifest.",
        });
      }
    } catch (error) {
      findings.push({
        type: "DATABASE_DUMP_MISSING",
        detail: errorMessage(error),
      });
    }

    const expectedPayloadFiles = new Set<string>();
    for (const document of manifest.documentVault.documents) {
      const payloadRelative = join("documents", document.storageKey);
      expectedPayloadFiles.add(payloadRelative.split(sep).join("/"));
      const payloadPath = join(directory, payloadRelative);
      try {
        const payload = await readFile(payloadPath);
        const payloadSha256 = await hashBuffer(payload);
        if (payload.length !== document.payloadBytes) {
          findings.push({
            type: "DOCUMENT_PAYLOAD_SIZE_MISMATCH",
            storageKey: document.storageKey,
            detail: "Stored backup payload size does not match the manifest.",
          });
        }
        if (payloadSha256 !== document.payloadSha256) {
          findings.push({
            type: "DOCUMENT_PAYLOAD_HASH_MISMATCH",
            storageKey: document.storageKey,
            detail: "Stored backup payload SHA-256 does not match the manifest.",
          });
        }
        try {
          const logical = decodeStoredDocumentPayload(
            payload,
            document.encrypted,
          );
          const logicalSha256 = await hashBuffer(logical);
          if (logical.length !== document.logicalBytes) {
            findings.push({
              type: "DOCUMENT_LOGICAL_SIZE_MISMATCH",
              storageKey: document.storageKey,
              detail:
                "Decrypted/logical document byte size does not match the manifest.",
            });
          }
          if (logicalSha256 !== document.logicalSha256) {
            findings.push({
              type: "DOCUMENT_LOGICAL_HASH_MISMATCH",
              storageKey: document.storageKey,
              detail:
                "Decrypted/logical document SHA-256 does not match the manifest.",
            });
          }
        } catch (error) {
          findings.push({
            type: "DOCUMENT_DECRYPTION_FAILED",
            storageKey: document.storageKey,
            detail: errorMessage(error),
          });
        }
      } catch (error) {
        findings.push({
          type: "DOCUMENT_PAYLOAD_MISSING",
          storageKey: document.storageKey,
          detail: errorMessage(error),
        });
      }
    }

    const physicalBackupFiles = await walkFiles(join(directory, "documents"));
    for (const file of physicalBackupFiles) {
      const normalized = `documents/${file}`;
      if (!expectedPayloadFiles.has(normalized)) {
        findings.push({
          type: "UNLISTED_BACKUP_FILE",
          storageKey: file,
          detail: "Backup contains a document payload not listed in the manifest.",
        });
      }
    }
  }

  return {
    backupId: manifest?.backupId ?? basename(directory),
    verifiedAt: new Date().toISOString(),
    status: findings.length === 0 ? "PASS" : "FAIL",
    manifest,
    findings,
  };
}

export async function createBackupSet(options?: {
  tooling?: BackupTooling;
}) {
  await mkdir(backupRoot(), { recursive: true });
  return withExclusiveDocumentVaultLock("BACKUP", async () => {
    const backupId = newBackupId();
    const stagingDirectory = safeBackupPath(`.incomplete-${backupId}`);
    const finalDirectory = safeBackupPath(backupId);
    await mkdir(stagingDirectory, { recursive: false });

    try {
      const documents = await (
        options?.tooling?.listDocuments ?? loadVaultDocuments
      )();
      const integrity = await scanDocumentVaultIntegrity({
        persist: true,
        documents,
      });
      if (integrity.status === "FAIL") {
        throw new DocumentVaultError(
          409,
          "DOCUMENT_VAULT_INTEGRITY_FAILED",
          "Backup was not published because one or more database-referenced documents failed integrity verification.",
          { reportId: integrity.reportId },
        );
      }

      const databasePath = join(stagingDirectory, "database.sql");
      await (options?.tooling?.dumpDatabase ?? defaultDumpDatabase)(databasePath);
      const databaseHash = await hashFile(databasePath);

      const manifestDocuments: BackupManifestDocument[] = [];
      for (const document of documents) {
        const payload = await readStoredDocumentPayload(document.storageKey);
        const logical = decodeStoredDocumentPayload(payload, document.encrypted);
        const logicalSha256 = await hashBuffer(logical);
        if (
          logicalSha256 !== document.sha256 ||
          logical.length !== document.byteSize
        ) {
          throw new DocumentVaultError(
            409,
            "DOCUMENT_CHANGED_DURING_BACKUP",
            "A document no longer matches its database integrity metadata.",
            { documentId: document.id, storageKey: document.storageKey },
          );
        }

        const destination = join(
          stagingDirectory,
          "documents",
          document.storageKey,
        );
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, payload, { flag: "wx" });
        manifestDocuments.push({
          id: document.id,
          siteId: document.siteId,
          storageKey: document.storageKey,
          logicalSha256: document.sha256,
          logicalBytes: document.byteSize,
          encrypted: document.encrypted,
          payloadSha256: await hashBuffer(payload),
          payloadBytes: payload.length,
        });
      }

      const manifest: BackupManifest = {
        format: "PHARMACY1OS_BACKUP",
        formatVersion: 1,
        backupId,
        createdAt: new Date().toISOString(),
        applicationVersion: process.env.npm_package_version ?? "0.1.0",
        database: {
          file: "database.sql",
          sha256: databaseHash.sha256,
          byteSize: databaseHash.byteSize,
          migrations: await migrationSnapshot(),
        },
        documentVault: {
          encryptionKeyFingerprint: getDocumentEncryptionKeyFingerprint(),
          documentCount: manifestDocuments.length,
          totalLogicalBytes: manifestDocuments.reduce(
            (sum, document) => sum + document.logicalBytes,
            0,
          ),
          totalPayloadBytes: manifestDocuments.reduce(
            (sum, document) => sum + document.payloadBytes,
            0,
          ),
          documents: manifestDocuments,
        },
      };

      const manifestBytes = await writeJson(
        join(stagingDirectory, "manifest.json"),
        manifest,
      );
      await writeFile(
        join(stagingDirectory, "manifest.sha256"),
        (await hashBuffer(manifestBytes)) + "\n",
        { flag: "wx" },
      );

      const verification = await verifyBackupDirectory(stagingDirectory);
      if (verification.status !== "PASS") {
        throw new DocumentVaultError(
          500,
          "BACKUP_SELF_VERIFICATION_FAILED",
          "Backup staging completed but failed self-verification and was not published.",
          { findings: verification.findings },
        );
      }

      await rename(stagingDirectory, finalDirectory);
      return {
        backupId,
        createdAt: manifest.createdAt,
        directoryName: backupId,
        documentCount: manifest.documentVault.documentCount,
        databaseBytes: manifest.database.byteSize,
        documentBytes: manifest.documentVault.totalPayloadBytes,
        integrityStatus: integrity.status,
        integrityReportId: integrity.reportId,
      };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function verifyBackupSet(backupId: string) {
  validateBackupId(backupId);
  return verifyBackupDirectory(safeBackupPath(backupId));
}

export async function listBackupSets() {
  await mkdir(backupRoot(), { recursive: true });
  const entries = await readdir(backupRoot(), { withFileTypes: true });
  const backups: Array<{
    backupId: string;
    createdAt: string | null;
    documentCount: number | null;
    databaseBytes: number | null;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("backup-")) continue;
    try {
      const manifest = JSON.parse(
        await readFile(
          safeBackupPath(entry.name, "manifest.json"),
          "utf8",
        ),
      ) as BackupManifest;
      backups.push({
        backupId: entry.name,
        createdAt: manifest.createdAt ?? null,
        documentCount: manifest.documentVault?.documentCount ?? null,
        databaseBytes: manifest.database?.byteSize ?? null,
      });
    } catch {
      backups.push({
        backupId: entry.name,
        createdAt: null,
        documentCount: null,
        databaseBytes: null,
      });
    }
  }
  return backups.sort((a, b) =>
    String(b.createdAt ?? b.backupId).localeCompare(
      String(a.createdAt ?? a.backupId),
    ),
  );
}

async function copyBackupVaultToRestoreStaging(
  backupDirectory: string,
  stagingOriginals: string,
) {
  const sourceOriginals = join(backupDirectory, "documents", "originals");
  const files = await walkFiles(sourceOriginals);
  for (const file of files) {
    const source = join(sourceOriginals, ...file.split("/"));
    const destination = join(stagingOriginals, ...file.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

export async function restoreBackupSet(
  backupId: string,
  options?: { tooling?: BackupTooling; offlineConfirmed?: boolean },
) {
  validateBackupId(backupId);
  if (!options?.offlineConfirmed) {
    throw new DocumentVaultError(
      409,
      "RESTORE_OFFLINE_CONFIRMATION_REQUIRED",
      "Restore is an offline operator action. Stop the Pharmacy1OS API/workstation service and rerun with explicit offline confirmation.",
    );
  }
  const backupDirectory = safeBackupPath(backupId);
  const verification = await verifyBackupDirectory(backupDirectory);
  if (verification.status !== "PASS" || !verification.manifest) {
    throw new DocumentVaultError(
      409,
      "BACKUP_VERIFICATION_FAILED",
      "Restore was blocked because the selected backup did not pass verification.",
      { findings: verification.findings },
    );
  }
  const manifest = verification.manifest;

  return withExclusiveDocumentVaultLock("RESTORE", async () => {
    const restoreId = `restore-${new Date()
      .toISOString()
      .replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
    const root = getDocumentStorageRoot();
    const currentOriginals = join(root, "originals");
    const stagingRoot = join(root, `.${restoreId}-staging`);
    const stagingOriginals = join(stagingRoot, "originals");
    const rollbackOriginals = join(root, `.${restoreId}-rollback-originals`);
    const journalPath = safeBackupPath("restore-reports", `${restoreId}.json`);

    await mkdir(stagingOriginals, { recursive: true });
    await copyBackupVaultToRestoreStaging(backupDirectory, stagingOriginals);
    await mkdir(dirname(journalPath), { recursive: true });

    const journal = {
      restoreId,
      backupId,
      startedAt: new Date().toISOString(),
      phase: "PREPARED",
      rollbackVaultPath: basename(rollbackOriginals),
    };
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");

    const hadOriginals = await pathExists(currentOriginals);
    try {
      if (hadOriginals) {
        await rename(currentOriginals, rollbackOriginals);
      }
      await rename(stagingOriginals, currentOriginals);
      journal.phase = "VAULT_SWITCHED";
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");

      await db.$disconnect();
      try {
        await (options?.tooling?.restoreDatabase ?? defaultRestoreDatabase)(
          join(backupDirectory, manifest.database.file),
        );
      } catch (error) {
        await rm(currentOriginals, { recursive: true, force: true });
        if (hadOriginals && (await pathExists(rollbackOriginals))) {
          await rename(rollbackOriginals, currentOriginals);
        }
        journal.phase = "DATABASE_RESTORE_FAILED_VAULT_ROLLED_BACK";
        await writeFile(
          journalPath,
          JSON.stringify({
            ...journal,
            failedAt: new Date().toISOString(),
            error: errorMessage(error),
          }, null, 2) + "\n",
        );
        throw error;
      }

      journal.phase = "DATABASE_RESTORED";
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");

      const postRestoreDocuments = await (
        options?.tooling?.listDocuments ?? loadVaultDocuments
      )();
      const postcheck = await scanDocumentVaultIntegrity({
        persist: true,
        documents: postRestoreDocuments,
      });
      if (postcheck.status === "FAIL") {
        journal.phase = "POST_RESTORE_INTEGRITY_FAILED";
        await writeFile(
          journalPath,
          JSON.stringify({
            ...journal,
            completedAt: new Date().toISOString(),
            integrityReportId: postcheck.reportId,
          }, null, 2) + "\n",
        );
        throw new DocumentVaultError(
          500,
          "RESTORE_POSTCHECK_FAILED",
          "Database and vault restore completed, but the post-restore integrity scan failed. The rollback vault copy was preserved.",
          { integrityReportId: postcheck.reportId, restoreId },
        );
      }

      await rm(rollbackOriginals, { recursive: true, force: true });
      await rm(stagingRoot, { recursive: true, force: true });
      journal.phase = "COMPLETE";
      await writeFile(
        journalPath,
        JSON.stringify({
          ...journal,
          completedAt: new Date().toISOString(),
          integrityReportId: postcheck.reportId,
        }, null, 2) + "\n",
      );
      return {
        restoreId,
        backupId,
        completedAt: new Date().toISOString(),
        integrityReportId: postcheck.reportId,
        status: "COMPLETE" as const,
      };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });
}

export async function listIntegrityReports() {
  const directory = safeBackupPath("integrity-reports");
  if (!(await pathExists(directory))) return [];
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse();
  const reports: VaultIntegrityReport[] = [];
  for (const file of files.slice(0, 100)) {
    try {
      reports.push(
        JSON.parse(await readFile(join(directory, file), "utf8")) as VaultIntegrityReport,
      );
    } catch {
      // Keep a malformed historical report from breaking the administrative list.
    }
  }
  return reports;
}
