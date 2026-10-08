import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm -C ../.. dev",
    url: "http://127.0.0.1:5173",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ALLOW_DEV_IDENTITY: "true",
      CLAIM_SANDBOX_ENABLED: "true",
      WEB_ORIGIN: "http://localhost:5173",
    },
  },
});
