import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every test in this package spawns chains of real `git` subprocesses, and several agents in
    // this repository run their own test suites in parallel, so machine load alone can push a
    // perfectly correct test past vitest's 5s default. A test that goes red by timing out proves
    // nothing about the code under test -- it must fail by assertion, on the defect it names, or
    // not at all. The bound below is generous headroom against load, not a tolerance for slow code.
    testTimeout: 30_000,
  },
});
