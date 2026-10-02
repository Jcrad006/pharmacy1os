import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]);
    return Object.fromEntries(entries);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot fingerprint non-finite number.");
    return value;
  }
  return value;
}

export function requestFingerprint(scope: string, value: unknown) {
  const canonical = JSON.stringify({
    scope,
    value: canonicalize(value),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function stableOperationKey(prefix: string, fingerprint: string) {
  return `${prefix}-${fingerprint}`;
}
