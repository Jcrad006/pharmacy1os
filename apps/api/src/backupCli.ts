import { db } from "./db.js";
import {
  createBackupSet,
  listBackupSets,
  restoreBackupSet,
  scanDocumentVaultIntegrity,
  verifyBackupSet,
} from "./backupIntegrity.js";

function print(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function usage() {
  process.stderr.write(
    [
      "Pharmacy1OS backup/integrity operator CLI",
      "",
      "Commands:",
      "  create",
      "  list",
      "  verify <backup-id>",
      "  scan",
      "  restore <backup-id> --confirm <backup-id> --offline",
      "",
      "Restore requires the Pharmacy1OS API/workstation service to be stopped.",
    ].join("\n") + "\n",
  );
}

async function main() {
  const [command, backupId, ...rest] = process.argv.slice(2);

  if (command === "create") {
    print(await createBackupSet());
    return;
  }
  if (command === "list") {
    print({ backups: await listBackupSets() });
    return;
  }
  if (command === "verify" && backupId) {
    print(await verifyBackupSet(backupId));
    return;
  }
  if (command === "scan") {
    print(await scanDocumentVaultIntegrity());
    return;
  }
  if (command === "restore" && backupId) {
    const confirmIndex = rest.indexOf("--confirm");
    const confirmation =
      confirmIndex >= 0 ? rest[confirmIndex + 1] : undefined;
    const offlineConfirmed = rest.includes("--offline");
    if (confirmation !== backupId || !offlineConfirmed) {
      throw new Error(
        "Restore blocked. Stop the Pharmacy1OS service, then supply --confirm " +
          backupId +
          " --offline.",
      );
    }
    print(
      await restoreBackupSet(backupId, {
        offlineConfirmed: true,
      }),
    );
    return;
  }

  usage();
  process.exitCode = 2;
}

main()
  .catch((error) => {
    process.stderr.write(
      JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          code:
            typeof error === "object" && error && "code" in error
              ? String((error as { code?: unknown }).code ?? "")
              : undefined,
          details:
            typeof error === "object" && error && "details" in error
              ? (error as { details?: unknown }).details
              : undefined,
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => undefined);
  });
