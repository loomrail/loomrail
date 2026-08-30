import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, constants } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import {
  answerHumanRequestRequestSchema,
  adoptProjectConstitutionRequestSchema,
  apiErrorResponseSchema,
  budgetOverrideRequestSchema,
  correlationIdSchema,
  constitutionPresetsResponseSchema,
  createWorkItemRequestSchema,
  daemonStatusResponseSchema,
  eventPageDirectionSchema,
  eventsResponseSchema,
  healthResponseSchema,
  humanRequestStatusSchema,
  humanRequestsResponseSchema,
  moveWorkItemRequestSchema,
  opaqueIdSchema,
  pipelineControlRequestSchema,
  projectConstitutionSnapshotSchema,
  projectsResponseSchema,
  providerCapabilitiesResponseSchema,
  providerSessionsResponseSchema,
  registerFixtureProjectRequestSchema,
  registerRepositoryProjectRequestSchema,
  resolveAcceptanceRequestSchema,
  retryProjectConstitutionPublicationRequestSchema,
  scanProjectConstitutionRequestSchema,
  sessionExchangeRequestSchema,
  sessionExchangeResponseSchema,
  startMockPipelineRequestSchema,
  updateWorkItemRequestSchema,
  workItemChangesResponseSchema,
  workItemFileDiffResponseSchema,
  workItemResponseSchema,
  workItemsResponseSchema,
  workItemStateSchema,
  workItemWorkspaceResponseSchema,
  workflowSnapshotSchema,
  type ApiErrorResponse,
  type PublishedWorkItemWorkspace,
  type WorkflowStage,
  type WorkItemWorkspace,
} from "@loomrail/contracts";
import {
  adapterWorksInWorkspace,
  ConstitutionDomainError,
  WorkflowDomainError,
  WorkItemDomainError,
} from "@loomrail/domain";
import {
  openLocalState,
  StateStoreError,
  type OrphanProcessEvent,
  type OrphanWorkspaceEvent,
} from "@loomrail/persistence-sqlite";
import {
  constitutionPresets,
  ConstitutionPublicationError,
  proposeProjectConstitution,
  publishProjectConstitution,
  RepositoryScanError,
  scanProjectRepository,
} from "@loomrail/project-constitution";
import type { ProviderAdapter, ProviderId } from "@loomrail/provider-core";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import {
  GitMissingError,
  PathNotAFileError,
  PathOutsideWorktreeError,
  PathUnresolvableError,
  readFileDiff,
  summariseChanges,
} from "@loomrail/workspace";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import { broadcastingState } from "./broadcasting-state.js";
import { createEventStreamRegistry } from "./event-stream.js";
import {
  LOOMRAIL_PROVIDER_ENV_VAR,
  LOOMRAIL_PROVIDER_VALUES,
  resolveDefaultProviderAdapter,
} from "./provider-selection.js";
import {
  describeRegisteredRepository,
  FixtureResolutionError,
  isRegisteredRepositoryUsable,
  isSameExistingPath,
  materialiseFixtureRepository,
  ProjectRegistrationError,
  resolveBundledFixture,
  resolveRegisteredRepository,
} from "./fixtures.js";
import { createSessionWorker } from "./session-worker.js";
import { changeBaselineOf, MAX_PATCH_BYTES, MAX_SUMMARY_FILES } from "./workspace-changes.js";

const API_VERSION = "v1" as const;
const DAEMON_VERSION = "0.0.0";
const SESSION_COOKIE = "loomrail_session";
const CSRF_HEADER = "x-loomrail-csrf";
const BOOTSTRAP_TTL_MS = 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_MOCK_BUDGET = 100;
const DEFAULT_MOCK_BUDGET_THRESHOLDS = [0.5, 0.8, 0.95] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

type Clock = () => Date;

type DaemonLoggerOption = boolean | { level: string };
type DaemonLoggerStream = { write: (message: string) => void };

export type StartDaemonOptions = {
  bootstrapToken: string;
  webRoot?: string;
  stateDatabasePath?: string;
  /**
   * Where WorkItem worktrees are cut (spec D2): `<workspacesRoot>/<projectId>/<workItemId>`.
   *
   * Defaults to a `workspaces` directory beside the state database, which is what puts it in the
   * Loomrail data directory the launcher chose (`<data>/state.sqlite` -> `<data>/workspaces`). An
   * in-memory database has no directory to sit beside, and its state does not outlive the process,
   * so its workspaces are rooted under the OS temp directory rather than in a data directory that
   * would then hold worktrees nothing records.
   */
  workspacesRoot?: string;
  /**
   * Where a bundled fixture becomes a real repository: `<demoProjectsRoot>/<fixtureId>`.
   *
   * Defaulted like `workspacesRoot` above and for the same reason -- beside the state database is
   * the Loomrail data directory the launcher chose (`<data>/state.sqlite` -> `<data>/demo-projects`),
   * and an in-memory database has no data directory to sit beside. A fixture ships as a template
   * rather than a repository, because a nested `.git` cannot be committed to Loomrail's own
   * repository; this is where the template stops being one.
   *
   * The in-memory fallback carries a per-process segment, which is the one place this differs from
   * `workspacesRoot`'s. An in-memory daemon keeps no data directory and no Project past its own
   * lifetime, so there is nothing for two of them to share a demo repository *for* -- while sharing
   * one would mean unrelated processes cutting worktrees and writing objects in a single repository
   * at once, and every worktree any of them ever cut staying registered in it forever. That is
   * contention plus unbounded growth, not reuse. A real data directory gets exactly one demo
   * repository, which is the point.
   */
  demoProjectsRoot?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  now?: Clock;
  logger?: DaemonLoggerOption;
  loggerStream?: DaemonLoggerStream;
  // Injected so a test can drive the daemon's own dispatch drain with an adapter that hands off,
  // stalls, or runs into a wall. Without it the session-handoff paths are only ever reachable by
  // calling `runStageAttempt` directly, which is how a jam in the drain around those paths stayed
  // invisible. Production leaves this unset and gets whatever `resolveDefaultProviderAdapter`
  // resolves from `LOOMRAIL_PROVIDER` -- mock unless the owner opted into a live adapter.
  providerAdapter?: ProviderAdapter;
  // Injected for the same reason as `providerAdapter` above, and only for it: the heartbeat is the
  // one mechanism here that is driven by wall-clock time rather than by a request, so without a
  // shorter interval the only way to observe it end a stream is to wait out the real fifteen
  // seconds -- which is why the chain from the timer through `tick()` to the session recheck was
  // covered only in its middle link. Production always gets HEARTBEAT_INTERVAL_MS.
  heartbeatIntervalMs?: number;
  constitutionPublisher?: typeof publishProjectConstitution;
};

// One message per ending, so a reader grepping the daemon log finds all three. `FAILED` is the
// ending this milestone added: the process was alive at the liveness check and gone (or refusing
// the signal) a couple of milliseconds later, at the signal itself. It is not a daemon failure --
// startup carries on either way -- but it is not a kill either, and it used to be logged as one.
const orphanProcessMessages: Record<OrphanProcessEvent["action"], string> = {
  KILLED: "Killed the process an orphaned provider session left behind",
  SKIPPED: "Left an orphaned provider session's process alone",
  FAILED: "Could not signal the process an orphaned provider session left behind",
};

// Same reasoning as the orphan-process messages above, for the other thing startup reconciliation
// decides on its own: a workspace it found gone, and a workspace it could not check at all. Both are
// worth a line -- a READY workspace moved to ORPHANED is the reason the owner's next stage will stop
// and ask them something, and a check that could not run is the reason one that *should* have been
// orphaned was not.
const orphanWorkspaceMessages: Record<OrphanWorkspaceEvent["action"], string> = {
  ORPHANED: "Marked a work item's workspace orphaned; its worktree is gone",
  SKIPPED: "Could not check a work item's workspace; it was left as it is",
};

