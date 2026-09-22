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
    // Raised from 60s when the populated-v60 migration test started crossing it on Windows, and
    // kept at 120s now that the same test no longer comes near it. That earlier note left the
    // Windows cost as an open question and guessed at the migration chain; the answer turned out to
    // be neither. The skew -- 0.77s on macOS against 19.8s, 28.4s and then 68s on Windows, ending
    // in a timeout on run 35641932385 -- was that one test's own fixture loop, which replayed
    // migrations 1..60 in autocommit on a connection left in SQLite's default DELETE journal. That
    // is ~950 transactions, each creating, fsyncing and unlinking a journal file, which is the
    // operation a Windows runner's filter drivers charge most for; the cost tracked statement count
    // and runner load, never chain length. The two tests beside it migrate the longer 1..62 chain
    // through `openLocalState` -- WAL, one transaction per migration, and the only path production
    // upgrades take -- in about two seconds each on that same runner. Batching the fixture into a
    // single transaction returned the test to ~0.2s on macOS, so a new migration no longer pushes
    // this number. 120s stays because it must still cover this package's Git, worktree and process
    // tests on Windows, which have not been measured the same way, and matches what
    // @loomrail/process-supervision already allows for the same reason.
    testTimeout: 120_000,
    // Each file opens real SQLite databases and several also spawn Git. Running them concurrently
    // creates avoidable I/O contention on developer machines and CI runners; one worker keeps the
    // integration boundary deterministic without widening any production or per-test deadline.
    maxWorkers: 1,
  },
});
