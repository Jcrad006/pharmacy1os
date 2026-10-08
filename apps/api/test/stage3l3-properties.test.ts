import { describe, expect, it } from "vitest";
import { parseBarcode } from "../src/barcode.js";
import { requestFingerprint, stableOperationKey } from "../src/idempotency.js";
import {
  allowedTransitions,
  canTransitionPrescription,
} from "../src/workflow/prescriptionWorkflow.js";

// Fixed-seed stress tests are repeatable in CI; log the seed when extending a case.
function pseudoRandom(seed: number) {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function addCheckDigit(body: string) {
  let sum = 0;
  let triple = true;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * (triple ? 3 : 1);
    triple = !triple;
  }
  return body + ((10 - (sum % 10)) % 10);
}

const statuses = [
  "RECEIVED", "DATA_ENTRY", "DUR_REVIEW", "PRODUCT_FILL",
  "PHARMACIST_REVIEW", "READY", "SOLD", "ON_HOLD",
  "CANCELLED", "TRANSFERRED",
] as const;

describe("Stage 3L.3 deterministic properties", () => {
  it("validates thousands of UPC, EAN and GTIN check digits and rejects tampering", () => {
    const random = pseudoRandom(0x31a3001);
    for (const length of [11, 12, 13]) {
      for (let sample = 0; sample < 350; sample += 1) {
        const body = Array.from({ length }, () => Math.floor(random() * 10)).join("");
        const code = addCheckDigit(body);
        expect(parseBarcode(code)?.identifier).toBe(code);
        const tampered = code.slice(0, -1) + ((Number(code.at(-1)) + 1) % 10);
        expect(parseBarcode(tampered)).toBeNull();
      }
    }
  });

  it("round trips GS1 fields including serial, lot and end-of-month dates", () => {
    const random = pseudoRandom(0x31a3002);
    for (let index = 0; index < 250; index += 1) {
      const body = Array.from({ length: 13 }, () => Math.floor(random() * 10)).join("");
      const gtin = addCheckDigit(body);
      const lot = "LOT" + index;
      const serial = "SER" + index;
      const input = "(01)" + gtin + "(17)300400(10)" + lot + "(21)" + serial;
      const result = parseBarcode(input);
      expect(result?.format).toBe("GS1");
      expect(result?.gtin).toBe(gtin);
      expect(result?.lotNumber).toBe(lot);
      expect(result?.serialNumber).toBe(serial);
      expect(result?.expirationDate?.toISOString()).toBe("2030-04-30T00:00:00.000Z");
    }
  });

  it("canonicalizes equivalent nested payloads without losing scope isolation", () => {
    const random = pseudoRandom(0x31a3003);
    for (let index = 0; index < 400; index += 1) {
      const amount = Math.floor(random() * 500000) / 1000;
      const first = {
        fillId: "fill-" + index,
        sources: [{ quantity: amount, lot: "A" }, { lot: "B", quantity: 0 }],
        metadata: { fingerprintVersion: 1, operation: "SUBMIT" },
      };
      const reordered = {
        metadata: { operation: "SUBMIT", fingerprintVersion: 1 },
        sources: [{ lot: "A", quantity: amount }, { quantity: 0, lot: "B" }],
        fillId: "fill-" + index,
      };
      const a = requestFingerprint("claim", first);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
      expect(a).toBe(requestFingerprint("claim", reordered));
      expect(a).not.toBe(requestFingerprint("pos", reordered));
      expect(stableOperationKey("submit", a)).toBe("submit-" + a);
      expect(a).not.toBe(requestFingerprint("claim", { ...first, fillId: "other" }));
    }
    expect(() => requestFingerprint("claim", { amount: Number.NaN })).toThrow();
    expect(() => requestFingerprint("claim", { amount: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("has internally consistent state transitions, including held-state restoration", () => {
    for (const from of statuses) {
      for (const to of statuses) {
        const allowed = allowedTransitions(from, from === "ON_HOLD" ? "DUR_REVIEW" : null);
        expect(canTransitionPrescription(from, to, from === "ON_HOLD" ? "DUR_REVIEW" : null))
          .toBe(allowed.includes(to));
        if (from === "CANCELLED" || from === "TRANSFERRED") expect(allowed).toEqual([]);
      }
    }
    expect(canTransitionPrescription("ON_HOLD", "PRODUCT_FILL", "DUR_REVIEW")).toBe(false);
    expect(canTransitionPrescription("PHARMACIST_REVIEW", "READY")).toBe(true);
    expect(canTransitionPrescription("PRODUCT_FILL", "READY")).toBe(false);
  });
});
