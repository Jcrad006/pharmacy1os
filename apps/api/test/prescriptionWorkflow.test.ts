import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canTransitionPrescription,
  permissionForTransition,
} from "../src/workflow/prescriptionWorkflow.js";

describe("prescription workflow", () => {
  it("supports the normal dispensing path", () => {
    expect(canTransitionPrescription("DATA_ENTRY", "DUR_REVIEW")).toBe(true);
    expect(canTransitionPrescription("DUR_REVIEW", "PRODUCT_FILL")).toBe(true);
    expect(canTransitionPrescription("PRODUCT_FILL", "PHARMACIST_REVIEW")).toBe(true);
    expect(canTransitionPrescription("PHARMACIST_REVIEW", "READY")).toBe(true);
    expect(canTransitionPrescription("READY", "SOLD")).toBe(true);
  });

  it("does not allow skipping pharmacist review", () => {
    expect(canTransitionPrescription("PRODUCT_FILL", "READY")).toBe(false);
  });

  it("requires pharmacist verification permission to move review to ready", () => {
    expect(permissionForTransition("PHARMACIST_REVIEW", "READY")).toBe("prescription:verify");
    expect(permissionForTransition("PRODUCT_FILL", "PHARMACIST_REVIEW")).toBe("prescription:process");
  });

  it("treats sold prescriptions as terminal in the workflow", () => {
    expect(allowedTransitions("SOLD")).toEqual([]);
  });
});
