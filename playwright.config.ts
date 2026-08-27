import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Longer than Playwright's 30s default because a mock delivery now reaches an IMPLEMENT stage
  // that cuts a real Git worktree first -- inspection, carry-in snapshot and `worktree add`, on top
  // of a demo workspace whose two fixtures are each copied out of this checkout and given their own
  // repository. Under `fullyParallel` several workers do all of that at once. Raised rather than
  // narrowed to the affected specs: a per-test budget that is wrong for the machine it runs on is
  // how a suite starts failing for reasons that have nothing to do with the product.
  timeout: 60_000,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3210",
    trace: "retain-on-failure",
  },
});
