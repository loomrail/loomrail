import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // This package exercises real SQLite databases, migrations, Git repositories, worktrees and
    // OS processes. On Windows runners, successful cases can exceed 20s under filesystem and
    // security-scanner load; timing out there aborts cleanup while the database is still open and
    // turns one slow test into a cascade of EBUSY failures. Assertions that are actually about time
    // keep their own explicit bounds, so this package-level timeout remains a hang detector rather
    // than a performance claim.
    testTimeout: 60_000,
    // Each file opens real SQLite databases and several also spawn Git. Running them concurrently
    // creates avoidable I/O contention on developer machines and CI runners; one worker keeps the
    // integration boundary deterministic without widening any production or per-test deadline.
    maxWorkers: 1,
  },
});
