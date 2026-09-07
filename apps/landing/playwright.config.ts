import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4177",
    colorScheme: "light",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm --filter @loomrail/landing build && pnpm --filter @loomrail/landing exec vite preview --host 127.0.0.1 --port 4177 --strictPort",
    cwd: repositoryRoot,
    url: "http://127.0.0.1:4177",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
