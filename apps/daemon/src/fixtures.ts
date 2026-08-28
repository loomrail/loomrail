import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fixtureProjectIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  type FixtureProjectId,
} from "@loomrail/contracts";
import { decideProvisionWorkspace } from "@loomrail/domain";
import { inspectRepository, runGit } from "@loomrail/workspace";
import { z } from "zod";

const fixtureManifestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    fixtureId: fixtureProjectIdSchema,
    projectId: opaqueIdSchema,
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export type ResolvedFixtureProject = {
  fixtureId: FixtureProjectId;
  projectId: string;
  name: string;
  /**
   * The directory the fixture is *stored* as, inside Loomrail's own checkout.
   *
   * Named a template rather than a repository because that is what it is: a nested `.git` cannot be
   * committed to this repository, so a bundled fixture cannot ship as one. It becomes a repository
   * only when `materialiseFixtureRepository` copies it out of the checkout and initialises it
   * there, and it is that copy -- never this path -- that a Project records.
   */
  templatePath: string;
};

export class FixtureResolutionError extends Error {
  readonly code: "FIXTURE_PATH_ESCAPE" | "FIXTURE_MANIFEST_INVALID";

  constructor(code: FixtureResolutionError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FixtureResolutionError";
    this.code = code;
  }
}

const bundledFixturesRoot = fileURLToPath(new URL("../../../fixtures/projects", import.meta.url));

const isContainedPath = (root: string, target: string): boolean => {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

export const resolveBundledFixture = async (
  fixtureId: FixtureProjectId,
  fixturesRoot = bundledFixturesRoot,
): Promise<ResolvedFixtureProject> => {
  try {
    const canonicalRoot = await realpath(resolve(fixturesRoot));
    const canonicalProject = await realpath(resolve(canonicalRoot, fixtureId));
    if (!isContainedPath(canonicalRoot, canonicalProject)) {
      throw new FixtureResolutionError(
        "FIXTURE_PATH_ESCAPE",
        "The fixture Project resolves outside the bundled fixture directory",
      );
    }

    const canonicalManifest = await realpath(resolve(canonicalProject, "loomrail-fixture.json"));
    if (!isContainedPath(canonicalProject, canonicalManifest)) {
      throw new FixtureResolutionError(
        "FIXTURE_PATH_ESCAPE",
        "The fixture manifest resolves outside its bundled Project directory",
      );
    }

    const manifestText = await readFile(canonicalManifest, "utf8");
    const manifestValue: unknown = JSON.parse(manifestText) as unknown;
    const manifest = fixtureManifestSchema.parse(manifestValue);
    if (manifest.fixtureId !== fixtureId) {
      throw new FixtureResolutionError(
        "FIXTURE_MANIFEST_INVALID",
        "The fixture manifest ID does not match its catalog entry",
      );
    }

    return {
      fixtureId,
      projectId: manifest.projectId,
      name: manifest.name,
      templatePath: canonicalProject,
    };
  } catch (error: unknown) {
    if (error instanceof FixtureResolutionError) throw error;
    throw new FixtureResolutionError(
      "FIXTURE_MANIFEST_INVALID",
      "The bundled fixture Project could not be validated",
      { cause: error },
    );
  }
};

export type ProjectRegistrationErrorCode =
  | "REPOSITORY_PATH_NOT_ABSOLUTE"
  | "REPOSITORY_PATH_NOT_A_REPOSITORY"
  | "REPOSITORY_PATH_INSIDE_REPOSITORY"
  | "FIXTURE_TEMPLATE_UNSUPPORTED_ENTRY"
  | "FIXTURE_MATERIALISATION_FAILED";

/**
 * A Project could not be registered at a path -- either the owner's own repository or the copy a
 * bundled fixture was just materialised into.
 *
 * Separate from `FixtureResolutionError`, which is about the bundled *template* being unreadable or
 * escaping its catalog. This one is about the repository a Project would actually point at.
 */
export class ProjectRegistrationError extends Error {
  readonly code: ProjectRegistrationErrorCode;

  constructor(code: ProjectRegistrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectRegistrationError";
    this.code = code;
  }
}

const canonicalPathOf = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
};

const pathExists = async (path: string): Promise<boolean> => (await canonicalPathOf(path)) !== null;

/**
 * Whether two paths name the same directory that is actually on disk.
 *
 * Canonical forms are compared, not the strings: a Project's `repositoryPath` was recorded by some
 * earlier version of Loomrail and may spell a directory differently from the way this process
 * resolves it -- macOS's `/var` -> `/private/var` is the everyday case, an owner's symlinked
 * checkout the next one. The string comparison is kept first only because it answers without two
 * `realpath` calls in the common case.
 *
 * A path that does not resolve is never "the same" as anything, `null === null` included: this
 * answers a question about a directory, and two missing directories are not one.
 */
