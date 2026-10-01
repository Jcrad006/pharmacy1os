import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DocumentVaultError,
  getDocumentStorageRoot,
} from "./documentVault.js";

const STALE_LOCK_MS = 5 * 60 * 1000;

function coordinationRoot() {
  return join(getDocumentStorageRoot(), ".coordination");
}

function backupLockPath() {
  return join(coordinationRoot(), "backup.lock");
}

function writersRoot() {
  return join(coordinationRoot(), "writers");
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

function pidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function readLockMetadata(path: string) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      pid?: number;
      createdAt?: string;
      purpose?: "BACKUP" | "RESTORE";
    };
    const createdAt = raw.createdAt
      ? new Date(raw.createdAt).getTime()
      : Number.NaN;
    return {
      pid: Number(raw.pid ?? 0),
      createdAt,
      purpose: raw.purpose ?? null,
    };
  } catch {
    return { pid: 0, createdAt: Number.NaN, purpose: null };
  }
}

async function reclaimStaleFile(path: string) {
  if (!(await pathExists(path))) return false;
  const metadata = await readLockMetadata(path);
  const age = Number.isFinite(metadata.createdAt)
    ? Date.now() - metadata.createdAt
    : Number.POSITIVE_INFINITY;

  if (metadata.purpose === "RESTORE") {
    return false;
  }

  if (!pidAlive(metadata.pid) && age >= STALE_LOCK_MS) {
    await unlink(path).catch(() => undefined);
    return true;
  }
  return false;
}

async function reclaimStaleWriterMarkers() {
  const writerRoot = writersRoot();
  await mkdir(writerRoot, { recursive: true });
  const names = await readdir(writerRoot).catch(() => []);
  for (const name of names) {
    await reclaimStaleFile(join(writerRoot, name));
  }
}

async function assertNoExclusiveLock() {
  const lockPath = backupLockPath();
  await reclaimStaleFile(lockPath);
  if (await pathExists(lockPath)) {
    const metadata = await readLockMetadata(lockPath);
    throw new DocumentVaultError(
      503,
      metadata.purpose === "RESTORE"
        ? "DOCUMENT_VAULT_RESTORE_RECOVERY_REQUIRED"
        : "DOCUMENT_VAULT_BACKUP_IN_PROGRESS",
      metadata.purpose === "RESTORE"
        ? "The document vault is locked by a restore operation. If the restore process is no longer running, keep Pharmacy1OS offline and investigate the restore journal before clearing the lock."
        : "The document vault is temporarily read-only while a coordinated backup is in progress.",
    );
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDocumentVaultWriteLease<T>(
  action: () => Promise<T>,
): Promise<T> {
  const writerRoot = writersRoot();
  await mkdir(writerRoot, { recursive: true });
  await assertNoExclusiveLock();

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
    await assertNoExclusiveLock();
    return await action();
  } finally {
    await unlink(marker).catch(() => undefined);
  }
}

async function createExclusiveLock(
  purpose: "BACKUP" | "RESTORE",
) {
  const lockPath = backupLockPath();
  await mkdir(coordinationRoot(), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
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
      return lockPath;
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code !== "EEXIST") throw error;
      const reclaimed = await reclaimStaleFile(lockPath);
      if (!reclaimed) {
        throw new DocumentVaultError(
          409,
          "DOCUMENT_VAULT_EXCLUSIVE_OPERATION_IN_PROGRESS",
          "A coordinated document-vault backup or restore is already in progress.",
        );
      }
    }
  }

  throw new DocumentVaultError(
    409,
    "DOCUMENT_VAULT_EXCLUSIVE_OPERATION_IN_PROGRESS",
    "Unable to acquire the document-vault exclusive lock.",
  );
}

export async function withExclusiveDocumentVaultLock<T>(
  purpose: "BACKUP" | "RESTORE",
  action: () => Promise<T>,
): Promise<T> {
  const writerRoot = writersRoot();
  await mkdir(writerRoot, { recursive: true });
  const lockPath = await createExclusiveLock(purpose);

  try {
    const timeoutMs = Math.max(
      1_000,
      Number(process.env.DOCUMENT_VAULT_LOCK_TIMEOUT_MS ?? 30_000),
    );
    const deadline = Date.now() + timeoutMs;

    while (true) {
      await reclaimStaleWriterMarkers();
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
