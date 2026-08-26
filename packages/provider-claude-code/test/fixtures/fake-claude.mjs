#!/usr/bin/env node
/* eslint-disable no-undef -- spawned directly by `node`, outside the project's TS/vitest lint
   scope; `process`/`setInterval`/`setTimeout` are real Node globals, not undeclared names. */
// A stand-in for the real `claude` executable, used by the adapter tests in
// ../adapter.unit.test.ts. It never talks to a model. Depending on which environment variable the
// harness sets before spawning it, it does exactly one of:
//
//   FAKE_CLAUDE_HANG_MARKER_PATH -- write { pid: process.pid } to the given file, then hang
//                                   (nothing else) until killed. Used to test that abortSession
//                                   really waits for the child to exit.
//   FAKE_CLAUDE_RECORD_PATH      -- write { args, cwd } (this process's own argv and its working
//                                   directory) to the given file, then exit. Used to inspect
//                                   exactly what the adapter under test launched it with -- `cwd`
//                                   specifically so a test can learn the adapter's per-session
//                                   temp directory without having to infer it from an argument's
//                                   value (nothing on the command line is a path any more; see
//                                   the `--json-schema` fix this fixture was extended for).
//   FAKE_CLAUDE_OUTPUT_FILE      -- write the contents of the given file to stdout verbatim,
//                                   standing in for a real `claude -p --output-format stream-json`
//                                   recording, then exit.
//
// Mirrors provider-codex's fake-codex.mjs (same shape, same reasoning): the hang mode aside, this
// never hangs on its own -- a bug in the adapter under test must fail that test's assertion, not
// the whole suite via a runner timeout.
import { readFileSync, writeFileSync } from "node:fs";

const hangMarkerPath = process.env.FAKE_CLAUDE_HANG_MARKER_PATH;

if (hangMarkerPath !== undefined) {
  writeFileSync(hangMarkerPath, JSON.stringify({ pid: process.pid }));
  setInterval(() => {}, 1_000);
} else {
  const recordPath = process.env.FAKE_CLAUDE_RECORD_PATH;
  const outputFile = process.env.FAKE_CLAUDE_OUTPUT_FILE;

  // Unlike fake-codex.mjs, this stand-in never needs to wait on stdin: nothing in the adapter
  // under test depends on when (or whether) this process's stdin closes, so there is no event to
  // defer to -- writing the record/output and exiting can happen synchronously, right here.
  if (recordPath !== undefined) {
    writeFileSync(recordPath, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
  }
  if (outputFile !== undefined) {
    process.stdout.write(readFileSync(outputFile, "utf8"));
  }
  process.exit(0);
}
