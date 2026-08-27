import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

// The defect this pins is a race that real git will not reliably reproduce on demand: `git
// rev-parse --show-toplevel` succeeding and THEN `git rev-parse --git-dir` failing on the very
// same path a moment later (the repository vanishing, losing permissions, or similar mid-
// inspection). `repository.integration.test.ts` drives real repositories for everything real git
// can be made to do honestly; this one property needs the low-level process boundary faked
// instead, so this file fakes it -- same seam and same rationale as
// `provider-core/test/process-runner-ordering.unit.test.ts`, which mocks `node:child_process` for
// exactly the same reason: pinning an exact sequence of process events that a real child will not
// reliably produce to order. Mocking `node:child_process` rather than this package's own `git.ts`
// keeps `runGit`'s real argv-building and stdout/stderr-collecting logic under test; only the
// process itself is fake.
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

const { inspectRepository } = await import("../src/repository.js");

class FakeGitProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

const FAKE_TOPLEVEL = "/fake/repo";
const FAKE_HEAD = "a".repeat(40);

// Answers each `git` invocation the fake process is asked to make based on its argv, exactly the
// way the real CLI would answer -- `--show-toplevel` and `rev-parse HEAD` both succeed, and
// `--git-dir` (whichever call it is) fails, standing in for the environment changing mid-
// inspection. Delivered on a microtask so the emit happens after `runGit` has already attached its
// `stdout`/`stderr`/`close` listeners, the same way a real child's IO always arrives later than the
// synchronous `spawn()` call that creates it.
const answerGitDirFailureAfterToplevelSucceeds = (): void => {
  spawn.mockImplementation((_command: string, args: readonly string[]) => {
    const child = new FakeGitProcess();
    queueMicrotask(() => {
      if (args.includes("--show-toplevel")) {
        child.stdout.emit("data", Buffer.from(`${FAKE_TOPLEVEL}\n`));
        child.emit("close", 0, null);
      } else if (args.includes("--git-dir")) {
        child.stderr.emit("data", Buffer.from("fatal: unable to resolve git dir\n"));
        child.emit("close", 128, null);
      } else if (args[0] === "rev-parse" && args[1] === "HEAD") {
        child.stdout.emit("data", Buffer.from(`${FAKE_HEAD}\n`));
        child.emit("close", 0, null);
      } else {
        throw new Error(`unexpected git invocation in this test: ${args.join(" ")}`);
      }
    });
    return child;
  });
};

describe("inspectRepository fails closed when the in-progress check cannot complete", () => {
  it("reports null rather than a state with inProgress defaulted to clear", async () => {
    answerGitDirFailureAfterToplevelSucceeds();

    const state = await inspectRepository("/fake/repo");

    // The point of the fix: a caller must never receive a state that quietly claims "nothing in
    // progress" because the check that would have proven it could not run. `null` is the same
    // answer this function gives for a path that is not a repository at all -- "not a usable
    // repository" -- so the caller refuses to provision a workspace rather than basing one on an
    // in-progress check that never actually happened.
    expect(state).toBeNull();
  });
});
