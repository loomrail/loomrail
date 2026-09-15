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
    //
    // Raised from 60s once the migration chain reached 0062. The populated-v60 migration test is
    // the worst case and is wildly platform-skewed: 0.77s on a macOS runner against 19.8s and
    // 28.4s on two consecutive Windows runs of the same commit, then 68s once one more migration
    // was appended. The Windows cost is neither in the new migration (it creates two tables and an
    // index, and does not set `rebuildsAReferencedTable`, so it triggers no `foreign_key_check`)
    // nor proportional to the work added -- it is the runner's filesystem, and it deserves its own
    // investigation rather than a number chosen to stay ahead of it. 120s matches what
    // @loomrail/process-supervision already allows for the same reason.
    testTimeout: 120_000,
    // Each file opens real SQLite databases and several also spawn Git. Running them concurrently
    // creates avoidable I/O contention on developer machines and CI runners; one worker keeps the
    // integration boundary deterministic without widening any production or per-test deadline.
    maxWorkers: 1,
  },
});
