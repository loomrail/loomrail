import { humanRequestDraftSchema } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { describeUnproductiveSession, type UnproductiveSessionReport } from "../src/index.js";

const report = (overrides: Partial<UnproductiveSessionReport> = {}): UnproductiveSessionReport => ({
  provider: "CODEX",
  command: "codex",
  reason: "NO_STRUCTURED_RESULT",
  exitCode: 0,
  signal: null,
  linesReceived: 4,
  linesUnused: 4,
  providerText: null,
  ...overrides,
});

// Asserts -- rather than merely narrows -- so that a regression reads as a failed assertion instead
// of a thrown Error.
const requestOf = (outcome: ReturnType<typeof describeUnproductiveSession>) => {
  expect(outcome).toMatchObject({ type: "NEEDS_HUMAN" });
  if (outcome.type !== "NEEDS_HUMAN") throw new Error("unreachable: asserted immediately above");
  return outcome.request;
};

describe("describeUnproductiveSession", () => {
  it("marks a structured provider 429 with a typed owner-action reason", () => {
    const outcome = describeUnproductiveSession(report({ reason: "PROVIDER_RATE_LIMITED" }));

    expect(outcome).toMatchObject({ type: "NEEDS_HUMAN", reason: "PROVIDER_RATE_LIMITED" });
    if (outcome.type !== "NEEDS_HUMAN") throw new Error("expected a provider owner action");
    expect(outcome.request.blocking).toBe(true);
    expect(outcome.request.title).toContain("provider rate limit");
    expect(outcome.request.recommendation).toContain("does not resume work by itself");
  });

  it("asks a blocking, out-of-band question with no options to choose from", () => {
    const request = requestOf(describeUnproductiveSession(report()));
    expect(request.blocking).toBe(true);
    expect(request.kind).toBe("FREE_TEXT");
    expect(request.options).toEqual([]);
    expect(request.allowOther).toBe(true);
  });

  // The counts are the whole point: the diagnosis that would have made this milestone's Criticals
  // loud is "four hundred lines arrived and none of them meant anything".
  it("states how many lines arrived and how many carried nothing", () => {
    const request = requestOf(describeUnproductiveSession(report({ linesReceived: 400, linesUnused: 400 })));
    expect(request.context).toContain("Lines received from the CLI: 400");
    expect(request.context).toContain("400 carried nothing this adapter could use");
  });

  // R7. A Codex session with write access emits an `item.started` for every item plus
  // `command_execution` and `file_change` items for the work itself: six of the eleven lines of a
  // real successful run, every one of them understood and deliberately unused. Stated as a single
  // figure, a failed session of that shape reads as a broken parser and sends whoever is diagnosing
  // it to the wrong place. The second number is what clears the parser.
  it("separates the lines it could not read from the lines it read and did not need", () => {
    const request = requestOf(
      describeUnproductiveSession(report({ linesReceived: 11, linesUnused: 6, linesUnreadable: 0 })),
    );
    expect(request.context).toContain("6 carried nothing this adapter could use");
    expect(request.context).toContain("0 of them could not be read at all");
  });

  // The other half of the same rule: an adapter whose parser cannot tell the two apart -- and
  // `provider-claude-code`'s cannot, it returns null both for an unreadable line and for the events
  // it drops by design -- omits the field, and the diagnosis then makes no claim about a number
  // nobody measured rather than printing a zero that would clear a parser it never checked.
  it("makes no claim about unreadable lines when the adapter cannot tell them apart", () => {
    const request = requestOf(describeUnproductiveSession(report({ linesReceived: 11, linesUnused: 6 })));
    expect(request.context).toContain("6 carried nothing this adapter could use.");
    expect(request.context).not.toContain("could not be read at all");
  });

  it("names the signal that ended the process rather than inventing an exit code", () => {
    const request = requestOf(describeUnproductiveSession(report({ exitCode: null, signal: "SIGKILL" })));
    expect(request.context).toContain("killed by SIGKILL");
  });

  it("says plainly when the CLI offered no diagnostic of its own", () => {
    const request = requestOf(describeUnproductiveSession(report({ providerText: null })));
    expect(request.context).toContain("printed no diagnostic of its own");
  });

  // Provider output is untrusted process text. A chatty (or hostile) CLI must not be able to push
  // the request past `descriptionSchema`'s own 4000-character limit and turn a failed session into
  // a validation error deep inside the daemon's `execute`.
  it("truncates the provider's own text and still produces a request the contract accepts", () => {
    const build = (): ReturnType<typeof describeUnproductiveSession> =>
      describeUnproductiveSession(
        report({ reason: "PROVIDER_REPORTED_FAILURE", providerText: "z".repeat(50_000) }),
      );
    // Asserted as "does not throw" before the outcome is read: the builder validates the draft it
    // returns, so an untruncated context fails inside it, and a bare call would report that as a
    // crashed test rather than a failed assertion.
    expect(build).not.toThrow();
    const request = requestOf(build());
    expect(request.context).toContain("…");
    // Well under the contract's own 4000: the provider's text is bounded on its own, not merely
    // clipped along with everything else once the whole context is already too long.
    expect(request.context.length).toBeLessThan(2_500);
    expect(() => humanRequestDraftSchema.parse(request)).not.toThrow();
  });

  // The truncation cuts by UTF-16 code unit, and an emoji in a provider's own error message is not
  // exotic. Cutting between the halves of one leaves an ill-formed string: the owner sees a
  // replacement character sitting in the middle of the one diagnostic that was supposed to explain
  // what went wrong. The text below is built so the cut lands exactly on the pair -- 998 characters,
  // then the emoji, with the limit at 1000 and the slice at 999.
  it("does not cut a provider's text in the middle of an astral character", () => {
    const request = requestOf(
      describeUnproductiveSession(
        report({
          reason: "PROVIDER_REPORTED_FAILURE",
          providerText: `${"a".repeat(998)}\u{1F600}${"a".repeat(100)}`,
        }),
      ),
    );
    expect(request.context.isWellFormed()).toBe(true);
    expect(request.context).not.toContain("\uFFFD");
    // Still truncated, and still the same character budget: the guard drops the orphaned half, it
    // does not stop the truncation from happening.
    expect(request.context).toContain("…");
    expect(request.context).toContain("a".repeat(998));
  });

  // Every field the builder fills is bounded, not just the one carrying provider text: a request it
  // cannot validate is a failed session failing a second time, inside the diagnosis of the first.
  it("stays within the contract even when the executable path is absurdly long", () => {
    const build = (): ReturnType<typeof describeUnproductiveSession> =>
      describeUnproductiveSession(report({ reason: "SPAWN_FAILED", command: "/x".repeat(9_000) }));
    expect(build).not.toThrow();
    const request = requestOf(build());
    expect(request.recommendation?.length ?? 0).toBeLessThanOrEqual(4_000);
    expect(request.context.length).toBeLessThanOrEqual(4_000);
  });

  // A `spawn` into a missing cwd fails exactly the way a missing executable does, so this used to
  // arrive as SPAWN_FAILED and tell the owner their CLI was not installed -- false, and a repair
  // for something that was never broken. The directory is the fact, and the executable must be
  // cleared by name rather than merely left unmentioned.
  it("names the directory, not the executable, when there was nowhere to run", () => {
    const request = requestOf(
      describeUnproductiveSession(
        report({
          reason: "WORKING_DIRECTORY_MISSING",
          command: "codex",
          workingDirectory: "/var/loomrail/worktrees/work-item-1",
        }),
      ),
    );
    expect(request.title).toContain("no directory to run in");
    expect(request.context).toContain("/var/loomrail/worktrees/work-item-1");
    expect(request.context).toContain("The process never started.");
    expect(request.recommendation).toContain("/var/loomrail/worktrees/work-item-1");
    expect(request.recommendation).toContain('Nothing is wrong with "codex"');
  });

  // One of the two reasons reached WITH something published. A session killed after its first
  // `agent_message` has already streamed a checkpoint to the daemon, which persisted it -- so the
  // closing sentence every other diagnosis ends on ("No checkpoint was published") would be false
  // here, and it is the sentence an owner reads to decide whether anything survived. Both halves
  // are asserted: what it must say, and what it must no longer say.
  it("tells the owner the checkpoint survives when a session was cut off after publishing one", () => {
    const request = requestOf(
      describeUnproductiveSession(
        report({ reason: "SESSION_ENDED_UNFINISHED", exitCode: null, signal: "SIGKILL" }),
      ),
    );
    expect(request.title).toContain("cut off before it finished");
    expect(request.context).toContain("killed by SIGKILL");
    expect(request.context).toContain("checkpoint this session published is kept");
    expect(request.context).not.toContain("No checkpoint was published");
  });

  // The other reason reached with a checkpoint in hand, and the one whose wording had to stop
  // borrowing the first one's. A CLI that exits 0 without ever reporting its turn complete was not
  // cut off -- it ran to its end and said so in words this adapter does not know -- so the
  // "cut off before it finished" title sat directly above "The process exited with code 0",
  // contradicting itself, naming no missing event, and recommending a resume that reaches this same
  // question again on every stage of every work item.
  it("says the terminal event never arrived, rather than that a cleanly exited session was cut off", () => {
    const request = requestOf(
      describeUnproductiveSession(
        report({
          reason: "TERMINAL_TURN_EVENT_MISSING",
          terminalEvent: "turn.completed",
          exitCode: 0,
          signal: null,
        }),
      ),
    );

    // What it must no longer say. The contradiction is the defect, so it is asserted before
    // anything about the replacement wording.
    expect(request.title).not.toContain("cut off");
    expect(request.context).not.toContain("cut off");
    expect(request.recommendation).not.toContain("resume the attempt");

    expect(request.title).toContain("never reported the turn finished");
    expect(request.context).toContain("exited with code 0");
    // The missing signal, by name, and the reason it goes missing.
    expect(request.context).toContain("turn.completed");
    expect(request.context).toContain("renamed");
    expect(request.recommendation).toContain("turn.completed");
    // Still a checkpoint-in-hand reason: the closing sentence has to be the one that says so.
    expect(request.context).toContain("checkpoint this session published is kept");
    expect(request.context).not.toContain("No checkpoint was published");
  });

  // A report that names no event still has to produce a usable question rather than a sentence with
  // a hole in it -- `terminalEvent` is optional, and an adapter that does not name one is honest
  // rather than broken.
  it("still asks a whole question when the report does not name the missing event", () => {
    const request = requestOf(
      describeUnproductiveSession(report({ reason: "TERMINAL_TURN_EVENT_MISSING", exitCode: 0 })),
    );
    expect(request.context).toContain("the event that reports a turn finished");
    expect(request.context).not.toContain("undefined");
    expect(request.recommendation).not.toContain("undefined");
    expect(() => humanRequestDraftSchema.parse(request)).not.toThrow();
  });

  it("names the executable when the process could never be started", () => {
    const request = requestOf(
      describeUnproductiveSession(report({ reason: "SPAWN_FAILED", command: "/nowhere/codex" })),
    );
    expect(request.title).toContain("could not start its CLI");
    expect(request.context).toContain("/nowhere/codex");
    expect(request.context).toContain("The process never started.");
  });
});
