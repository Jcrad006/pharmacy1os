import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("health route", () => {
  it("returns an ok health status", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "pharmacy1os-api"
    });

    await app.close();
  });
});
