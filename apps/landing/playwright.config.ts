import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const portValue = process.env["LOOMRAIL_LANDING_TEST_PORT"] ?? "4177";
if (!/^\d{4,5}$/.test(portValue) || Number(portValue) < 1024 || Number(portValue) > 65535) {
  throw new Error("LOOMRAIL_LANDING_TEST_PORT must be a port between 1024 and 65535");
}
const baseURL = `http://127.0.0.1:${portValue}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL,
    colorScheme: "light",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm --filter @loomrail/landing build && pnpm --filter @loomrail/landing exec vite preview --host 127.0.0.1 --port ${portValue} --strictPort`,
    cwd: repositoryRoot,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
