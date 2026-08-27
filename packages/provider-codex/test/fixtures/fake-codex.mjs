#!/usr/bin/env node
/* eslint-disable no-undef -- spawned directly by `node`, outside the project's TS/vitest lint
   scope; `process`/`setInterval`/`setTimeout` are real Node globals, not undeclared names. */
// A stand-in for the real `codex` executable, used by the adapter tests in
// ../adapter.unit.test.ts. It never talks to a model. Depending on which environment variable the
// harness sets before spawning it, it does exactly one of:
//
//   FAKE_CODEX_HANG_MARKER_PATH -- write { pid: process.pid } to the given file, then hang
//                                  (nothing else) until killed. Used to test that abortSession
//                                  really waits for the child to exit.
//   FAKE_CODEX_RECORD_PATH      -- write { args, stdinClosed } (this process's own argv and
//                                  whether its stdin was closed by the parent) to the given file,
//                                  then exit. Used to inspect exactly what the adapter under test
//                                  launched it with.
//   FAKE_CODEX_OUTPUT_FILE      -- write the contents of the given file to stdout verbatim,
//                                  standing in for a real `codex exec --json` recording, then
//                                  exit.
//
// The hang mode aside, this never hangs: the real `codex exec` hangs forever on an open stdin,
// which is exactly the defect one of the adapter's tests exists to catch, so this stand-in cannot
// itself rely on an unbounded wait for the same event -- a bug in the adapter must fail that
// test's assertion, not the whole suite via a runner timeout.
import { readFileSync, writeFileSync } from "node:fs";

const hangMarkerPath = process.env.FAKE_CODEX_HANG_MARKER_PATH;

if (hangMarkerPath !== undefined) {
  writeFileSync(hangMarkerPath, JSON.stringify({ pid: process.pid }));
  setInterval(() => {}, 1_000);
} else {
  const recordPath = process.env.FAKE_CODEX_RECORD_PATH;
  const outputFile = process.env.FAKE_CODEX_OUTPUT_FILE;

  let finished = false;
  let stdinClosed = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    // Releases the event-loop reference `process.stdin.resume()` below takes. Without it, exiting
    // via `process.exitCode` (rather than `process.exit`, which would truncate the pipe write
    // beneath) would never happen on the path where the parent leaves stdin open -- and that path
    // is a regression one of the adapter tests exists to catch, so it has to fail by assertion, not
    // by hanging until the runner gives up.
    process.stdin.pause();
    if (recordPath !== undefined) {
      writeFileSync(recordPath, JSON.stringify({ args: process.argv.slice(2), stdinClosed }));
    }
    if (outputFile !== undefined) {
      process.stdout.write(readFileSync(outputFile, "utf8"));
    }
    // `process.exitCode`, never `process.exit(0)`: a pipe write is asynchronous on POSIX, and
    // `process.exit` tears the process down without waiting for the pipe to drain -- a recording
    // larger than the pipe buffer would be truncated, and the adapter under test would see a
    // stream ending mid-line for reasons that have nothing to do with the adapter. Setting the
    // code lets the event loop empty naturally and exit on its own.
    process.exitCode = 0;
  };

  process.stdin.on("end", () => {
    stdinClosed = true;
    finish();
  });
  process.stdin.resume();

  // Fallback so a run where stdin is never closed (the very regression the stdin test guards
  // against) still finishes quickly, with `stdinClosed` left false, instead of hanging until the
  // test runner's own timeout fires.
  setTimeout(finish, 500).unref();
}
