/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClinicalPanel } from "./ClinicalPanel";
import type { DevUser, PrescriptionQueueItem } from "../types";

const mocks = vi.hoisted(() => ({ getClinicalRecord: vi.fn() }));
vi.mock("../api", () => ({
  getClinicalRecord: mocks.getClinicalRecord,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const rx = {
  id: "synthetic-rx-one",
  updatedAt: "2026-10-08T10:00:00.000Z",
  expirationDate: null,
  minimumDaysBetweenFills: null,
  doNotFillBefore: null,
} as unknown as PrescriptionQueueItem;

const technician = { role: "TECHNICIAN" } as DevUser;
const pharmacist = { role: "PHARMACIST" } as DevUser;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("clinical verification gate on identity changes", () => {
  it("fails closed until current clinical data arrives and ignores a late response from the previous staff identity", async () => {
    const oldRequest = deferred<{ issues: Array<{ status: string; severity: string }>; interventions: [] }>();
    const newRequest = deferred<{ issues: Array<{ status: string; severity: string }>; interventions: [] }>();
    mocks.getClinicalRecord.mockImplementation((devUser: string) =>
      devUser === "dev-technician" ? oldRequest.promise : newRequest.promise,
    );
    const gate = vi.fn<(count: number | null) => void>();
    const container = document.createElement("div");
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <ClinicalPanel prescription={rx} devUser="dev-technician" user={technician}
          onChanged={async () => {}} onError={vi.fn()} onBlockersChanged={gate} />,
      );
    });
    expect(gate).toHaveBeenLastCalledWith(null);

    await act(async () => {
      root?.render(
        <ClinicalPanel prescription={rx} devUser="dev-pharmacist" user={pharmacist}
          onChanged={async () => {}} onError={vi.fn()} onBlockersChanged={gate} />,
      );
    });
    expect(gate).toHaveBeenLastCalledWith(null);

    await act(async () => {
      newRequest.resolve({ issues: [], interventions: [] });
      await newRequest.promise;
    });
    expect(gate).toHaveBeenLastCalledWith(0);

    await act(async () => {
      oldRequest.resolve({ issues: [{ status: "OPEN", severity: "HIGH" }], interventions: [] });
      await oldRequest.promise;
    });
    // The old technician response must not replace the current pharmacist result.
    expect(gate).toHaveBeenLastCalledWith(0);
    expect(container.textContent).toContain("No open DUR issues");
  });
});