export const isSameExistingPath = async (left: string, right: string): Promise<boolean> => {
  if (left === right) return await pathExists(left);
  const [canonicalLeft, canonicalRight] = await Promise.all([canonicalPathOf(left), canonicalPathOf(right)]);
  return canonicalLeft !== null && canonicalLeft === canonicalRight;
};

/**
 * What `path` is, as far as registering or keeping a Project at it is concerned: its canonical
 * form, git's view of it, and whether it is a repository's own top level.
 *
 * One function so the judgment has one definition. `resolveRegisteredRepository` below refuses a
 * path on it, and `isRegisteredRepositoryUsable` reports on it for a Project already recorded at
 * one -- and those two answering differently is exactly how a UI ends up offering to repair a
 * healthy Project, or hiding a broken one.
 */
const inspectRegisteredPath = async (
  path: string,
): Promise<{ canonical: string | null; insideRepository: string | null; isOwnTopLevel: boolean }> => {
  const canonical = await canonicalPathOf(path);
  const inspected = canonical === null ? null : await inspectRepository(canonical);
  // git reports its top level as a physical path, so the comparison is against the canonical form
  // for the same reason the provisioning guard compares canonical forms (session-loop.ts).
  const isOwnTopLevel = canonical !== null && inspected !== null && inspected.topLevel === canonical;
  return { canonical, insideRepository: isOwnTopLevel ? null : (inspected?.topLevel ?? null), isOwnTopLevel };
};

/**
 * How long the probe below waits for the filesystem and `git` before it stops waiting and answers
 * "not usable".
 *
 * Two seconds, because this bounds a *probe*, not a piece of work: nothing is lost by giving up on
 * it, and the owner is looking at a list that will not render until it answers. A healthy local
 * repository is inspected in single-digit milliseconds -- three `git rev-parse` runs and a
 * `realpath` -- so two seconds is three orders of magnitude of headroom for a loaded machine, and
 * still far below the point where an owner decides the app is hung. The cost of the timeout firing
 * on a repository that is merely slow is one Project shown as UNUSABLE until the next fetch, which
 * is recoverable; the cost of not having it is the whole screen never arriving.
 */
export const REGISTERED_REPOSITORY_PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether a Project recorded at `path` could have a workspace cut from it right now.
 *
 * The same question `resolveRegisteredRepository` refuses on, asked without the refusal: this one
 * answers about a Project that is already registered, so there is nothing to reject and nobody to
 * word a message for. A path that no longer resolves, one that stopped being a repository, and one
 * that is a directory *inside* a repository are all equally unusable here -- the fixes differ, and
 * the fix is the repair route's business, not the list's.
 *
 * **It answers, always, and within `timeoutMs`.** This is a probe on the route that renders the
 * app's main screen (`GET /api/v1/projects`), so every way the inspection can fail to produce a
 * boolean has to become one here rather than reaching the caller:
 *
 * - `runGit` REJECTS with `GitMissingError` when `git` cannot be spawned at all, and
 *   `inspectRepository` does not catch it. Unhandled, one Project on a machine without `git` on
 *   PATH turned the entire project list into a generic 500 -- an owner who could not list their
 *   Projects, over a question about one of them.
 * - Neither `runGit` nor `realpath` has a timeout of its own, and a Project registered on a
 *   sleeping external disk or an unreachable network mount blocks in both. Unbounded, one such
 *   Project wedged the request until the mount answered, which can be never.
 *
 * The rejection handler is attached to the inspection itself rather than wrapped around the race,
 * so that an inspection which rejects *after* the timeout already answered is still handled: a
 * `Promise.race` loser keeps running, and an unhandled rejection from it would take the daemon down
 * on a route that had already replied.
 *
 * A timed-out probe reports UNUSABLE, the same as a path that stopped being a repository, because
 * that is the honest answer to the question actually asked -- "could a workspace be cut from this
 * right now" -- and right now it could not. It is deliberately not a third status: the list's job
 * is to stop a broken Project from looking healthy, not to diagnose which kind of broken it is.
 */
export const isRegisteredRepositoryUsable = async (
  path: string,
  timeoutMs: number = REGISTERED_REPOSITORY_PROBE_TIMEOUT_MS,
): Promise<boolean> => {
  const inspected = inspectRegisteredPath(path.trim()).then(
    ({ isOwnTopLevel }) => isOwnTopLevel,
    () => false,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      inspected,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    // Cleared on both outcomes, so a probe the inspection won does not hold a timer -- and, with it,
    // the event loop -- open for the rest of the timeout.
    clearTimeout(timer);
  }
};