export type RunningDaemon = {
  app: FastifyInstance;
  baseUrl: string;
  bootstrapUrl: string;
  // What the launcher prints, and the answer to "did a live agent do this run?". `cliAvailable` is
  // `capabilities().start`: an adapter can be selected and still be unable to run, and the owner
  // should learn that at startup rather than from the first refused dispatch. `stages` is here for
  // the same reason -- an A2 adapter serves three of a run's six stages, and the launcher is the
  // one moment the owner is definitely reading.
  provider: {
    provider: ProviderId;
    cliAvailable: boolean;
    recognised: boolean;
    stages: readonly WorkflowStage[];
    // Whether this adapter works in the owner's repository at all (`adapterWorksInWorkspace`,
    // @loomrail/domain). Computed here rather than in the launcher because the domain owns the
    // answer, and the launcher restating it would be a second copy free to drift from the one the
    // dispatcher actually reads -- the session loop gates provisioning on the very same call, so an
    // owner told "it works in a worktree" is told it by the fact that decides it. Since E1 the
    // answer differs per adapter -- Codex declares all six stages, Claude Code three and no writing
    // one -- so the launcher can no longer say one thing about "a live provider".
    worksInRepository: boolean;
  };
  // Exposed for tests (spec D6): the alternative is a wait loop with a timeout in every test, and
  // on a loaded machine a timeout is indistinguishable from a defect. Resolves once the background
  // session worker has no pass running and none scheduled.
  whenIdle: () => Promise<void>;
  close: () => Promise<void>;
};

type Session = {
  csrfToken: string;
  expiresAt: Date;
};

type BootstrapGrant = {
  tokenHash: Buffer;
  expiresAt: Date;
  used: boolean;
};

const projectParamsSchema = z.object({ projectId: opaqueIdSchema }).strict();
const workItemParamsSchema = z.object({ workItemId: opaqueIdSchema }).strict();
const stageAttemptParamsSchema = z.object({ stageAttemptId: opaqueIdSchema }).strict();
const humanRequestParamsSchema = z.object({ humanRequestId: opaqueIdSchema }).strict();
const acceptanceParamsSchema = z
  .object({ workItemId: opaqueIdSchema, acceptancePackageId: opaqueIdSchema })
  .strict();
const workItemsQuerySchema = z.object({ state: workItemStateSchema.optional() }).strict();
// The one untrusted input E1.5 adds (spec D9, §8). Bounded like every other path this contract
// carries, and deliberately NOT trimmed: a trailing space is a legal character in a POSIX
// filename, so trimming would quietly answer for a different path than the one asked about. What
// the path is allowed to NAME is not decided here -- `resolveWorktreeRelativePath` in
// @loomrail/workspace decides that, and this route does not second-guess it with a check of its
// own (see the changes routes below).
const fileDiffQuerySchema = z.object({ path: z.string().min(1).max(4_096) }).strict();
const humanRequestsQuerySchema = z
  .object({ projectId: opaqueIdSchema.optional(), status: humanRequestStatusSchema.optional() })
  .strict();
