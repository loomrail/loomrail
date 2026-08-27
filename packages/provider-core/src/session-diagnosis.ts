import { humanRequestDraftSchema, type ProviderOutcome } from "@loomrail/contracts";

/**
 * Turns "the session ended and there is no result to close the stage on" into a question the owner
 * can act on.
 *
 * Four of the five reasons below are sessions with nothing at all to show. The fifth
 * (`SESSION_ENDED_UNFINISHED`) is a session that published a checkpoint and then died before
 * finishing, which is not the same thing and does not read the same way to an owner -- see
 * `carryForwardLine`.
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
  /**
   * The directory the CLI was to be launched in is not there, so nothing was launched.
   *
   * Distinct from SPAWN_FAILED on purpose, and the reason this member exists: a `spawn` into a
   * missing cwd fails the same way a missing executable does, and the diagnosis then names the
   * executable -- the owner reads "codex is not installed", which is false and sends them to fix
   * something that was never broken. The directory is the fact, and it is a different fact.
   */
  | "WORKING_DIRECTORY_MISSING"
  /** The CLI ran and reported its own failure -- an auth refusal, a rate limit, a model error. */
  | "PROVIDER_REPORTED_FAILURE"
  /** The CLI ran, said nothing about failing, and still produced no structured result. */
  | "NO_STRUCTURED_RESULT"
  /**
   * The CLI produced a structured result but never finished the turn it was given -- it was killed,
   * or it exited before reporting the turn complete.
   *
   * The one reason on this list where the session DID publish something. It exists because a
   * checkpoint is not evidence that a session finished: `codex exec` emits its `agent_message`
   * items as it goes, and the first of them, on a real recorded run, is the agent stating what it
   * is ABOUT to do, with `completed: []`. A session killed after that line has published a
   * checkpoint that reads exactly like a final answer, and closing the stage on it reports work
   * that never happened -- through a daemon shutdown, the session deadline, or any non-zero exit.
   * So the checkpoint is kept (it is a real checkpoint, and the next session resumes from it) and
   * the stage is not closed.
   */
  | "SESSION_ENDED_UNFINISHED";

export type UnproductiveSessionReport = {
  provider: string;
  /** The executable this adapter tried to spawn -- the one thing a SPAWN_FAILED owner must see. */
  command: string;
  reason: UnproductiveSessionReason;
  /**
   * The directory the CLI was to run in, named only when that directory is what went wrong
   * (`WORKING_DIRECTORY_MISSING`).
   *
   * Optional rather than required of every report for the same reason `linesUnreadable` is: a
   * caller reporting one of the other three reasons has measured nothing about the working
   * directory and should say nothing about it. A report that carries the reason without the path
   * still produces a valid question -- it just cannot name the directory, which is a caller bug
   * this builder describes honestly rather than throwing on top of a session that already failed.
   */
  workingDirectory?: string;
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

// The path when the caller named one, and a phrase that makes no claim about it when it did not.
const workingDirectoryOf = (report: UnproductiveSessionReport): string =>
  report.workingDirectory ?? "the directory it was given";

const describeExit = (report: UnproductiveSessionReport): string => {
  if (report.reason === "SPAWN_FAILED" || report.reason === "WORKING_DIRECTORY_MISSING") {
    return `The process never started.`;
  }
  if (report.signal !== null) return `The process was killed by ${report.signal}.`;
  if (report.exitCode !== null) return `The process exited with code ${String(report.exitCode)}.`;
  return `The process ended without reporting an exit code.`;
};

const openingLine = (report: UnproductiveSessionReport): string => {
  switch (report.reason) {
    case "SPAWN_FAILED":
      return `Loomrail could not start "${report.command}", the executable the ${report.provider} adapter runs.`;
    case "WORKING_DIRECTORY_MISSING":
      return `Loomrail did not start the ${report.provider} CLI: the directory this session was to run in is not there (${workingDirectoryOf(report)}). The workspace this stage was given has been removed or moved since it was recorded.`;
    case "PROVIDER_REPORTED_FAILURE":
      return `The ${report.provider} CLI reported that its own turn failed, so this session produced no result.`;
    case "NO_STRUCTURED_RESULT":
      return `The ${report.provider} session ended without the structured result Loomrail asked it for, and without saying why.`;
    case "SESSION_ENDED_UNFINISHED":
      return `The ${report.provider} session was cut off before it finished. It did publish a checkpoint, but a checkpoint written while a session is still working states what the agent meant to do next, not what it did, so Loomrail will not close a stage on it.`;
  }
};

const recommendationFor = (report: UnproductiveSessionReport): string => {
  switch (report.reason) {
    case "SPAWN_FAILED":
      return `Check that "${report.command}" is installed and executable on this machine, then resume the attempt.`;
    case "WORKING_DIRECTORY_MISSING":
      return `Restore ${workingDirectoryOf(report)} -- the work item's own worktree, cut from the project's repository -- then resume the attempt. Nothing is wrong with "${report.command}" or with this machine's install of it.`;
    case "PROVIDER_REPORTED_FAILURE":
      return "Read the provider's own message above -- an authentication prompt, a rate limit and a model error each need a different fix -- then resume the attempt.";
    case "NO_STRUCTURED_RESULT":
      return "Check that the provider CLI on this machine still accepts the flags this adapter sends (a CLI upgrade can move where the final answer arrives), then resume the attempt.";
    case "SESSION_ENDED_UNFINISHED":
      return "Nothing has to be repaired if this was a shutdown or a timeout: resume the attempt and the next session carries on from the checkpoint this one published. If the process ended on its own, read the exit above and the provider's own message before resuming.";
  }
};

const titleFor = (report: UnproductiveSessionReport): string => {
  switch (report.reason) {
    case "SPAWN_FAILED":
      return `${report.provider} could not start its CLI`;
    case "WORKING_DIRECTORY_MISSING":
      return `${report.provider} had no directory to run in`;
    case "PROVIDER_REPORTED_FAILURE":
      return `${report.provider} reported a failed turn`;
    case "NO_STRUCTURED_RESULT":
      return `${report.provider} ended a session with no result`;
    case "SESSION_ENDED_UNFINISHED":
      return `${report.provider} was cut off before it finished this stage`;
  }
};

// The last sentence of every diagnosis, and the one place a published checkpoint changes what is
// true. SESSION_ENDED_UNFINISHED is the only reason on this list reached with a checkpoint in hand:
// the adapter published it live as the stream delivered it, so telling the owner nothing was
// carried forward would be false, and telling them the stage completed would be the defect this
// reason exists to close.
const carryForwardLine = (report: UnproductiveSessionReport): string =>
  report.reason === "SESSION_ENDED_UNFINISHED"
    ? "The checkpoint this session published is kept, so a resumed attempt starts from it rather than from nothing; the stage itself is not closed on it."
    : "No checkpoint was published, so nothing from this session is carried forward.";

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
      carryForwardLine(report),
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