/**
 * Settles whether a path may be registered as a Project's repository, and refuses in the owner's
 * words when it may not.
 *
 * The refusal wording is not written here: it comes from `decideProvisionWorkspace`, the same
 * domain decision that guards provisioning. That is deliberate. "This path is not a repository" and
 * "this path is a directory *inside* a repository" have different fixes, and the second one already
 * has an honest, specific explanation in the domain -- restating either here would be one more
 * place for the two to drift, and the drifted copy is always the generic one.
 *
 * `inProgress` is passed as `null` rather than inspected, because registration asks a narrower
 * question than provisioning does: an owner whose repository is mid a rebase should still be able
 * to register it. The rebase is transient; whether the path is a repository at all is not. The
 * mid-operation refusal stays where it belongs, at the moment a workspace is actually cut.
 *
 * **A repository's own top level is always accepted, Loomrail's own checkout included, and that is
 * a decision rather than an oversight.** Nothing here special-cases this repository, and nothing
 * will: an owner who types this checkout's path has named it deliberately, and a tool that refuses
 * to work on its own source is a poorer tool for it. What protects the owner in that case is not a
 * refusal but the shape of the work -- the agent is given a Git worktree cut *outside* the
 * repository, under Loomrail's own data directory, never the checkout itself; and Loomrail commits
 * to that worktree's branch and pushes nothing, so nothing an agent does reaches the owner's
 * working copy, their history, or any remote. The one thing this refusal does still keep out is a
 * *subdirectory* of a repository, which would branch the enclosing repository by surprise. See
 * `docs/security/THREAT-MODEL.md`, E1 delta.
 */
export const resolveRegisteredRepository = async (path: string): Promise<string> => {
  // Trimmed before anything judges it, not at the contract: `registerRepositoryProjectRequestSchema`
  // deliberately carries the path exactly as typed (see its comment on `repositoryPathTextSchema`),
  // so a schema-level `.trim()` would also reach every other consumer of that text -- including
  // paths this daemon derives itself, which never have the problem being fixed. macOS appends a
  // trailing space when a folder is dragged into a terminal, and that stray character is invisible to
  // the owner; without this, it used to earn the same REPOSITORY_PATH_NOT_A_REPOSITORY refusal as a
  // path that genuinely is not a repository, sending the owner looking for a problem with their
  // repository when the problem was one character the terminal added. This is where the daemon judges
  // the path, so this is where the judgment normalizes it.
  const trimmedPath = path.trim();

  // Absolute first, before anything touches the filesystem. A relative path resolves against
  // whatever directory this daemon was launched from -- typing `.` used to register the daemon's
  // own working directory with a 200 -- and the next daemon start resolves it somewhere else. The
  // owner-facing wording says which of the two problems it is: the path is fine as a directory and
  // wrong as a Project's path, and a "this is not a Git repository" answer would send them looking
  // for the wrong thing.
  if (!isAbsolute(trimmedPath)) {
    throw new ProjectRegistrationError(
      "REPOSITORY_PATH_NOT_ABSOLUTE",
      `A Project's repository path must be absolute, and ${trimmedPath} is relative. A relative path is resolved against whatever directory the Loomrail daemon was started from, which is not something you chose and not the same on the next start. Enter the repository's full path, starting from the root of the filesystem.`,
    );
  }
  const { canonical, insideRepository, isOwnTopLevel } = await inspectRegisteredPath(trimmedPath);
  if (isOwnTopLevel && canonical !== null) return canonical;

  const decision = decideProvisionWorkspace({
    repository: { isRepository: false, inProgress: null, path: trimmedPath, insideRepository },
  });
  if (decision.type !== "REFUSED") {
    // Unreachable: `isRepository: false` is refused by every branch of the decision above. A throw
    // rather than a silent fall-through so a future change to the domain fails loudly here instead
    // of registering a Project at a path nothing ever verified.
    throw new Error("A path that is not a repository was approved for registration");
  }
  // Both halves of the owner-facing wording: the context says what is true about the path, the
  // recommendation says what to do about it, and the two fixes differ between the branches. The
  // recommendation is nullable on the draft even though every refusal on this path carries one.
  const { context, recommendation } = decision.request;
  throw new ProjectRegistrationError(
    insideRepository === null ? "REPOSITORY_PATH_NOT_A_REPOSITORY" : "REPOSITORY_PATH_INSIDE_REPOSITORY",
    recommendation === null ? context : `${context} ${recommendation}`,
  );
};

