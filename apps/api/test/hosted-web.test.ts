import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("hosted workstation runtime", () => {
  it("serves the built workstation and preserves API routing", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "pharmacy1os-web-"));
    createdDirectories.push(webRoot);
    await mkdir(join(webRoot, "assets"));
    await writeFile(
      join(webRoot, "index.html"),
      "<!doctype html><html><body><div id=\"root\">Pharmacy1OS</div></body></html>",
    );
    await writeFile(join(webRoot, "assets", "app.js"), "console.log('ok');");

    const app = buildApp({ serveWeb: true, webDistPath: webRoot });
    await app.ready();

    const home = await app.inject({ method: "GET", url: "/" });
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
    expect(home.body).toContain("Pharmacy1OS");

    const asset = await app.inject({
      method: "GET",
      url: "/assets/app.js",
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.body).toContain("console.log");

    const clientRoute = await app.inject({
      method: "GET",
      url: "/prescriptions/demo",
    });
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.body).toContain("Pharmacy1OS");

    const missingApi = await app.inject({
      method: "GET",
      url: "/api/definitely-not-a-route",
    });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toEqual({ error: "Route not found." });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    await app.close();
  });
});
