import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const headers = { "x-dev-user": "dev-technician" };

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe("structured patient and provider directory search", () => {
  it("finds a patient by last/first prefix, DOB, and normalized phone", async () => {
    const suffix = randomUUID().slice(0, 6);
    const lastName = `Lookup${suffix}`;

    const created = await app.inject({
      method: "POST",
      url: "/api/patients",
      headers,
      payload: {
        firstName: "Jamie",
        lastName,
        dateOfBirth: "1988-07-14T00:00:00.000Z",
        phone: "(336) 555-1212",
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().patient.id as string;

    for (const url of [
      `/api/patients?lastName=${encodeURIComponent(lastName.slice(0, 7))}&firstName=Jam`,
      "/api/patients?dateOfBirth=07%2F14%2F1988",
      "/api/patients?phone=3365551212",
    ]) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().patients.some((item: { id: string }) => item.id === id)).toBe(true);
    }
  });

  it("finds a provider by last/first prefix, DOB, and normalized phone", async () => {
    const suffix = randomUUID().slice(0, 6);
    const lastName = `Provider${suffix}`;

    const created = await app.inject({
      method: "POST",
      url: "/api/prescribers",
      headers,
      payload: {
        firstName: "Morgan",
        lastName,
        dateOfBirth: "1975-11-09",
        phone: "336.555.3434",
        npi: `7${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0")}`,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().prescriber.id as string;

    for (const url of [
      `/api/prescribers?lastName=${encodeURIComponent(lastName.slice(0, 8))}&firstName=Mor`,
      "/api/prescribers?dateOfBirth=1975-11-09",
      "/api/prescribers?phone=3365553434",
    ]) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().prescribers.some((item: { id: string }) => item.id === id)).toBe(true);
    }
  });
});
