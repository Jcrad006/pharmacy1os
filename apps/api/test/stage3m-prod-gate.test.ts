import { afterEach, describe, expect, it } from "vitest";
import { assertRuntimeSafetyConfiguration } from "../src/security/runtimeSafety.js";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("Stage 3M fail-closed production startup", () => {
  function configureProductionLikeEnvironment() {
    process.env.NODE_ENV = "production";
    process.env.AUTH_MODE = "production";
    process.env.ALLOW_DEV_IDENTITY = "false";
    process.env.WEB_ORIGIN = "https://pharmacy.example.invalid";
    process.env.DOCUMENT_ENCRYPTION_KEY = "a".repeat(64);
    process.env.REQUIRE_SIGNED_BACKUPS = "true";
    process.env.BACKUP_SIGNING_KEY = "b".repeat(40);
  }

  it("rejects synthetic impersonation regardless of other settings", () => {
    configureProductionLikeEnvironment();
    process.env.ALLOW_DEV_IDENTITY = "true";
    expect(() => assertRuntimeSafetyConfiguration()).toThrow(
      "ALLOW_DEV_IDENTITY cannot be enabled in production",
    );
  });

  it("cannot be enabled for real dispensing by setting AUTH_MODE alone", () => {
    configureProductionLikeEnvironment();
    expect(() => assertRuntimeSafetyConfiguration()).toThrow(
      "Production startup remains prohibited",
    );
  });
});
