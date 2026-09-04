import { defineConfig } from "@playwright/test";

// End-to-end tests must never discover or launch a developer's authenticated live CLI.
// Tests that exercise provider selection inject their own deterministic registry explicitly.
process.env["LOOMRAIL_PROVIDER"] = "MOCK";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Longer than Playwright's 30s default because a mock delivery now reaches an IMPLEMENT stage
  // that cuts a real Git worktree first -- inspection, carry-in snapshot and `worktree add`, on top
  // of a demo workspace whose two fixtures are each copied out of this checkout and given their own
  // repository. Under `fullyParallel` several workers do all of that at once. Raised rather than
  // narrowed to the affected specs: a per-test budget that is wrong for the machine it runs on is
  // how a suite starts failing for reasons that have nothing to do with the product.
  // The cascading desktop/mobile filter scenario measured 59.7 s in two-worker stress repeats on
  // this machine while completing every assertion. Keep enough scheduling headroom for the
  // Git/SQLite-heavy setup without weakening the scenario or turning retries on locally.
  timeout: 90_000,
  // Capped, and not because the suite is slow. Playwright's default is half this machine's cores,
  // and under `fullyParallel` every one of those workers boots a daemon, materialises two fixture
  // repositories and cuts real Git worktrees. On a busy machine -- load average 105 on 10 cores,
  // measured -- that produced seven 60-second timeouts, then three, a different set each run, every
  // one of them passing in isolation; at load 5 the same suite passed in 17.8 s unchanged. Layout
  // assertions fail the same way for the same reason: a bounding box measured while a dialog is
  // still animating is fractionally off, and under load that is where the measurement lands. A
  // suite whose result depends on what else the machine is doing is not a signal, so this buys a
  // real answer under load for a few seconds on an idle machine. It is not a fix for a slow test:
  // no assertion is weakened and no timeout is raised to earn it.
  workers: 2,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3210",
    trace: "retain-on-failure",
  },
});