const eventsQuerySchema = z
  .object({
    order: eventPageDirectionSchema.default("ASC"),
    after: z.coerce.number().int().nonnegative().default(0),
    before: z.coerce.number().int().positive().optional(),
    projectId: opaqueIdSchema.optional(),
    aggregateId: opaqueIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

const hashSecret = (value: string): Buffer => createHash("sha256").update(value).digest();

const encodeSecret = (): string => randomBytes(32).toString("base64url");

const secretsEqual = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

/**
 * The workspace as the HTTP contract publishes it: only what `publishedWorkItemWorkspaceSchema`
 * (workspace.ts) keeps.
 *
 * Named field by field rather than spread-and-delete, so the compiler owns the correspondence. A
 * field added to the stored workspace and meant to be published fails to compile here until it is
 * named; one that is *not* meant to be published simply never appears, rather than leaking because
 * a spread carried it. `leaseHolder`, `id`, `projectId`, `workItemId`, `createdAt` and `version` are
 * the omissions -- see the contract for why each has no consumer.
 */
const publishedWorkspace = (workspace: WorkItemWorkspace): PublishedWorkItemWorkspace => ({
  schemaVersion: workspace.schemaVersion,
  branch: workspace.branch,
  worktreePath: workspace.worktreePath,
  baseCommit: workspace.baseCommit,
  snapshotCommit: workspace.snapshotCommit,
  status: workspace.status,
});

const normalizePlatform = (): "darwin" | "win32" | "linux" | "other" => {
  const value = platform();
  return value === "darwin" || value === "win32" || value === "linux" ? value : "other";
};

type WorkItemChangesErrorCode =
  | "WORKSPACE_WORKTREE_MISSING"
  | "WORKSPACE_WORKTREE_UNREADABLE"
  | "WORKSPACE_HAS_NO_BASELINE"
  | "GIT_UNAVAILABLE"
  | "CHANGES_UNREADABLE";

/**
 * A read of what a work item changed that could not be done at all.
 *
 * Kept apart from the refusals @loomrail/workspace raises about the client's PATH (those carry
 * their own classes, mapped in `sendOperationError`): these are statements about the work item's
 * workspace -- the thing the read would have been done against -- and spec §7 answers the two
 * groups with different status codes, so collapsing them into one code would make the caller guess
 * which it was.
 *
 * `CHANGES_UNREADABLE` is the one that must never degrade into an empty summary (spec D7): an
 * empty file list is a claim that the worktree is unchanged, and "Loomrail could not read it" is
 * not that claim. Its message names the worktree and the baseline -- what the owner or a bug
 * report needs -- and never git's own output, which the spec keeps on this machine (§8).
 */
class WorkItemChangesError extends Error {
  readonly code: WorkItemChangesErrorCode;

  constructor(code: WorkItemChangesErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkItemChangesError";
    this.code = code;
  }
}

const createError = (
  code: string,
  message: string,
  correlationId: string,
  details?: Readonly<Record<string, string | number>>,
): ApiErrorResponse =>
  apiErrorResponseSchema.parse({
    error: {
      code,
      message,
      correlationId,
      ...(details === undefined ? {} : { details }),
    },
  });

const requestCorrelationId = (request: FastifyRequest): string => {
  const header = request.headers["x-correlation-id"];
  const parsed = correlationIdSchema.safeParse(header);
  return parsed.success ? parsed.data : randomUUID();
};

const sendOperationError = (
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  correlationId: string,
): FastifyReply => {
  if (error instanceof ZodError) {
    return reply
      .code(400)
      .send(createError("INVALID_REQUEST", "The request payload is invalid", correlationId));
  }
  if (error instanceof FixtureResolutionError) {
    return reply.code(400).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof ProjectRegistrationError) {
    // A path the owner named is a bad request; a fixture Loomrail could not materialise on its
    // behalf is not -- that one is this machine failing to do what it was asked, and saying 400
    // would send the owner looking for a mistake they did not make. Both carry their own code and
    // message rather than the generic 500 text, because both name the path the owner has to look at.
    const status = error.code === "FIXTURE_MATERIALISATION_FAILED" ? 500 : 400;
    return reply.code(status).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof RepositoryScanError) {
    return reply.code(409).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof ConstitutionPublicationError) {
    return reply.code(409).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof ConstitutionDomainError) {
    const status =
      error.code === "PROJECT_NOT_FOUND" ||
      error.code === "PROPOSAL_NOT_FOUND" ||
      error.code === "CONSTITUTION_NOT_FOUND" ||
      error.code === "PUBLICATION_NOT_FOUND"
        ? 404
        : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  // Spec §7's three path rows, including the two the last fix round added ("path names no file"
  // and "path the filesystem cannot resolve"). Each is raised by @loomrail/workspace's own
  // boundary and only MAPPED here: the reading is where a path is resolved, and a second check at
  // this layer could only ever disagree with the one that actually guards git. All three are 400
  // -- the client named something this work item's changes cannot be shown for -- and each carries
  // the message the reading built, which names the path the client sent and nothing about the
  // machine it was resolved on.
  if (error instanceof PathOutsideWorktreeError) {
    return reply.code(400).send(createError("PATH_OUTSIDE_WORKSPACE", error.message, correlationId));
  }
  if (error instanceof PathNotAFileError) {
    return reply.code(400).send(createError("PATH_NOT_A_FILE", error.message, correlationId));
  }
  if (error instanceof PathUnresolvableError) {
    return reply.code(400).send(createError("PATH_UNRESOLVABLE", error.message, correlationId));
  }
  if (error instanceof WorkItemChangesError) {
    if (error.code === "CHANGES_UNREADABLE" || error.code === "GIT_UNAVAILABLE") {
      // The two branches this machine, not the client, has to answer for: git could not be started
      // at all, or the read it ran could not be made sense of. Both are logged with the cause so
      // the diagnostic spec §7 asks for exists somewhere, and both answer with the named refusal
      // it demands instead of an empty summary.
      request.log.error({ correlationId, err: error }, error.message);
      return reply.code(500).send(createError(error.code, error.message, correlationId));
    }
    // A worktree that is gone or unreachable, or a workspace recorded with no base: the state on
    // this machine is not what a summary can be computed from. 409 rather than 404 -- the WorkItem
    // and its workspace both exist -- and rather than 200 with an empty list (spec D7).
    return reply.code(409).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof WorkItemDomainError) {
    const status = error.code === "WORK_ITEM_NOT_FOUND" || error.code === "PARENT_NOT_FOUND" ? 404 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof WorkflowDomainError) {
    const status =
      error.code === "WORKFLOW_NOT_FOUND" ||
      error.code === "WORKFLOW_DISPATCH_NOT_FOUND" ||
      error.code === "HUMAN_REQUEST_NOT_FOUND" ||
      error.code === "ACCEPTANCE_NOT_FOUND"
        ? 404
        : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof StateStoreError) {
    const status =
      error.code === "PROJECT_NOT_FOUND"
        ? 404
        : error.code === "COMMAND_ID_REUSED" ||
            error.code === "PROJECT_ALREADY_REGISTERED" ||
            // A repoint whose preconditions no longer hold is a conflict with the state on disk,
            // the same class of answer as a Project that is already registered.
            error.code === "PROJECT_REPOINT_REFUSED"
          ? 409
          : error.code === "STATE_CLOSED"
            ? 503
            : 500;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }

  request.log.error(
    { correlationId, errorName: error instanceof Error ? error.name : "UnknownError" },
    "Local state operation failed",
  );
  return reply
    .code(500)
    .send(createError("INTERNAL_ERROR", "The local operation could not be completed", correlationId));
};

export const startDaemon = async (options: StartDaemonOptions): Promise<RunningDaemon> => {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Loomrail local daemon can only bind to a loopback address");
  }

  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const bootstrap: BootstrapGrant = {
    tokenHash: hashSecret(options.bootstrapToken),
    expiresAt: new Date(startedAt.getTime() + BOOTSTRAP_TTL_MS),
    used: false,
  };
  const sessions = new Map<string, Session>();
  // Resolved as a value, not only as a constructed adapter: which provider a daemon is running --
  // and whether the environment asked for one this daemon does not know -- is something the owner
  // has to be able to see, in the log and in the launcher's startup report, before watching a
  // delivery run and drawing conclusions about who did the work.
  const providerResolution = resolveDefaultProviderAdapter();
  const providerAdapter = options.providerAdapter ?? providerResolution.adapter;
  const providerCapabilities = providerAdapter.capabilities();

  let allowedOrigin = "";
  let closing = false;

  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger:
      options.logger ??
      ({
        level: "info",
        redact: {
          paths: [
            "req.headers.cookie",
            "req.headers.authorization",
            `req.headers["${CSRF_HEADER}"]`,
            "res.headers.set-cookie",
          ],
          censor: "[REDACTED]",
        },
        ...(options.loggerStream === undefined ? {} : { stream: options.loggerStream }),
      } as const),
    genReqId: () => randomUUID(),
  });

  const eventStreams = createEventStreamRegistry({
    logger: app.log,
    // Spread rather than assigned, because `exactOptionalPropertyTypes` makes an explicit
    // `undefined` a different thing from an absent key -- the same shape `loggerStream` uses above.
    ...(options.heartbeatIntervalMs === undefined ? {} : { intervalMs: options.heartbeatIntervalMs }),
  });

  const databasePath = options.stateDatabasePath ?? ":memory:";
  // Beside the state database, which is where the launcher's data directory is; see the option's
  // own comment for what an in-memory database gets instead. Resolved once, at startup, so a later
  // change of working directory cannot move where an already-recorded workspace is looked for.
  const workspacesRoot =
    options.workspacesRoot ??
    (databasePath === ":memory:"
      ? join(tmpdir(), "loomrail-workspaces")
      : join(dirname(resolve(databasePath)), "workspaces"));
  // The same rule, resolved at the same moment, for the same reason: see the option's own comment.
  const demoProjectsRoot =
    options.demoProjectsRoot ??
    (databasePath === ":memory:"
      ? join(tmpdir(), "loomrail-demo-projects", randomUUID())
      : join(dirname(resolve(databasePath)), "demo-projects"));

  // The single seam every writer -- request handlers and `runStageAttempt` alike -- publishes
  // through, because there is exactly one `localState` and it is already wrapped by the time any
  // of them see it. See broadcasting-state.ts.
  const localState = broadcastingState(
    await openLocalState({
      databasePath,
      now,
      // Startup reconciliation SIGKILLs the process an orphaned ProviderSession left behind, on the
      // owner's own machine. That used to leave no record anywhere. Routed into the daemon's own
      // structured logger here rather than the store's stderr default -- and a skipped kill is
      // logged as loudly as a performed one, because "an orphan is still running and Loomrail chose
      // not to signal it" is the fact an owner would otherwise have no way to find.
      onOrphanProcess: (event) => {
        app.log.warn(
          { pid: event.pid, providerSessionId: event.sessionId, reason: event.reason },
          orphanProcessMessages[event.action],
        );
      },
      // The other half of the same gap: Task 10 gave reconciliation the ability to move a workspace
      // to ORPHANED, and nothing anywhere said so. Routed into the daemon's own structured logger
      // for the same reason the kill above is -- a decision Loomrail makes about the owner's disk,
      // on their machine, with no request behind it, has to leave a record they can find.
      onOrphanWorkspace: (event) => {
        app.log.warn(
          {
            workspaceId: event.workspaceId,
            workItemId: event.workItemId,
            worktreePath: event.worktreePath,
            reason: event.reason,
          },
          orphanWorkspaceMessages[event.action],
        );
      },
    }),
    eventStreams.publish,
    app.log,
  );

  const constitutionPublisher = options.constitutionPublisher ?? publishProjectConstitution;
  const publicationCommandId = (
    action: "complete" | "fail",
    publicationId: string,
    version: number,
  ): string =>
    `constitution-${action}-${createHash("sha256")
      .update(`${publicationId}\0${version.toString()}`)
      .digest("hex")}`;

  const drainConstitutionPublications = async (): Promise<void> => {
    const result = localState.query({ type: "LIST_PENDING_CONSTITUTION_PUBLICATIONS" });
    if (result.type !== "CONSTITUTION_PUBLICATIONS") return;
    for (const bundle of result.publications) {
      const projectResult = localState.query({
        type: "GET_PROJECT",
        projectId: bundle.publication.projectId,
      });
      const project = projectResult.type === "PROJECT" ? projectResult.project : null;
      try {
        if (project === null) {
          throw new ConstitutionPublicationError(
            "REPOSITORY_UNAVAILABLE",
            "The Project repository is no longer available",
          );
        }
        await constitutionPublisher({
          repositoryPath: project.repositoryPath,
          expectedTargetDigest: bundle.publication.expectedTargetDigest,
          renderedMarkdown: bundle.constitution.renderedMarkdown,
          contentDigest: bundle.constitution.contentDigest,
        });
        localState.execute({
          schemaVersion: 1,
          commandId: publicationCommandId("complete", bundle.publication.id, bundle.publication.version),
          correlationId: `constitution-publication-${bundle.publication.id}`,
          actor: { type: "SYSTEM", id: "constitution-publisher" },
          type: "COMPLETE_PROJECT_CONSTITUTION_PUBLICATION",
          payload: {
            publicationId: bundle.publication.id,
            expectedVersion: bundle.publication.version,
          },
        });
      } catch (error: unknown) {
        const errorCode =
          error instanceof ConstitutionPublicationError ? error.code : "CONSTITUTION_WRITE_FAILED";
        app.log.error(
          {
            publicationId: bundle.publication.id,
            projectId: bundle.publication.projectId,
            errorCode,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Constitution publication failed",
        );
        try {
          localState.execute({
            schemaVersion: 1,
            commandId: publicationCommandId("fail", bundle.publication.id, bundle.publication.version),
            correlationId: `constitution-publication-${bundle.publication.id}`,
            actor: { type: "SYSTEM", id: "constitution-publisher" },
            type: "FAIL_PROJECT_CONSTITUTION_PUBLICATION",
            payload: {
              publicationId: bundle.publication.id,
              expectedVersion: bundle.publication.version,
              errorCode,
            },
          });
        } catch (recordError: unknown) {
          app.log.error(
            {
              publicationId: bundle.publication.id,
              errorName: recordError instanceof Error ? recordError.name : "UnknownError",
            },
            "Constitution publication failure could not be recorded",
          );
        }
      }
    }
  };

  /**
   * Connections a client opened without ever sending a request on them.
   *
   * Closing the HTTP server reclaims idle keep-alive connections, but a connection that never
   * carried a request has no idle period to detect, so the server waits for a request that will
   * never arrive and `close` never settles. Browsers open such speculative connections routinely,
   * which would leave `loomrail` hanging on Ctrl+C. Shutdown reclaims them explicitly; connections
   * with a request in flight are left alone and still drain.
   */
  const unusedConnections = new Set<Socket>();
  app.server.on("connection", (socket: Socket) => {
    unusedConnections.add(socket);
    socket.once("close", () => unusedConnections.delete(socket));
  });
  app.server.on("request", (request: IncomingMessage) => {
    unusedConnections.delete(request.socket);
  });
  app.addHook("preClose", (done) => {
    // closeAll() drops open responses; stopHeartbeat() clears the ping timer. Distinct leaks, so
    // keep both -- dropping either while editing this hook leaves the other's leak uncaught.
    eventStreams.closeAll();
    eventStreams.stopHeartbeat();
    for (const socket of unusedConnections) socket.destroy();
    unusedConnections.clear();
    done();
  });

  // Spec §6: one stage attempt is a sequence of context-assembled provider sessions, not a single
  // provider call. The worker owns the whole dispatch queue as a background pass (A1.5 spec D4/D5);
  // `runStageAttempt` still owns everything inside one attempt.
  const worker = createSessionWorker({
    state: localState,
    adapter: providerAdapter,
    template: mockDeliveryTemplate,
    workspacesRoot,
    createCommandId: () => `session-${randomUUID()}`,
    logger: app.log,
  });

  localState.execute({
    schemaVersion: 1,
    commandId: `reconcile-${randomUUID()}`,
    correlationId: `startup-${randomUUID()}`,
    actor: { type: "SYSTEM", id: "local-daemon" },
    type: "RECONCILE_WORKFLOWS",
    payload: {},
  });
  // A behaviour improvement, not just a refactor: before this, a resumed attempt that could not run
  // kept the daemon from ever starting to listen at all. `wake()` schedules the first pass and
  // returns immediately, so the daemon reaches `app.listen` regardless of how that pass turns out --
  // a failure inside it is caught and logged by the worker's own pump (session-worker.ts), never
  // thrown here, so it is visible but never fatal to startup.
  worker.wake();

  const sessionForRequest = (request: FastifyRequest): Session | undefined => {
    const sessionToken = request.cookies[SESSION_COOKIE];
    if (!sessionToken) return undefined;
    const key = hashSecret(sessionToken).toString("hex");
    const session = sessions.get(key);
    if (!session || session.expiresAt.getTime() <= now().getTime()) {
      sessions.delete(key);
      return undefined;
    }
    return session;
  };

  const requireSession = (
    request: FastifyRequest,
    reply: FastifyReply,
    correlationId: string,
  ): Session | null => {
    const session = sessionForRequest(request);
    if (session) return session;
    void reply
      .code(401)
      .send(createError("SESSION_REQUIRED", "A valid local session is required", correlationId));
    return null;
  };

  const authorizeMutation = (
    request: FastifyRequest,
    reply: FastifyReply,
    correlationId: string,
  ): Session | null => {
    const session = requireSession(request, reply, correlationId);
    if (!session) return null;
    if (request.headers.origin !== allowedOrigin) {
      void reply
        .code(403)
        .send(createError("ORIGIN_REJECTED", "The request origin is not allowed", correlationId));
      return null;
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      void reply
        .code(415)
        .send(createError("JSON_REQUIRED", "Mutations require application/json", correlationId));
      return null;
    }
    const suppliedCsrf = request.headers[CSRF_HEADER];
    if (
      typeof suppliedCsrf !== "string" ||
      !secretsEqual(hashSecret(suppliedCsrf), hashSecret(session.csrfToken))
    ) {
      void reply
        .code(403)
        .send(createError("CSRF_REJECTED", "The CSRF token is missing or invalid", correlationId));
      return null;
    }
    return session;
  };

  try {
    await app.register(cookie);
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          // Headless overlay primitives position themselves by writing a style attribute. Allowing
          // inline style *attributes* keeps stylesheet injection (`style-src`) blocked; see
          // docs/security/THREAT-MODEL.md.
          styleSrcAttr: ["'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    });

    app.get("/health/live", () =>
      healthResponseSchema.parse({ status: "live", apiVersion: API_VERSION, timestamp: now().toISOString() }),
    );

    app.get("/health/ready", () =>
      healthResponseSchema.parse({
        status: "ready",
        apiVersion: API_VERSION,
        timestamp: now().toISOString(),
      }),
    );

    app.post("/api/session/exchange", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (request.headers.origin !== allowedOrigin) {
        return reply
          .code(403)
          .send(createError("ORIGIN_REJECTED", "The request origin is not allowed", correlationId));
      }

      const body = sessionExchangeRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .code(400)
          .send(createError("INVALID_BOOTSTRAP_REQUEST", "The bootstrap request is invalid", correlationId));
      }

      const suppliedHash = hashSecret(body.data.bootstrapToken);
      const expired = bootstrap.expiresAt.getTime() <= now().getTime();
      if (bootstrap.used || expired || !secretsEqual(bootstrap.tokenHash, suppliedHash)) {
        return reply
          .code(401)
          .send(
            createError("BOOTSTRAP_REJECTED", "The bootstrap token is invalid or expired", correlationId),
          );
      }

      bootstrap.used = true;
      const sessionToken = encodeSecret();
      const csrfToken = encodeSecret();
      const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
      sessions.set(hashSecret(sessionToken).toString("hex"), { csrfToken, expiresAt });

      reply.setCookie(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: Math.floor(SESSION_TTL_MS / 1_000),
      });

      return sessionExchangeResponseSchema.parse({
        authenticated: true,
        csrfToken,
        expiresAt: expiresAt.toISOString(),
      });
    });

    app.get("/api/v1/status", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;

      return daemonStatusResponseSchema.parse({
        apiVersion: API_VERSION,
        authenticated: true,
        daemon: {
          status: "online",
          version: DAEMON_VERSION,
          mode: "local",
          startedAt: startedAt.toISOString(),
          platform: normalizePlatform(),
        },
        foundation: {
          phase: "phase-0",
          milestone: "M6",
          providers: "mock-only",
          persistence: "sqlite",
        },
      });
    });

    app.get("/api/v1/projects", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const result = localState.query({ type: "LIST_PROJECTS" });
        const projects = result.type === "PROJECTS" ? result.projects : [];
        // Whether each Project's recorded path is still a repository, asked here rather than
        // stored, because it is a fact about the filesystem this minute (see
        // `projectRepositoryStatusSchema`). Without it the list is names alone, and the two demo
        // Projects on a database that predates E1 -- recorded at a directory inside Loomrail's own
        // checkout, where every IMPLEMENT and QA is refused -- look exactly like healthy ones.
        //
        // One `git rev-parse` per Project, in parallel, on a route the web client fetches on load
        // and after a registration rather than on a poll. That is the same inspection registration
        // already pays for, and the alternative -- a cheaper guess such as "is there a `.git` here"
        // -- would be a second definition of "is this a repository" that could disagree with the
        // one that actually refuses the stage.
        //
        // The probe cannot fail this route, and cannot hang it: `isRegisteredRepositoryUsable`
        // contains every rejection and bounds itself (see its own comment). That containment is the
        // difference between one Project being reported UNUSABLE and the owner losing the screen --
        // this route was a pure database read before the probe was added, and a machine with no
        // `git` on PATH, or a Project on a sleeping mount, would otherwise have made listing
        // Projects at all impossible.
        const repositoryStatuses = await Promise.all(
          projects.map(({ repositoryPath }) => isRegisteredRepositoryUsable(repositoryPath)),
        );
        return projectsResponseSchema.parse({
          schemaVersion: 1,
          projects: projects.map((project, index) => ({
            ...project,
            repositoryStatus: repositoryStatuses[index] === true ? "READY" : "UNUSABLE",
          })),
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/fixtures/register", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const body = registerFixtureProjectRequestSchema.parse(request.body);
        const fixture = await resolveBundledFixture(body.fixtureId);
        // A bundled fixture is a template in Loomrail's own checkout, never a repository. It
        // becomes one here, outside the checkout, so the Project records a repository Loomrail may
        // actually branch -- and so the provisioning guard passes it because it is genuinely
        // separate, not because anything was relaxed.
        //
        // A repository this call just built is not inspected again: `git init` and the first commit
        // both reported success, which is the same evidence an inspection would go looking for, and
        // every `git` invocation on this path costs a process the owner waits through. A directory
        // that was already there is a different claim -- nobody knows what it is -- so that one is
        // held to exactly the bar an owner's own repository would be.
        //
        // Read before materialising, because what this Project already records decides which of the
        // two commands below applies. The two demo Projects on a database that predates this
        // milestone record the bundled template itself -- migration 0012 carried their paths across
        // verbatim, as it must, since a migration cannot know the data directory. Registering again
        // used to materialise the repository and then answer PROJECT_ALREADY_REGISTERED, which left
        // the new repository orphaned on disk, the Project pointing at the template forever, and
        // every IMPLEMENT stage refused at a path no route could repair.
        const existing = localState.query({ type: "GET_PROJECT", projectId: fixture.projectId });
        const project = existing.type === "PROJECT" ? existing.project : null;
        // What "stale" means here is **not a usable repository**, not "still the bundled template".
        //
        // The template was only ever the first way to reach this state, and narrowing the repair to
        // it made "Repair demo repository" a button that could only fail for every other way: the
        // materialised `<data>/demo-projects/<id>` deleted or moved, its `.git` removed, or a second
        // daemon with a data directory of its own. All of those leave a demo Project recorded at a
        // path no stage can branch, the UI offers the button (it renders on `repositoryStatus`,
        // which asks exactly this question), and the route answered PROJECT_ALREADY_REGISTERED --
        // the path unchanged, the button still there, pressable forever.
        //
        // `isRegisteredRepositoryUsable` is the same judgment the list renders the button on, so
        // the button is offered and the repoint applies on one condition rather than two that can
        // disagree. The template comparison is kept as well, and first: it is two `realpath` calls
        // against a `git` invocation, and it still answers the one case usability does not -- an
        // owner who ran `git init` inside the bundled template, which makes the template its own
        // top level and therefore "usable" at a path that is nonetheless inside this checkout.
        //
        // The fence stays exactly where it was. `project.fixtureId === fixture.fixtureId` is what
        // guarantees a Project the owner registered by path is never repointed: such a Project
        // carries a null `fixtureId`, so it fails this test, and `REPOINT_FIXTURE_PROJECT` refuses
        // it again inside the write transaction (persistence-sqlite, precondition 1). Widening
        // *which paths* are repaired does not widen *whose* paths are.
        const stalePath =
          project !== null &&
          project.fixtureId === fixture.fixtureId &&
          ((await isSameExistingPath(project.repositoryPath, fixture.templatePath)) ||
            !(await isRegisteredRepositoryUsable(project.repositoryPath)))
            ? project.repositoryPath
            : null;
        if (project !== null && stalePath === null) {
          // A Project already recorded at this fixture's id, and not stuck at the bundled template --
          // most often a second daemon sharing this database with a data directory of its own, asking
          // to register the same demo fixture the first daemon already materialised and recorded.
          // `id = fixture.projectId` alone is enough for `executeFresh` (persistence-sqlite) to refuse
          // REGISTER_PROJECT with PROJECT_ALREADY_REGISTERED, before it ever reads `repositoryPath` --
          // so nothing is materialised for a registration that cannot land. Materialising ahead of
          // that refusal used to build a fresh repository under *this* daemon's own data directory and
          // then discard it on the 409, recorded by nothing: exactly the symptom the repoint path
          // fixed by reading before writing (see the comment above), reappearing here because this
          // branch reads the same `project` but still wrote before asking whether the write could
          // land. `project.repositoryPath` stands in for the payload's `repositoryPath` -- a real,
          // already-valid absolute path, never actually used, since the row lookup refuses on `id`
          // first.
          return localState.execute({
            schemaVersion: 1,
            commandId: body.commandId,
            correlationId,
            actor: { type: "HUMAN", id: "local-owner" },
            type: "REGISTER_PROJECT",
            payload: {
              id: fixture.projectId,
              fixtureId: fixture.fixtureId,
              name: fixture.name,
              repositoryPath: project.repositoryPath,
            },
          });
        }
        const materialised = await materialiseFixtureRepository(fixture, demoProjectsRoot);
        const repositoryPath = materialised.created
          ? materialised.repositoryPath
          : await resolveRegisteredRepository(materialised.repositoryPath);
        if (stalePath !== null) {
          // Only ever a fixture-backed Project whose recorded path no stage could branch: a Project
          // the owner registered by path has a null `fixtureId` and a different id, and cannot reach
          // here or past the persistence layer's own four checks.
          //
          // `expectedRepositoryPath` is the path read above, not re-read: the repoint must be
          // refused, not silently redirected, if anything moved the row between that read and this
          // write.
          return localState.execute({
            schemaVersion: 1,
            commandId: body.commandId,
            correlationId,
            actor: { type: "HUMAN", id: "local-owner" },
            type: "REPOINT_FIXTURE_PROJECT",
            payload: {
              projectId: fixture.projectId,
              fixtureId: fixture.fixtureId,
              expectedRepositoryPath: stalePath,
              repositoryPath,
            },
          });
        }
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "REGISTER_PROJECT",
          payload: {
            id: fixture.projectId,
            fixtureId: fixture.fixtureId,
            name: fixture.name,
            repositoryPath,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    // Registering the owner's own repository (spec §4, acceptance criterion 1).
    //
    // Its own route rather than a widening of the fixture one above: the two share no input and no
    // work. That one names a catalog entry and turns a bundled template into a repository; this one
    // names a path that is already a repository and only has to settle whether it may back a
    // Project. Folding them together would mean one body schema with two mutually exclusive fields
    // and a handler whose first act is to branch back apart.
    //
    // Nothing is relaxed for this path. `describeRegisteredRepository` refuses through
    // `resolveRegisteredRepository`, so a path that is not a repository is refused naming the path,
    // and a directory *inside* a repository gets the domain's honest "this is inside the repository
    // at X" -- which is what keeps an owner from handing an agent Loomrail's own source by
    // registering a subdirectory of this checkout. Both arrive as 400 with their own code.
    app.post("/api/v1/projects/register", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const body = registerRepositoryProjectRequestSchema.parse(request.body);
        const repository = await describeRegisteredRepository(body.repositoryPath);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "REGISTER_PROJECT",
          payload: {
            id: repository.id,
            // Null, not omitted: this Project has no bundled fixture behind it, and that is a fact
            // about it rather than a field nobody filled in.
            fixtureId: null,
            name: repository.name,
            repositoryPath: repository.repositoryPath,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/constitution-presets", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      return constitutionPresetsResponseSchema.parse({ schemaVersion: 1, presets: constitutionPresets });
    });

    app.get("/api/v1/projects/:projectId/constitution", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const project = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        if (project.type !== "PROJECT" || project.project === null) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        const result = localState.query({
          type: "GET_PROJECT_CONSTITUTION_SNAPSHOT",
          projectId: params.projectId,
        });
        if (result.type !== "PROJECT_CONSTITUTION_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The Constitution snapshot is unavailable");
        }
        return projectConstitutionSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/constitution/scan", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = scanProjectConstitutionRequestSchema.parse(request.body);
        const projectResult = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        const project = projectResult.type === "PROJECT" ? projectResult.project : null;
        if (project === null) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        const scan = await scanProjectRepository(project.repositoryPath);
        const proposal = proposeProjectConstitution({
          projectName: project.name,
          scan,
          ...(body.presetId === undefined ? {} : { presetId: body.presetId }),
        });
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "PROPOSE_PROJECT_CONSTITUTION",
          payload: {
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            ...proposal,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/constitution/adopt", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = adoptProjectConstitutionRequestSchema.parse(request.body);
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "REQUEST_PROJECT_CONSTITUTION_ADOPTION",
          payload: {
            projectId: params.projectId,
            proposalId: body.proposalId,
            expectedProjectVersion: body.expectedProjectVersion,
            expectedProposalVersion: body.expectedProposalVersion,
          },
        });
        await drainConstitutionPublications();
        const result = localState.query({
          type: "GET_PROJECT_CONSTITUTION_SNAPSHOT",
          projectId: params.projectId,
        });
        if (result.type !== "PROJECT_CONSTITUTION_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The Constitution snapshot is unavailable");
        }
        return projectConstitutionSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/constitution/publication/retry", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = retryProjectConstitutionPublicationRequestSchema.parse(request.body);
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "RETRY_PROJECT_CONSTITUTION_PUBLICATION",
          payload: {
            projectId: params.projectId,
            publicationId: body.publicationId,
            expectedVersion: body.expectedVersion,
          },
        });
        await drainConstitutionPublications();
        const result = localState.query({
          type: "GET_PROJECT_CONSTITUTION_SNAPSHOT",
          projectId: params.projectId,
        });
        if (result.type !== "PROJECT_CONSTITUTION_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The Constitution snapshot is unavailable");
        }
        return projectConstitutionSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/projects/:projectId/work-items", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const query = workItemsQuerySchema.parse(request.query);
        const project = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        if (project.type !== "PROJECT" || !project.project) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        const result = localState.query({
          type: "LIST_WORK_ITEMS",
          projectId: params.projectId,
          ...(query.state === undefined ? {} : { state: query.state }),
        });
        return workItemsResponseSchema.parse({
          schemaVersion: 1,
          workItems: result.type === "WORK_ITEMS" ? result.workItems : [],
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/work-items/:workItemId", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const result = localState.query({ type: "GET_WORK_ITEM", workItemId: params.workItemId });
        if (result.type !== "WORK_ITEM" || !result.workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        return workItemResponseSchema.parse({ schemaVersion: 1, workItem: result.workItem });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/work-items/:workItemId/workflow", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const workItem = localState.query({ type: "GET_WORK_ITEM", workItemId: params.workItemId });
        if (workItem.type !== "WORK_ITEM" || !workItem.workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        const result = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        return workflowSnapshotSchema.parse(
          result.type === "WORKFLOW_SNAPSHOT"
            ? result.snapshot
            : {
                schemaVersion: 1,
                run: null,
                stageAttempts: [],
                humanRequests: [],
                decisions: [],
                budgetPolicies: [],
                usageRecords: [],
                recoveryReports: [],
                artifacts: [],
                acceptancePackage: null,
              },
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    // Where this work item's agent writes: the repository branch and the worktree directory the
    // owner opens in their own editor (spec §4, "Что видно владельцу").
    //
    // Its own route rather than a field on GET_WORKFLOW_SNAPSHOT, because a workspace is a fact
    // about the WorkItem and not about its run: the snapshot answers with every list empty when
    // there is no PipelineRun, and a workspace cut by an earlier run would vanish from the card the
    // moment a run ended. Reading it here also costs one indexed row against `work_item_workspaces`
    // rather than joining it onto the query the board re-fetches on every event.
    app.get("/api/v1/work-items/:workItemId/workspace", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const workItem = localState.query({ type: "GET_WORK_ITEM", workItemId: params.workItemId });
        if (workItem.type !== "WORK_ITEM" || !workItem.workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        const result = localState.query({
          type: "GET_WORKSPACE_BY_WORK_ITEM",
          workItemId: params.workItemId,
        });
        const stored = result.type === "WORKSPACE" ? result.workspace : null;
        return workItemWorkspaceResponseSchema.parse({
          schemaVersion: 1,
          // A WorkItem with no workspace answers `null`, not 404: see the contract's note. The
          // WorkItem itself not existing is a genuine 404, and is raised above.
          //
          // Projected, not forwarded whole: `publishedWorkItemWorkspaceSchema` (workspace.ts) drops
          // `leaseHolder` plus every other field this route's one consumer never reads, and
          // `publishedWorkspace` below is what keeps that projection matching what the schema allows.
          workspace: stored === null ? null : publishedWorkspace(stored),
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    // What a work item's agent changed in that worktree, and the body of one file's diff --
    // E1.5's two handles (spec §5). Two rather than one on purpose (spec D5): the summary is cheap
    // and reread while a stage runs, a body is expensive and read only for the file the owner
    // expanded, and one handle answering both would make the cheap read pay for the expensive one.
    // Neither of the two below computes the other's work.
    //
    // Everything the two share -- which WorkItem, which worktree, which commit to compare against
    // -- is resolved once here. It answers `null` for a work item that has no workspace, which is
    // not a failure but the ordinary state of every prose-only stage (spec §7's first row).
    const changeReadContext = async (
      workItemId: string,
    ): Promise<{ worktreePath: string; baseline: string } | null> => {
      const workItem = localState.query({ type: "GET_WORK_ITEM", workItemId });
      if (workItem.type !== "WORK_ITEM" || !workItem.workItem) {
        throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
      }
      const result = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      const workspace = result.type === "WORKSPACE" ? result.workspace : null;
      if (workspace === null) {
        return null;
      }

      // Spec D1. Read from the one module that states it (`workspace-changes.ts`), because the
      // stage-end tree label measures from the same point and a second spelling here is how the
      // two would silently come to disagree.
      const baseline = changeBaselineOf(workspace);
      if (baseline === null) {
        // Not reachable through provisioning today, which refuses a repository with no commit to
        // branch from -- but both fields are nullable in the contract, and a summary computed from
        // no base is not a degraded summary, it is not one. Named rather than guessed at.
        throw new WorkItemChangesError(
          "WORKSPACE_HAS_NO_BASELINE",
          `The workspace at ${workspace.worktreePath} records no commit to compare the work item's changes against`,
        );
      }

      // Whether the worktree is still there is asked of the filesystem, never of
      // `workspace.status`. Reconciliation revisits that status at startup and at no other time
      // (E1 D12), so a READY workspace whose directory was deleted an hour ago still reads READY:
      // the directory is the fact and the row is a memory of it. Nothing is dispatched, repaired
      // or re-marked here -- this route reads, and a read that cannot be done says so.
      //
      // Asking first is also what keeps the refusal honest. git started with a working directory
      // that does not exist fails to spawn at all, and @loomrail/workspace reports a failure to
      // spawn as GitMissingError -- "git executable was not found" -- which would send the owner
      // looking for a broken git installation instead of at their deleted worktree.
      try {
        // `R_OK | X_OK` on the worktree ITSELF, never a bare `access` (which defaults to `F_OK`).
        // `F_OK` asks only whether the name resolves, which needs traverse permission on the
        // PARENTS and says nothing about the directory named -- so a worktree the daemon may see
        // but not enter passed this check and failed later, deeper, as something else: measured on
        // a chmod-0 worktree, the summary answered 500 CHANGES_UNREADABLE and the file diff
        // answered 400 PATH_UNRESOLVABLE, blaming the client's path for a workspace whose work is
        // intact behind a permission change. Both handles have to answer one condition one way,
        // and this is the check that decides it -- before the read, and before anything can reach
        // the "git could not be started" mapping below and tell the owner their git installation
        // is broken.
        await access(workspace.worktreePath, constants.R_OK | constants.X_OK);
      } catch (error: unknown) {
        // Two facts, kept apart rather than merged, because they are not the same news: a worktree
        // that is not there any more is gone for good (nothing in Loomrail resurrects one), while
        // one that cannot be reached may still be holding the agent's work behind a directory
        // whose permissions changed. Both are 409 and both name the path.
        //
        // The second is also this boundary's answer for an unreadable directory on the way to the
        // worktree. `resolveWorktreeRelativePath` deliberately does not dress that up as a bad
        // client path (@loomrail/workspace: a failure canonicalising the WORKTREE is not a
        // statement about the request), which leaves a bare EACCES with no named refusal -- so it
        // is named here, before the reading is entered at all, rather than reaching the owner as a
        // 500 about nothing they can see.
        const code = (error as NodeJS.ErrnoException).code;
        const missing = code === "ENOENT" || code === "ENOTDIR";
        throw new WorkItemChangesError(
          missing ? "WORKSPACE_WORKTREE_MISSING" : "WORKSPACE_WORKTREE_UNREADABLE",
          missing
            ? `The worktree at ${workspace.worktreePath} is no longer on disk`
            : `The worktree at ${workspace.worktreePath} could not be reached on this machine`,
          { cause: error },
        );
      }

      return { worktreePath: workspace.worktreePath, baseline };
    };

    /**
     * Runs one of the two reads and turns anything it fails on into a named refusal.
     *
     * The three refusals about the client's own path travel on untouched, because they already say
     * what happened and are mapped to 400 by `sendOperationError`.
     *
     * `git` not being on this machine at all gets its own code, because spec §7 gives it its own
     * row ("`git` не запустился") separate from the base's ("База не разрешается"). Both are this
     * machine failing rather than the client, but they are not the same failure and they do not
     * have the same fix: one is an installation to repair, the other a baseline that no longer
     * resolves after a rewritten history. Answering both with CHANGES_UNREADABLE named the
     * worktree and the base at an owner whose worktree and base are fine.
     *
     * Everything else -- a baseline that no longer resolves, git answering something the parser
     * cannot read, git exiting non-zero -- becomes CHANGES_UNREADABLE, whose message names the
     * worktree and the base. What neither must ever become is an empty summary: an empty file list
     * is a claim that the worktree is unchanged, and a read that did not happen is not entitled to
     * make it (spec D7).
     */
    const readOrRefuse = async <T>(
      context: { worktreePath: string; baseline: string },
      read: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await read();
      } catch (error: unknown) {
        if (
          error instanceof PathOutsideWorktreeError ||
          error instanceof PathNotAFileError ||
          error instanceof PathUnresolvableError
        ) {
          throw error;
        }
        if (error instanceof GitMissingError) {
          throw new WorkItemChangesError(
            "GIT_UNAVAILABLE",
            "The changes could not be read because git could not be started on this machine",
            { cause: error },
          );
        }
        throw new WorkItemChangesError(
          "CHANGES_UNREADABLE",
          `The changes in ${context.worktreePath} could not be read against ${context.baseline}`,
          { cause: error },
        );
      }
    };

    app.get("/api/v1/work-items/:workItemId/changes", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const context = await changeReadContext(params.workItemId);
        if (context === null) {
          return workItemChangesResponseSchema.parse({ schemaVersion: 1, changes: null });
        }
        const summary = await readOrRefuse(context, () =>
          summariseChanges({ ...context, maxFiles: MAX_SUMMARY_FILES }),
        );
        return workItemChangesResponseSchema.parse({
          schemaVersion: 1,
          changes: {
            schemaVersion: 1,
            baseline: context.baseline,
            files: summary.files,
            truncated: summary.truncated,
            // `summary.tree` is deliberately not carried. It is not the stage's tree label -- that
            // is a separate, baseline-independent reading (`treeOfWorktree`) taken at stage end, not
            // this request-time one -- but spec D3 says the label this milestone stores is not
            // shown, and this route has no reason to show a tree sha either.
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/work-items/:workItemId/changes/diff", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        // The path is parsed as a bounded string and handed on as it was sent. It is not validated
        // here: `readFileDiff` resolves it against the worktree and refuses what leaves it, what
        // the filesystem cannot resolve, and what names no single file (spec D9), and it is the
        // same code that then hands the path to git as a `:(literal)` pathspec. A second, separate
        // check at this layer is precisely how the two could come to disagree.
        const query = fileDiffQuerySchema.parse(request.query);
        const context = await changeReadContext(params.workItemId);
        if (context === null) {
          return workItemFileDiffResponseSchema.parse({ schemaVersion: 1, diff: null });
        }
        const diff = await readOrRefuse(context, () =>
          readFileDiff({ ...context, path: query.path, maxBytes: MAX_PATCH_BYTES }),
        );
        return workItemFileDiffResponseSchema.parse({
          schemaVersion: 1,
          diff: { schemaVersion: 1, ...diff },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    // Spec §D5's nesting, for the Task Cockpit (Task 12). Kept off GET_WORKFLOW_SNAPSHOT for the
    // same reason the persistence-layer query is: the snapshot is fetched on every board render,
    // and an attempt's session history grows without bound within it.
    app.get("/api/v1/stage-attempts/:stageAttemptId/sessions", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = stageAttemptParamsSchema.parse(request.params);
        const result = localState.query({
          type: "LIST_PROVIDER_SESSIONS",
          stageAttemptId: params.stageAttemptId,
        });
        return providerSessionsResponseSchema.parse({
          schemaVersion: 1,
          sessions: result.type === "PROVIDER_SESSIONS" ? result.sessions : [],
          checkpoints: result.type === "PROVIDER_SESSIONS" ? result.checkpoints : [],
          peakContextWindowUsage: result.type === "PROVIDER_SESSIONS" ? result.peakContextWindowUsage : {},
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    // The daemon runs one provider adapter for its whole process lifetime, so this is workspace-
    // wide rather than per work item: it answers "what would a session started right now run on".
    app.get("/api/v1/provider/capabilities", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const capabilities = providerAdapter.capabilities();
        return providerCapabilitiesResponseSchema.parse({
          schemaVersion: 1,
          provider: capabilities.provider,
          start: capabilities.start,
          stages: capabilities.stages,
          checkpointOnRequest: capabilities.checkpointOnRequest,
          contextWindowReporting: capabilities.contextWindowReporting,
          costReporting: capabilities.costReporting,
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/human-requests", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const query = humanRequestsQuerySchema.parse(request.query);
        const result = localState.query({
          type: "LIST_HUMAN_REQUESTS",
          ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
          ...(query.status === undefined ? {} : { status: query.status }),
        });
        return humanRequestsResponseSchema.parse({
          schemaVersion: 1,
          humanRequests: result.type === "HUMAN_REQUESTS" ? result.humanRequests : [],
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const body = createWorkItemRequestSchema.parse(request.body);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CREATE_WORK_ITEM",
          payload: {
            projectId: body.projectId,
            parentId: body.parentId,
            type: body.type,
            title: body.title,
            description: body.description,
            priority: body.priority,
            risk: body.risk,
            acceptanceCriteria: body.acceptanceCriteria,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.patch("/api/v1/work-items/:workItemId", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = updateWorkItemRequestSchema.parse(request.body);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "UPDATE_WORK_ITEM",
          payload: {
            workItemId: params.workItemId,
            expectedVersion: body.expectedVersion,
            patch: body.patch,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/move", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = moveWorkItemRequestSchema.parse(request.body);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "MOVE_WORK_ITEM",
          payload: {
            workItemId: params.workItemId,
            expectedVersion: body.expectedVersion,
            targetState: body.targetState,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/pipeline/start", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = startMockPipelineRequestSchema.parse(request.body);
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "START_MOCK_PIPELINE",
          payload: {
            workItemId: params.workItemId,
            expectedVersion: body.expectedVersion,
            template: mockDeliveryTemplate,
            budget: {
              maxEstimatedTokens: DEFAULT_MOCK_BUDGET,
              warningThresholds: [...DEFAULT_MOCK_BUDGET_THRESHOLDS],
            },
          },
        });
        worker.wake();
        const result = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (result.type !== "WORKFLOW_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The workflow snapshot could not be loaded");
        }
        return workflowSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/pipeline/pause", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = pipelineControlRequestSchema.parse(request.body);
        const snapshot = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (snapshot.type !== "WORKFLOW_SNAPSHOT" || !snapshot.snapshot.run) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow does not exist");
        }
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "PAUSE_PIPELINE",
          payload: {
            pipelineRunId: snapshot.snapshot.run.id,
            expectedVersion: body.expectedVersion,
          },
        });
        const result = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (result.type !== "WORKFLOW_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The workflow snapshot could not be loaded");
        }
        return workflowSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/pipeline/resume", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = pipelineControlRequestSchema.parse(request.body);
        const snapshot = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (snapshot.type !== "WORKFLOW_SNAPSHOT" || !snapshot.snapshot.run) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow does not exist");
        }
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "RESUME_PIPELINE",
          payload: {
            pipelineRunId: snapshot.snapshot.run.id,
            expectedVersion: body.expectedVersion,
          },
        });
        worker.wake();
        const result = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (result.type !== "WORKFLOW_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The workflow snapshot could not be loaded");
        }
        return workflowSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/pipeline/cancel", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = pipelineControlRequestSchema.parse(request.body);
        const snapshot = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (snapshot.type !== "WORKFLOW_SNAPSHOT" || !snapshot.snapshot.run) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow does not exist");
        }
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CANCEL_PIPELINE",
          payload: {
            pipelineRunId: snapshot.snapshot.run.id,
            expectedVersion: body.expectedVersion,
          },
        });
        const result = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (result.type !== "WORKFLOW_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The workflow snapshot could not be loaded");
        }
        return workflowSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/pipeline/budget-override", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = budgetOverrideRequestSchema.parse(request.body);
        const snapshot = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (snapshot.type !== "WORKFLOW_SNAPSHOT" || !snapshot.snapshot.run) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow does not exist");
        }
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "APPROVE_BUDGET_OVERRIDE",
          payload: {
            pipelineRunId: snapshot.snapshot.run.id,
            expectedVersion: body.expectedVersion,
            maxEstimatedTokens: body.maxEstimatedTokens,
          },
        });
        worker.wake();
        const result = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (result.type !== "WORKFLOW_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The workflow snapshot could not be loaded");
        }
        return workflowSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/human-requests/:humanRequestId/answer", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = humanRequestParamsSchema.parse(request.params);
        const body = answerHumanRequestRequestSchema.parse(request.body);
        const answered = localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "ANSWER_HUMAN_REQUEST",
          payload: {
            humanRequestId: params.humanRequestId,
            expectedVersion: body.expectedVersion,
            answer: body.answer,
          },
        });
        if (answered.type !== "HUMAN_REQUEST_ANSWERED") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The HumanRequest answer was not applied");
        }
        worker.wake();
        const result = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: answered.workItemId,
        });
        if (result.type !== "WORKFLOW_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The workflow snapshot could not be loaded");
        }
        return workflowSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/acceptance/:acceptancePackageId/resolve", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = acceptanceParamsSchema.parse(request.params);
        const body = resolveAcceptanceRequestSchema.parse(request.body);
        const current = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (
          current.type !== "WORKFLOW_SNAPSHOT" ||
          current.snapshot.acceptancePackage?.id !== params.acceptancePackageId
        ) {
          throw new WorkflowDomainError("ACCEPTANCE_NOT_FOUND", "The AcceptancePackage does not exist");
        }
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "RESOLVE_ACCEPTANCE",
          payload: {
            acceptancePackageId: params.acceptancePackageId,
            expectedVersion: body.expectedVersion,
            expectedRunVersion: body.expectedRunVersion,
            action: body.action,
            reason: body.reason,
          },
        });
        const result = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (result.type !== "WORKFLOW_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The workflow snapshot could not be loaded");
        }
        return workflowSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/events", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const query = eventsQuerySchema.parse(request.query);
        const result = localState.query({
          type: "LIST_EVENTS",
          direction: query.order,
          afterSequence: query.after,
          limit: query.limit,
          ...(query.before === undefined ? {} : { beforeSequence: query.before }),
          ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
          ...(query.aggregateId === undefined ? {} : { aggregateId: query.aggregateId }),
        });
        const exhaustedCursor = query.order === "DESC" ? (query.before ?? 0) : query.after;
        return eventsResponseSchema.parse({
          schemaVersion: 1,
          events: result.type === "EVENTS" ? result.events : [],
          nextSequence: result.type === "EVENTS" ? result.nextSequence : exhaustedCursor,
          hasMore: result.type === "EVENTS" ? result.hasMore : false,
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/stream", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      const session = requireSession(request, reply, correlationId);
      if (!session) return;
      // Checked when it is sent and not pretended to be checked when it is not: a same-origin GET
      // carries no Origin at all, so `sameSite: "strict"` plus the session is the actual defence --
      // the same footing every other GET on this daemon already stands on.
      const { origin } = request.headers;
      if (origin !== undefined && origin !== allowedOrigin) {
        return reply
          .code(403)
          .send(createError("ORIGIN_REJECTED", "The request origin is not allowed", correlationId));
      }
      // The limit has exactly one enforcement point, and it is `open()` itself: asking the registry
      // first, while there is still a reply to answer on, means a refusal is a 503 the client can
      // read rather than a 200 that closes immediately -- which `EventSource` would retry forever.
      // Registering the subscriber before the headers go out is safe because nothing between here
      // and the `write` below yields: `execute` and therefore `publish` are synchronous, so no
      // signal can reach this response ahead of its own status line.
      const release = eventStreams.open({
        response: reply.raw,
        isAuthorized: () => sessionForRequest(request) !== undefined,
      });
      if (!release) {
        return reply
          .code(503)
          .send(createError("STREAM_LIMIT_REACHED", "Too many open event streams", correlationId));
      }
      request.raw.on("close", release);

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      // Flushes the headers now, so the client's `open` fires immediately instead of whenever the
      // first real signal happens to arrive.
      reply.raw.write(": open\n\n");
    });

    if (options.webRoot) {
      const webRoot = resolve(options.webRoot);
      await access(webRoot);
      await app.register(fastifyStatic, { root: webRoot, wildcard: true });
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
          return reply
            .code(404)
            .send(
              createError(
                "NOT_FOUND",
                "The requested endpoint does not exist",
                requestCorrelationId(request),
              ),
            );
        }
        return reply.sendFile("index.html");
      });
    }

    await drainConstitutionPublications();

    // Said out loud at startup, both of them. An unrecognised value falls back to the mock rather
    // than stopping the daemon (a typo must not), but the mock then completes stages successfully:
    // without this warning the owner watches a full run and believes a live agent did it.
    if (!providerResolution.recognised) {
      app.log.warn(
        {
          [LOOMRAIL_PROVIDER_ENV_VAR]: providerResolution.requested,
          accepted: LOOMRAIL_PROVIDER_VALUES.join(", "),
        },
        `${LOOMRAIL_PROVIDER_ENV_VAR} names a provider this daemon does not know; it fell back to the mock adapter`,
      );
    }
    app.log.info(
      {
        provider: providerCapabilities.provider,
        cliAvailable: providerCapabilities.start,
        stages: providerCapabilities.stages.join(", "),
      },
      "The provider adapter this daemon will dispatch to",
    );

    const address = await app.listen({ host, port: options.port ?? 0 });
    const baseUrl = address.replace("[::1]", "127.0.0.1");
    allowedOrigin = baseUrl;
    const bootstrapUrl = `${baseUrl}/#bootstrap=${encodeURIComponent(options.bootstrapToken)}`;

    return {
      app,
      baseUrl,
      bootstrapUrl,
      provider: {
        provider: providerCapabilities.provider,
        cliAvailable: providerCapabilities.start,
        recognised: providerResolution.recognised,
        stages: providerCapabilities.stages,
        worksInRepository: adapterWorksInWorkspace(providerCapabilities.stages),
      },
      whenIdle: () => worker.whenIdle(),
      close: async () => {
        if (closing) return;
        closing = true;
        try {
          // The live session must be asked to stop before the server starts closing connections.
          await worker.stop();
          await app.close();
        } finally {
          localState.close();
        }
      },
    };
  } catch (error: unknown) {
    localState.close();
    await app.close();
    throw error;
  }
};
