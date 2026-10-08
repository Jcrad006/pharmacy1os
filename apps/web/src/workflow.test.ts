import { describe, expect, it } from "vitest";
import type { DevUser, PrescriptionStatus, UserRole } from "./types";
import { canCorrectInventory, canDocumentClinical, canVerify, canWriteInventory, prioritizeQueueByStatus } from "./workflow";

type Item = {
  id: string;
  status: PrescriptionStatus;
};

describe("queue priority preference", () => {
  const items: Item[] = [
    { id: "a", status: "DATA_ENTRY" },
    { id: "b", status: "PHARMACIST_REVIEW" },
    { id: "c", status: "PRODUCT_FILL" },
    { id: "d", status: "PHARMACIST_REVIEW" },
    { id: "e", status: "DUR_REVIEW" },
  ];

  it("pins the selected workflow status while preserving relative order", () => {
    expect(
      prioritizeQueueByStatus(items, "PHARMACIST_REVIEW").map(
        (item) => item.id,
      ),
    ).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("returns the same order when no priority is configured", () => {
    expect(prioritizeQueueByStatus(items, "").map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("does not mutate the server-provided queue order", () => {
    const original = items.map((item) => item.id);
    prioritizeQueueByStatus(items, "PRODUCT_FILL");
    expect(items.map((item) => item.id)).toEqual(original);
  });
});


describe("Stage 3M site role workstation capability hints", () => {
  function staff(role: UserRole): DevUser {
    return {
      externalAuthId: "authenticated", displayName: role, role,
      siteId: "site-demo-001", siteName: "Synthetic Pharmacy",
    };
  }

  it("allows inventory managers to receive and correct stock, not verify prescriptions", () => {
    expect(canWriteInventory(staff("INVENTORY_MANAGER"))).toBe(true);
    expect(canCorrectInventory(staff("INVENTORY_MANAGER"))).toBe(true);
    expect(canVerify(staff("INVENTORY_MANAGER"))).toBe(false);
    expect(canDocumentClinical(staff("INVENTORY_MANAGER"))).toBe(false);
  });

  it("gives PICs pharmacist workstation access without granting interns inventory correction", () => {
    expect(canVerify(staff("PHARMACIST_IN_CHARGE"))).toBe(true);
    expect(canDocumentClinical(staff("PHARMACIST_IN_CHARGE"))).toBe(true);
    expect(canCorrectInventory(staff("PHARMACIST_IN_CHARGE"))).toBe(true);
    expect(canWriteInventory(staff("INTERN"))).toBe(false);
    expect(canCorrectInventory(staff("INTERN"))).toBe(false);
  });
});


describe("Stage 3M.3 elevated inventory controls", () => {
  const technician = {
    externalAuthId: "authenticated", id: "user-tech",
    displayName: "Synthetic technician", role: "TECHNICIAN" as const,
    siteId: "site-demo-001", siteName: "Demo",
  };
  it("exposes an approved temporary correction only before its expiry", () => {
    const granted = {
      ...technician,
      temporaryPermissions: ["inventory:correct"],
      temporaryPermissionExpiresAt: {
        "inventory:correct": new Date(Date.now() + 60_000).toISOString(),
      },
    };
    expect(canCorrectInventory(technician)).toBe(false);
    expect(canCorrectInventory(granted)).toBe(true);
    expect(canCorrectInventory({
      ...granted, temporaryPermissionExpiresAt: {
        "inventory:correct": new Date(Date.now() - 60_000).toISOString(),
      },
    })).toBe(false);
  });
});
