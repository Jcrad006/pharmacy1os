import {
  mkdir,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DocumentVaultError,
  getDocumentStorageRoot,
} from "./documentVault.js";

function coordinationRoot() {
  return join(getDocumentStorageRoot(), ".coordination");
}

function backupLockPath() {
  return join(coordinationRoot(), "backup.lock");
}

function writersRoot() {
  return join(coordinationRoot(), "writers");
}

async function exists(path: string) {
  try {
    await readdir(path);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function fileExists(path: string) {
  try {
    await import("node:fs/promises").then(({ stat }) => stat(path));
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDocumentVaultWriteLease<T>(
  action: () => Promise<T>,
): Promise<T> {
  const root = coordinationRoot();
  const writerRoot = writersRoot();
  await mkdir(writerRoot, { recursive: true });

  if (await fileExists(backupLockPath())) {
    throw new DocumentVaultError(
      503,
      "DOCUMENT_VAULT_BACKUP_IN_PROGRESS",
      "The document vault is temporarily read-only while a coordinated backup or restore is in progress.",
    );
  }

  const marker = join(
    writerRoot,
    `writer-${process.pid}-${randomUUID()}.lock`,
  );
  await writeFile(
    marker,
    JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }),
    { flag: "wx" },
  );

  try {
    if (await fileExists(backupLockPath())) {
      throw new DocumentVaultError(
        503,
        "DOCUMENT_VAULT_BACKUP_IN_PROGRESS",
        "The document vault became read-only for backup before this write began.",
      );
    }
    return await action();
  } finally {
    await unlink(marker).catch(() => undefined);
    if (!(await exists(writerRoot))) {
      await mkdir(root, { recursive: true });
    }
  }
}

export async function withExclusiveDocumentVaultLock<T>(
  purpose: "BACKUP" | "RESTORE",
  action: () => Promise<T>,
): Promise<T> {
  const root = coordinationRoot();
  const writerRoot = writersRoot();
  const lockPath = backupLockPath();
  await mkdir(writerRoot, { recursive: true });

  try {
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        purpose,
        createdAt: new Date().toISOString(),
      }),
      { flag: "wx" },
    );
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === "EEXIST") {
      throw new DocumentVaultError(
        409,
        "DOCUMENT_VAULT_EXCLUSIVE_OPERATION_IN_PROGRESS",
        "A coordinated document-vault backup or restore is already in progress.",
      );
    }
    throw error;
  }

  try {
    const timeoutMs = Math.max(
      1_000,
      Number(process.env.DOCUMENT_VAULT_LOCK_TIMEOUT_MS ?? 30_000),
    );
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const writers = await readdir(writerRoot).catch(() => []);
      if (writers.length === 0) break;
      if (Date.now() >= deadline) {
        throw new DocumentVaultError(
          503,
          "DOCUMENT_VAULT_WRITERS_DID_NOT_DRAIN",
          "Timed out waiting for active document writes to finish before the exclusive operation.",
          { activeWriterCount: writers.length, timeoutMs },
        );
      }
      await sleep(50);
    }

    return await action();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}
