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
 */
export const resolveRegisteredRepository = async (path: string): Promise<string> => {
  const canonical = await canonicalPathOf(path);
  const inspected = canonical === null ? null : await inspectRepository(canonical);
  // git reports its top level as a physical path, so the comparison is against the canonical form
  // for the same reason the provisioning guard compares canonical forms (session-loop.ts).
  const isOwnTopLevel = canonical !== null && inspected !== null && inspected.topLevel === canonical;
  if (isOwnTopLevel) return canonical;

  const insideRepository = inspected?.topLevel ?? null;
  const decision = decideProvisionWorkspace({
    repository: { isRepository: false, inProgress: null, path, insideRepository },
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
