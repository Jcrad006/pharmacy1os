/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  const emptySummary = {
    total: 0,
    clinical: 0,
    onHold: 0,
    pharmacistReview: 0,
    scheduled: 0,
  };

  return {
    ...actual,
    getDevelopmentUsers: vi.fn(async () => [
      {
        externalAuthId: "dev-pharmacist",
        displayName: "Demo Pharmacist",
        role: "PHARMACIST",
      },
    ]),
    getPrescriptionQueue: vi.fn(async () => []),
    getWillCall: vi.fn(async () => []),
    getExceptions: vi.fn(async () => ({
      exceptions: [],
      summary: emptySummary,
    })),
    getPatients: vi.fn(async () => []),
    getPrescribers: vi.fn(async () => []),
    getMedications: vi.fn(async () => []),
    getInventoryBalances: vi.fn(async () => []),
    getCycleCounts: vi.fn(async () => []),
    getInventoryHolds: vi.fn(async () => []),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  localStorage.clear();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("primary workstation buttons", () => {
  it("changes screens when primary navigation buttons are clicked", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing root test element.");

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const destinations = [
      ["Exceptions", "Exceptions"],
      ["Will Call", "Will Call"],
      ["New Prescription", "New Prescription"],
      ["Patients", "Patients"],
      ["Providers", "Providers"],
      ["Drug / Product", "Drug / Product Catalog"],
      ["Receiving", "Inventory Receiving"],
      ["Inventory", "Inventory Ledger"],
      ["Dashboard", "Dispensing Dashboard"],
    ] as const;

    for (const [buttonText, expectedHeading] of destinations) {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes(buttonText),
      );

      expect(button, `Missing navigation button: ${buttonText}`).toBeTruthy();

      await act(async () => {
        button?.click();
        await Promise.resolve();
      });

      expect(container.querySelector("h1")?.textContent).toBe(expectedHeading);
    }
  });
});
