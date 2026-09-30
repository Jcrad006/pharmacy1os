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

describe("patient and provider directory search", () => {
  it("searches patients by last/first name, DOB, and normalized phone", async () => {
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

    const byName = await app.inject({
      method: "GET",
      url: `/api/patients?lastName=${encodeURIComponent(lastName.slice(0, 7))}&firstName=Jam`,
      headers,
    });
    expect(byName.statusCode).toBe(200);
    expect(byName.json().patients.some((p: { id: string }) => p.id === created.json().patient.id)).toBe(true);

    const byDob = await app.inject({
      method: "GET",
      url: "/api/patients?dateOfBirth=07%2F14%2F1988",
      headers,
    });
    expect(byDob.statusCode).toBe(200);
    expect(byDob.json().patients.some((p: { id: string }) => p.id === created.json().patient.id)).toBe(true);

    const byPhone = await app.inject({
      method: "GET",
      url: "/api/patients?phone=3365551212",
      headers,
    });
    expect(byPhone.statusCode).toBe(200);
    expect(byPhone.json().patients.some((p: { id: string }) => p.id === created.json().patient.id)).toBe(true);
  });

  it("searches providers by last/first name, DOB, and normalized phone", async () => {
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

    const byName = await app.inject({
      method: "GET",
      url: `/api/prescribers?lastName=${encodeURIComponent(lastName.slice(0, 8))}&firstName=Mor`,
      headers,
    });
    expect(byName.statusCode).toBe(200);
    expect(byName.json().prescribers.some((p: { id: string }) => p.id === created.json().prescriber.id)).toBe(true);

    const byDob = await app.inject({
      method: "GET",
      url: "/api/prescribers?dateOfBirth=1975-11-09",
      headers,
    });
    expect(byDob.statusCode).toBe(200);
    expect(byDob.json().prescribers.some((p: { id: string }) => p.id === created.json().prescriber.id)).toBe(true);

    const byPhone = await app.inject({
      method: "GET",
      url: "/api/prescribers?phone=3365553434",
      headers,
    });
    expect(byPhone.statusCode).toBe(200);
    expect(byPhone.json().prescribers.some((p: { id: string }) => p.id === created.json().prescriber.id)).toBe(true);
  });
});
