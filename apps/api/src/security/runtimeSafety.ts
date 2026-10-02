export class RuntimeSafetyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function configuredSecret(name: string, minimumBytes: number) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new RuntimeSafetyError(
      `${name}_REQUIRED`,
      `${name} is required for production safety mode.`,
    );
  }
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new RuntimeSafetyError(
      `${name}_WEAK`,
      `${name} must contain at least ${minimumBytes} bytes of secret material.`,
    );
  }
  return value;
}

export function assertRuntimeSafetyConfiguration() {
  if (process.env.NODE_ENV !== "production") return;

  if (process.env.ALLOW_DEV_IDENTITY === "true") {
    throw new RuntimeSafetyError(
      "DEV_IDENTITY_FORBIDDEN",
      "ALLOW_DEV_IDENTITY cannot be enabled in production.",
    );
  }

  // Pharmacy1OS currently has only the explicit synthetic development identity
  // provider. Starting the clinical application in production before a real
  // identity provider/session/MFA implementation exists would create a false
  // sense of security, so production execution deliberately fails closed.
  if (process.env.AUTH_MODE !== "production") {
    throw new RuntimeSafetyError(
      "PRODUCTION_AUTH_NOT_IMPLEMENTED",
      "Production startup is blocked until a real authentication provider, session lifecycle, and workstation lock policy are implemented and AUTH_MODE=production is backed by that implementation.",
    );
  }

  const documentKey = process.env.DOCUMENT_ENCRYPTION_KEY?.trim();
  if (!documentKey || !/^[a-f0-9]{64}$/i.test(documentKey)) {
    throw new RuntimeSafetyError(
      "DOCUMENT_ENCRYPTION_KEY_REQUIRED",
      "Production requires a 64-character hexadecimal AES-256 document encryption key.",
    );
  }

  if (process.env.REQUIRE_SIGNED_BACKUPS !== "true") {
    throw new RuntimeSafetyError(
      "SIGNED_BACKUPS_REQUIRED",
      "Production requires REQUIRE_SIGNED_BACKUPS=true.",
    );
  }
  configuredSecret("BACKUP_SIGNING_KEY", 32);

  const webOrigin = process.env.WEB_ORIGIN?.trim();
  if (!webOrigin || !webOrigin.startsWith("https://")) {
    throw new RuntimeSafetyError(
      "HTTPS_WEB_ORIGIN_REQUIRED",
      "Production WEB_ORIGIN must use HTTPS.",
    );
  }
}