/**
 * What a Project registered at `path` records: where it is, what it is called, and its id.
 *
 * The path is settled first, by `resolveRegisteredRepository` above -- so a path that is not a
 * repository, or one inside another repository, is refused here in the owner's words before
 * anything derives a name from it.
 *
 * **The name is the repository directory's own name.** Nothing asks the owner for one, and no
 * field carries one. That directory name is what the owner already calls this repository
 * everywhere else -- their shell prompt, their editor's window title, the path they would type --
 * so it is the answer they would give if asked, and taking it costs them a step. It is also the
 * one name that cannot disagree with the path it describes: a name typed once and stored would
 * still be there, unchanged and now wrong, after the directory was renamed. Two repositories may
 * share a directory name and that is allowed -- `name` carries no UNIQUE constraint, only
 * `repository_path` does, and the path is what tells them apart.
 *
 * **The id is derived from the canonical path**, not minted at random, so registering the same
 * repository twice reaches the same Project rather than two. The refusal is then
 * PROJECT_ALREADY_REGISTERED from the id and the path at once, agreeing with each other, instead of
 * a second id colliding on the path alone.
 */
export const describeRegisteredRepository = async (
  path: string,
): Promise<{ id: string; name: string; repositoryPath: string }> => {
  const repositoryPath = await resolveRegisteredRepository(path);
  const directoryName = basename(repositoryPath);
  return {
    // Hex, so it always satisfies opaqueIdSchema whatever the path holds. Truncated because the id
    // is a handle, not a proof: 64 bits of sha256 over a canonical filesystem path on one machine
    // will not collide, and the repository path's own UNIQUE constraint is what actually enforces
    // one Project per repository.
    id: `project-repository-${createHash("sha256").update(repositoryPath).digest("hex").slice(0, 16)}`,
    // A filesystem root has no basename, and a directory name longer than the contract's 200
    // characters would be rejected as an invalid *request*, which would send the owner looking for
    // a mistake in a path that is fine. Both fall back rather than fail.
    name: (directoryName === "" ? repositoryPath : directoryName).slice(0, 200),
    repositoryPath,
  };
};

// Identity and configuration for the fixture's own first commit. Set with `-c` flags rather than
// read from the machine: an owner with no `user.email` configured would otherwise get a daemon that
// cannot initialise the demo at all, and one with a signing key or a `core.hooksPath` would get a
// passphrase prompt or a hook run inside a repository Loomrail created on their behalf. The empty
// `init.templateDir` keeps the owner's own git template -- hooks included -- out of it too.
const demoRepositoryArgs = [
  "-c",
  "user.name=Loomrail",
  "-c",
  "user.email=demo@loomrail.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.templateDir=",
] as const;

const GIT_STDERR_LIMIT = 500;

const runGitOrThrow = async (args: readonly string[], cwd: string, step: string): Promise<void> => {
  const result = await runGit([...demoRepositoryArgs, ...args], { cwd });
  if (result.exitCode === 0) return;
  // git's stderr is process output: bounded before it is placed into an error a caller may log or
  // show, the same way `addWorktree` bounds it (packages/workspace/src/worktree.ts).
  const stderr = result.stderr.trim().slice(0, GIT_STDERR_LIMIT);
  throw new ProjectRegistrationError(
    "FIXTURE_MATERIALISATION_FAILED",
    `Loomrail could not turn the bundled fixture into a Git repository at ${cwd}: git ${step} exited ${result.exitCode.toString()}. ${stderr}`,
  );
};

/**
 * Copies a fixture template's contents, and only those.
 *
 * Two things it deliberately will not do. It never copies a `.git` directory, from the template or
 * from anywhere nested inside it: the copy is about to be given a repository of its own, and a
 * carried-in `.git` would silently make it something else. And it refuses a symbolic link outright
 * rather than copying or following it -- a link in a bundled template is not a fixture we ship, and
 * copying one would put a pointer out of the materialised repository into the owner's filesystem,
 * where an agent working in a worktree could write through it.
 */
const copyTemplateInto = async (from: string, to: string): Promise<void> => {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) {
      throw new ProjectRegistrationError(
        "FIXTURE_TEMPLATE_UNSUPPORTED_ENTRY",
        `The bundled fixture template holds ${source}, which is neither a regular file nor a directory, so it cannot be copied into a demo repository`,
      );
    }
    if (entry.isDirectory()) {
      await mkdir(destination);
      await copyTemplateInto(source, destination);
      continue;
    }
    await copyFile(source, destination);
  }
};

