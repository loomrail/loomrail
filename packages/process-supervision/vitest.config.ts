import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Windows taskkill/CIM startup is intentionally part of these integration tests. Five seconds
    // is not a meaningful hang detector on a loaded hosted runner; product deadlines remain asserted
    // by each test and by the supervisor's own bounded shutdown protocol.
    testTimeout: 30_000,
  },
});
