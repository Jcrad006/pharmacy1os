import { describe, expect, it } from "vitest";
import type { PrescriptionStatus } from "./types";
import { prioritizeQueueByStatus } from "./workflow";

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
