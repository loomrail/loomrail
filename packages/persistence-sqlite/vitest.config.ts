import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // This package exercises real SQLite databases, migrations, Git repositories, worktrees and
    // OS processes. On Windows runners, successful cases routinely approach Vitest's 5s default;
    // a timeout there aborts cleanup while a database is still open and turns one slow test into a
    // cascade of EBUSY failures. Assertions that are actually about time keep their own explicit
    // bounds, so this package-level timeout remains a hang detector rather than a performance claim.
    testTimeout: 20_000,
  },
});
