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

  it("stores provider identity separately from multiple identifiers, contacts, and locations", async () => {
    const suffix = randomUUID().slice(0, 6);
    const lastName = `Provider${suffix}`;

    const created = await app.inject({
      method: "POST",
      url: "/api/prescribers",
      headers,
      payload: {
        firstName: "Morgan",
        lastName,
        practiceLevel: "NP",
        dateOfBirth: "1975-11-09",
        identifiers: [
          { type: "NPI", number: `7${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0")}`, isPrimary: true },
          { type: "DEA", number: "AB1234567", jurisdiction: "NC", isPrimary: true },
          { type: "DEA", number: "AB7654321", jurisdiction: "VA" },
          { type: "STATE_ID", number: "NC-STATE-9988", jurisdiction: "NC", isPrimary: true },
          { type: "STATE_ID", number: "VA-STATE-1122", jurisdiction: "VA" },
        ],
        contacts: [
          { type: "PHONE", label: "Main office", value: "(336) 555-3434", isPrimary: true },
          { type: "PHONE", label: "Direct", value: "336-555-7777", extension: "42" },
          { type: "FAX", label: "Main fax", value: "336-555-3435", isPrimary: true },
          { type: "FAX", label: "Satellite fax", value: "276-555-1000" },
        ],
        addresses: [
          {
            label: "Main office",
            addressLine1: "123 Clinical Way",
            addressLine2: "Suite 400",
            city: "Greensboro",
            state: "NC",
            postalCode: "27401",
            isPrimary: true,
          },
          {
            label: "Satellite",
            addressLine1: "456 Pharmacy Road",
            city: "Reidsville",
            state: "NC",
            postalCode: "27320",
          },
        ],
      },
    });

    expect(created.statusCode).toBe(201);
    const provider = created.json().prescriber;
    expect(provider.practiceLevel).toBe("NP");
    expect(provider.identifiers).toHaveLength(5);
    expect(provider.contacts).toHaveLength(4);
    expect(provider.addresses).toHaveLength(2);
    expect(provider.identifiers.some((item: { type: string; number: string }) => item.type === "NPI")).toBe(true);
    expect(provider.identifiers.filter((item: { type: string }) => item.type === "DEA")).toHaveLength(2);
    expect(provider.identifiers.filter((item: { type: string }) => item.type === "STATE_ID")).toHaveLength(2);
    expect(provider.contacts.filter((item: { type: string }) => item.type === "PHONE")).toHaveLength(2);
    expect(provider.contacts.filter((item: { type: string }) => item.type === "FAX")).toHaveLength(2);

    const id = provider.id as string;

    for (const url of [
      `/api/prescribers?lastName=${encodeURIComponent(lastName.slice(0, 8))}&firstName=Mor`,
      "/api/prescribers?dateOfBirth=1975-11-09",
      "/api/prescribers?phone=3365557777",
      "/api/prescribers?query=AB7654321",
      "/api/prescribers?query=VA-STATE-1122",
    ]) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().prescribers.some((item: { id: string }) => item.id === id)).toBe(true);
    }
  });
});
