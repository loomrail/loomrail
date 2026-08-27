import { humanRequestDraftSchema, type ProviderOutcome } from "@loomrail/contracts";

/**
 * Turns "the session ended and there is nothing to show for it" into a question the owner can act
 * on.
 *
 * Both live adapters used to answer every one of these situations with `CONTEXT_EXHAUSTED` -- a
 * *business result*, and a false one: neither `codex exec` nor `claude -p` reports context
 * exhaustion at all, so that label was a lie in five distinct situations at once (a CLI that was
 * not authenticated, a CLI that could not be spawned, a provider-reported turn failure, a stream
 * the adapter could not read, and a genuinely empty stream). The owner saw an unproductive session,
 * then a second one, then a HARD pause whose question named nothing.
 *
 * A `NEEDS_HUMAN` request is deliberately noisier: the owner may now be asked about a session that
 * would once have been retried silently. That is the direction this project chooses. Spec §9 line
 * 291 already promised this for the unauthenticated case; the rest arrive by the same route because
 * they are the same class of fact -- something outside Loomrail's model went wrong, and only the
 * owner can act on it.
 *
 * The shape mirrors `decideDispatchStage`'s refusal (`@loomrail/domain`) so the cockpit renders it
 * identically: FREE_TEXT with `allowOther` and no enumerable options, because the right answer is
 * always out-of-band -- log in, install the CLI, pick another model.
 */
export type UnproductiveSessionReason =
  /** The executable could not be started at all (`ProcessSpawnError`). */
  | "SPAWN_FAILED"
  /** The CLI ran and reported its own failure -- an auth refusal, a rate limit, a model error. */
  | "PROVIDER_REPORTED_FAILURE"
  /** The CLI ran, said nothing about failing, and still produced no structured result. */
  | "NO_STRUCTURED_RESULT";

export type UnproductiveSessionReport = {
  provider: string;
  /** The executable this adapter tried to spawn -- the one thing a SPAWN_FAILED owner must see. */
  command: string;
  reason: UnproductiveSessionReason;
  /** `null` when the process never ran, or when a signal ended it. */
  exitCode: number | null;
  signal: string | null;
  /** Every line that arrived on stdout, and how many of those carried nothing usable. */
  linesReceived: number;
  linesUnused: number;
  /**
   * How many of `linesUnused` the adapter could not READ at all, as opposed to read and had no use
   * for. A subset of `linesUnused`, never a separate total.
   *
   * The distinction decides where a reader looks next, and without it the number points the wrong
   * way. A Codex session with write access emits an `item.started` for every item plus
   * `command_execution` and `file_change` items for the work itself -- six of the eleven lines of a
   * real successful run -- all of which the adapter understands perfectly well and takes nothing
   * from. Reported as one figure, a failed session of that shape says "six lines carried nothing
   * this adapter could use", which reads as a broken parser and sends the reader to the wrong
   * place. With the split it also says "0 of them could not be read at all", and the parser is
   * cleared.
   *
   * Optional because only an adapter whose parser separates the two can honestly report it:
   * `provider-claude-code`'s parser returns null both for a line it cannot read and for the
   * `system`/`assistant` events it drops by design, so it has no number to put here and omits the
   * field rather than inventing one.
   */
  linesUnreadable?: number;
  /**
   * The provider's own last diagnostic, verbatim. UNTRUSTED PROCESS OUTPUT: it is truncated to
   * `PROVIDER_TEXT_LIMIT` and placed only in the request's plain-text `context` field -- never
   * interpolated into a title, an option label, or anything a reader would take for Loomrail's own
   * words.
   */
  providerText: string | null;
};

// Enough of a CLI's own message to identify the failure ("Not logged in · Please run /login", a
// rate-limit body, a 400 from the model endpoint) without letting a chatty provider crowd out the
// facts Loomrail states above it, or push the whole context past the contract's own 4000-character
// limit.
const PROVIDER_TEXT_LIMIT = 1_000;

// The contract's own ceiling on `HumanRequest.context` (`descriptionSchema`). Applied here as well
// as by the schema so that an over-long context is truncated rather than thrown on: a session that
// already failed must not fail *again*, deep inside the daemon's own outcome validation, because
// its diagnosis was too long to state.
const CONTEXT_LIMIT = 4_000;

