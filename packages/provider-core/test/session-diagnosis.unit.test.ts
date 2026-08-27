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

  it("names the executable when the process could never be started", () => {
    const request = requestOf(
      describeUnproductiveSession(report({ reason: "SPAWN_FAILED", command: "/nowhere/codex" })),
    );
    expect(request.title).toContain("could not start its CLI");
    expect(request.context).toContain("/nowhere/codex");
    expect(request.context).toContain("The process never started.");
  });
});
