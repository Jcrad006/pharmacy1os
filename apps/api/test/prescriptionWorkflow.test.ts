import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canTransitionPrescription,
  permissionForTransition,
} from "../src/workflow/prescriptionWorkflow.js";

describe("prescription workflow", () => {
  it("requires a fill action between DUR review and product fill", () => {
    expect(canTransitionPrescription("DATA_ENTRY", "DUR_REVIEW")).toBe(true);
    expect(canTransitionPrescription("DUR_REVIEW", "PRODUCT_FILL")).toBe(false);
    expect(canTransitionPrescription("PRODUCT_FILL", "PHARMACIST_REVIEW")).toBe(true);
  });

  it("does not allow skipping pharmacist review", () => {
    expect(canTransitionPrescription("PRODUCT_FILL", "READY")).toBe(false);
  });

  it("requires pharmacist verification permission to move review to ready", () => {
    expect(permissionForTransition("PHARMACIST_REVIEW", "READY")).toBe(
      "prescription:verify",
    );
  });

  it("uses a sale-specific permission to move ready to sold", () => {
    expect(permissionForTransition("READY", "SOLD")).toBe("prescription:sell");
  });

  it("only resumes a held prescription to its recorded prior state", () => {
    expect(allowedTransitions("ON_HOLD", "DUR_REVIEW")).toEqual([
      "DUR_REVIEW",
      "CANCELLED",
      "TRANSFERRED",
    ]);
    expect(canTransitionPrescription("ON_HOLD", "PRODUCT_FILL", "DUR_REVIEW")).toBe(
      false,
    );
  });

  it("allows a sold prescription to begin refill review", () => {
    expect(canTransitionPrescription("SOLD", "DUR_REVIEW")).toBe(true);
  });
});