// `slice` cuts by UTF-16 code unit, so a cut that lands between the two halves of an astral
// character (an emoji in a provider's own error text is not exotic) leaves a lone high surrogate at
// the end -- an ill-formed string that renders as a replacement character. Nothing crashes; the
// owner just sees "\uFFFD" in the middle of the one diagnostic that was supposed to explain the
// failure. Only a HIGH surrogate can be orphaned this way: a slice can strip the tail of a pair,
// never its head.
const dropTrailingLoneSurrogate = (text: string): string => {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
};

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${dropTrailingLoneSurrogate(text.slice(0, limit - 1))}…`;

// The trailing clause appears only for an adapter that can tell the two apart -- see
// `linesUnreadable` on the report. An adapter that cannot says nothing about it, rather than
// reporting a zero it did not measure.
const describeLines = (report: UnproductiveSessionReport): string => {
  const counted = `Lines received from the CLI: ${String(report.linesReceived)}; of those, ${String(report.linesUnused)} carried nothing this adapter could use`;
  return report.linesUnreadable === undefined
    ? `${counted}.`
    : `${counted}, and ${String(report.linesUnreadable)} of them could not be read at all.`;
};

const describeExit = (report: UnproductiveSessionReport): string => {
  if (report.reason === "SPAWN_FAILED") return `The process never started.`;
  if (report.signal !== null) return `The process was killed by ${report.signal}.`;
  if (report.exitCode !== null) return `The process exited with code ${String(report.exitCode)}.`;
  return `The process ended without reporting an exit code.`;
};

const openingLine = (report: UnproductiveSessionReport): string => {
  switch (report.reason) {
    case "SPAWN_FAILED":
      return `Loomrail could not start "${report.command}", the executable the ${report.provider} adapter runs.`;
    case "PROVIDER_REPORTED_FAILURE":
      return `The ${report.provider} CLI reported that its own turn failed, so this session produced no result.`;
    case "NO_STRUCTURED_RESULT":
      return `The ${report.provider} session ended without the structured result Loomrail asked it for, and without saying why.`;
  }
};

const recommendationFor = (report: UnproductiveSessionReport): string => {
  switch (report.reason) {
    case "SPAWN_FAILED":
      return `Check that "${report.command}" is installed and executable on this machine, then resume the attempt.`;
    case "PROVIDER_REPORTED_FAILURE":
      return "Read the provider's own message above -- an authentication prompt, a rate limit and a model error each need a different fix -- then resume the attempt.";
    case "NO_STRUCTURED_RESULT":
      return "Check that the provider CLI on this machine still accepts the flags this adapter sends (a CLI upgrade can move where the final answer arrives), then resume the attempt.";
  }
};

const titleFor = (report: UnproductiveSessionReport): string => {
  switch (report.reason) {
    case "SPAWN_FAILED":
      return `${report.provider} could not start its CLI`;
    case "PROVIDER_REPORTED_FAILURE":
      return `${report.provider} reported a failed turn`;
    case "NO_STRUCTURED_RESULT":
      return `${report.provider} ended a session with no result`;
  }
};

/**
 * Builds the `NEEDS_HUMAN` outcome for a session that ended with nothing to carry forward.
 *
 * The line counts are the part that would have made this milestone's two Criticals loud instead of
 * silent: a session that received four hundred lines and understood none of them says exactly that,
 * rather than reporting a business result nobody asked the CLI about.
 */
export const describeUnproductiveSession = (report: UnproductiveSessionReport): ProviderOutcome => {
  const providerText =
    report.providerText === null || report.providerText.trim().length === 0
      ? "The CLI printed no diagnostic of its own."
      : `The provider's own message: ${truncate(report.providerText.trim(), PROVIDER_TEXT_LIMIT)}`;

  const context = truncate(
    [
      openingLine(report),
      describeExit(report),
      describeLines(report),
      providerText,
      "No checkpoint was published, so nothing from this session is carried forward.",
    ].join(" "),
    CONTEXT_LIMIT,
  );

  return {
    type: "NEEDS_HUMAN",
    request: humanRequestDraftSchema.parse({
      kind: "FREE_TEXT",
      blocking: true,
      title: truncate(titleFor(report), 200),
      context,
      // Truncated like the other two. `command` is Loomrail's own configuration rather than provider
      // output, so this is not the untrusted-text guard -- it is the same rule as `context`: a
      // session that already failed must not fail AGAIN inside this builder's own validation because
      // its diagnosis was too long to state.
      recommendation: truncate(recommendationFor(report), CONTEXT_LIMIT),
      options: [],
      allowOther: true,
    }),
  };
};