/**
 * The outcome of materialising a fixture: where its repository is, and whether this call is the one
 * that built it. `created: false` means a directory was already sitting there and was adopted --
 * which is a different claim entirely, because nothing here knows what that directory is.
 */
export type MaterialisedFixture = { repositoryPath: string; created: boolean };

const STAGING_PREFIX = ".materialising-";

/**
 * How old a staging directory has to be before it is treated as abandoned rather than in flight.
 *
 * An hour, not a minute: the only cost of waiting is a directory sitting in the data folder, while
 * deleting one a live registration is still copying into would fail that registration. A single
 * materialisation is a template copy and three `git` invocations -- seconds, not minutes -- so an
 * hour is far past anything a running copy could still be doing, on any machine.
 */
const STALE_STAGING_AGE_MS = 60 * 60 * 1_000;

/**
 * Removes staging directories a previous materialisation left behind.
 *
 * The copy is built under `.materialising-<fixtureId>-XXXX` and moved into place with one rename,
 * which is what makes a half-populated repository impossible to observe -- but it also means a
 * process killed mid-copy leaves that directory in the owner's data folder with nothing to sweep
 * it. This is that sweep, at the only moment anything looks at the folder anyway.
 *
 * Best effort throughout, and deliberately so: an unreadable data folder or an undeletable leftover
 * is a reason to leave the mess and get on with the registration the owner asked for, not a reason
 * to fail it. Failing here would turn a wasted directory into a demo workspace that cannot be
 * initialised at all.
 */
const sweepStaleStaging = async (root: string, olderThan: number): Promise<void> => {
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const candidate = join(root, name);
    try {
      const stats = await stat(candidate);
      if (!stats.isDirectory() || stats.mtimeMs > olderThan) continue;
      await rm(candidate, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove. Either way the next materialisation will look again.
    }
  }
};

/**
 * Turns a bundled fixture template into a real Git repository under `demoProjectsRoot`, and answers
 * with the path a Project should record.
 *
 * Idempotent, because the owner will press the button twice. A materialised fixture that already
 * exists is handed back untouched -- not re-copied, not re-initialised, not reset -- so whatever
 * work has since happened in it survives. That is the whole reason the copy is built in a staging
 * directory and moved into place with a single rename: the destination either does not exist or is
 * a finished repository, never a half-populated one, and two registrations racing each other end up
 * sharing the first one's repository rather than clobbering it.
 */
export const materialiseFixtureRepository = async (
  fixture: ResolvedFixtureProject,
  demoProjectsRoot: string,
): Promise<MaterialisedFixture> => {
  const root = resolve(demoProjectsRoot);
  // Safe to join: `fixtureId` is an enum in the contract, so it can only ever be one of two literal
  // directory names.
  const target = join(root, fixture.fixtureId);
  // Canonicalised on the way out, on both branches. A Project's `repositoryPath` is compared
  // against git's own idea of a top level, which is always physical, and -- more immediately -- the
  // two branches would otherwise disagree about the same directory (`/var/...` from `join`,
  // `/private/var/...` from an inspection), which is a different payload under the same command id.
  const canonical = async (): Promise<string> => (await canonicalPathOf(target)) ?? target;
  if (await pathExists(target)) return { repositoryPath: await canonical(), created: false };

  await mkdir(root, { recursive: true });
  await sweepStaleStaging(root, Date.now() - STALE_STAGING_AGE_MS);
  const staging = await mkdtemp(join(root, `${STAGING_PREFIX}${fixture.fixtureId}-`));
  try {
    await copyTemplateInto(fixture.templatePath, staging);
    await runGitOrThrow(["init", "--quiet", "-b", "main"], staging, "init");
    await runGitOrThrow(["add", "--all", "--force", "."], staging, "add");
    await runGitOrThrow(
      ["commit", "--quiet", "--no-verify", "-m", `Loomrail demo fixture ${fixture.fixtureId}`],
      staging,
      "commit",
    );
    await rename(staging, target);
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    // A rename that failed because someone else got there first is not a failure: their repository
    // is finished (nothing is ever renamed into place before its first commit), so this
    // registration adopts it. Any other reason, and there is nothing at `target` to adopt.
    if (await pathExists(target)) return { repositoryPath: await canonical(), created: false };
    if (error instanceof ProjectRegistrationError) throw error;
    throw new ProjectRegistrationError(
      "FIXTURE_MATERIALISATION_FAILED",
      `Loomrail could not materialise the bundled fixture ${fixture.fixtureId} at ${target}`,
      { cause: error },
    );
  }
  return { repositoryPath: await canonical(), created: true };
};
