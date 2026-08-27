import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/**/*.unit.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["test/**/*.integration.test.ts"],
          // These start real HTTP servers, open real SQLite files and -- since registration
          // materialises a bundled fixture as a real repository -- spawn `git`. Vitest's 5s default
          // was calibrated to a suite that did none of that. Raised deliberately rather than per
          // test, because every assertion in here that is actually about time (a handler answering
          // before its stage finishes, a boot pass not blocking `listen`) races its own explicit
          // budget and reports by assertion; this timeout only ever catches a hang.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
