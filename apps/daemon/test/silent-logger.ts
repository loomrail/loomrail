import type { FastifyBaseLogger } from "fastify";

// A FastifyBaseLogger that discards everything. Shared by every test that needs a logger but is
// asserting on behaviour, not on what got logged.
//
// Deliberately not a `.test.ts` file: vitest's `include` globs only pick up `*.unit.test.ts` and
// `*.integration.test.ts` (see vitest.config.ts), and importing a module that vitest does treat as
// a test file re-executes its top-level `describe` blocks in the importer's own test run. Keeping
// this constant in a plain module lets more than one test file share it without that side effect.
const noop = (): void => undefined;
export const silentLogger: FastifyBaseLogger = {
  level: "silent",
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  silent: noop,
  child: () => silentLogger,
};
