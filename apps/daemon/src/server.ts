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
  createPlaywrightDriver,
  openVerifiedBrowserQAArtifact,
  type BrowserDriver,
} from "@loomrail/browser-qa";
import {
  attentionInboxResponseSchema,
  agentFleetResponseSchema,
  answerHumanRequestRequestSchema,
  attestProjectReadinessRequestSchema,
  adoptVerificationPlanRequestSchema,
  disableVerificationPlanRequestSchema,
  adoptProjectConstitutionRequestSchema,
  apiErrorResponseSchema,
  budgetOverrideRequestSchema,
  correlationIdSchema,
  constitutionPresetsResponseSchema,
  createWorkItemRequestSchema,
  daemonStatusResponseSchema,
  disposeReviewFindingRequestSchema,
  eventPageDirectionSchema,
  eventsResponseSchema,
  healthResponseSchema,
  humanRequestStatusSchema,
  humanRequestsResponseSchema,
  insightsResponseSchema,
  moveWorkItemRequestSchema,
  mcpProfilesResponseSchema,
  mcpProfileProposalSchema,
  MAX_QA_RUN_HISTORY,
  opaqueIdSchema,
  pipelineControlRequestSchema,
  projectConstitutionSnapshotSchema,
  projectProviderSelectionResponseSchema,
  projectProviderAllowanceResponseSchema,
  projectReadinessSnapshotSchema,
  proposeProjectScaffoldRequestSchema,
  proposeProjectScaffoldResponseSchema,
  projectsResponseSchema,
  providerAllowanceSnapshotSchema,
  providerCapabilitiesResponseSchema,
  providerSessionsResponseSchema,
  qaDefectWaivedResultSchema,
  qaCorrectionGateResolvedResultSchema,
  verificationCorrectionGateResolvedResultSchema,
  qaStateResponseSchema,
  resolveQACorrectionGateRequestSchema,
  resolveVerificationCorrectionGateRequestSchema,
  waiveQADefectRequestSchema,
  proposeContext7PresetRequestSchema,
  proposeMcpProfileRequestSchema,
  confirmMcpProfileRequestSchema,
  probeMcpProfileRequestSchema,
  registerFixtureProjectRequestSchema,
  registerRepositoryProjectRequestSchema,
  refreshProviderAvailabilityRequestSchema,
  refreshProviderAllowanceRequestSchema,
  providerAllowanceQuerySchema,
  resolveAcceptanceRequestSchema,
  reviewFindingDisposedResultSchema,
  reviewStateResponseSchema,
  revokeMcpProfileGrantRequestSchema,
  retryProjectConstitutionPublicationRequestSchema,
  retryVerificationPlanPublicationRequestSchema,
  retryVerificationRunRequestSchema,
  retryProjectScaffoldRequestSchema,
  scaffoldProposalSchema,
  runProjectReadinessRequestSchema,
  scanProjectConstitutionRequestSchema,
  scaffoldOperationResponseSchema,
  scaffoldOperationsResponseSchema,
  publishProjectScaffoldRequestSchema,
  setProjectProviderPreferenceRequestSchema,
  setMcpProfileGrantRequestSchema,
  sessionExchangeRequestSchema,
  sessionExchangeResponseSchema,
  startMockPipelineRequestSchema,
  startVerificationRunRequestSchema,
  cancelVerificationRunRequestSchema,
  updateWorkItemRequestSchema,
  workItemChangesResponseSchema,
  workItemFileDiffResponseSchema,
  workItemResponseSchema,
  workItemsResponseSchema,
  workItemStateSchema,
  workItemWorkspaceResponseSchema,
  workflowSnapshotSchema,
  verificationPlanSettingsResponseSchema,
  verificationRunSnapshotResponseSchema,
  verificationRunsResponseSchema,
  type ApiErrorResponse,
  type DomainEvent,
  type PublishedWorkItemWorkspace,
  type Project,
  type ProviderAllowanceSnapshot,
  type QAAttachmentRef,
  type QAAttachmentSummary,
  type ScaffoldOperationErrorCode,
  type WorkflowStage,
  type WorkItemWorkspace,
} from "@loomrail/contracts";
import {
  adapterWorksInWorkspace,
  buildReportingSnapshot,
  MAX_RELEASE_SUMMARY_AUDIT_EVENTS,
  ConstitutionDomainError,
  McpDomainError,
  ProviderSelectionDomainError,
  ProviderAllowanceDomainError,
  QADefectDispositionError,
  QACorrectionError,
  VerificationCorrectionError,
  ReadinessDomainError,
  VerificationDomainError,
  projectVerificationRunFreshness,
  renderReleaseSummary,
  ReviewFindingDispositionError,
  ScaffoldDomainError,
  WorkflowDomainError,
  WorkItemDomainError,
} from "@loomrail/domain";
import { canonicalMcpProfileSource } from "@loomrail/domain";
import { createMcpGateway, McpGatewayError, type McpGateway } from "@loomrail/mcp-gateway";
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
import {
  assessProjectReadiness,
  ProjectReadinessScanError,
  ProjectVerificationPublicationError,
  ProjectVerificationScanError,
  publishVerificationPlan,
  scanVerificationPlanProposal,
} from "@loomrail/project-readiness";
import {
  ProjectScaffoldingError,
  proposeProjectScaffold,
  publishProjectScaffold,
} from "@loomrail/project-scaffolding";
import type { ProviderAdapter, ProviderId } from "@loomrail/provider-core";
import { validateSchedulerLimits, type SchedulerLimits } from "@loomrail/scheduler";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import {
  GitMissingError,
  PathNotAFileError,
  PathOutsideWorktreeError,
  PathUnresolvableError,
  readFileDiff,
  summariseChanges,
  treeOfWorktree,
} from "@loomrail/workspace";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import { broadcastingState } from "./broadcasting-state.js";
import { resolveProjectBrowserQAConfig, type BrowserQAConfigResolver } from "./browser-qa-config.js";
import { reconcileBrowserQAArtifacts } from "./browser-qa-recovery.js";
import { cleanupExpiredBrowserQAArtifacts } from "./browser-qa-retention.js";
import { cleanupExpiredVerificationOutputs } from "./verification-output-retention.js";
import { createBrowserQAStageRunner } from "./browser-qa-runner.js";
import { buildAgentFleet } from "./agent-fleet.js";
import {
  CONTEXT7_PRESET_NAME,
  CONTEXT7_PRESET_TOOLS,
  Context7PresetError,
  resolveBundledContext7Candidate,
} from "./context7-preset.js";
import { createEventStreamRegistry } from "./event-stream.js";
import {
  createProviderRegistry,
  LOOMRAIL_PROVIDER_ENV_VAR,
  LOOMRAIL_PROVIDER_VALUES,
  resolveDefaultProviderAdapter,
  type ProviderRegistry,
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
import { createProjectVerificationWorkflowGate } from "./project-verification-gate.js";
import { createProjectVerificationRunner, type VerificationRecipeExecutor } from "./verification-runner.js";
import { describeReportingRuntime } from "./reporting.js";
import { createMcpProposalChallengeStore, McpProposalError } from "./mcp-proposals.js";
import { createMcpConnectionOpener } from "./mcp-sessions.js";
import { changeBaselineOf, MAX_PATCH_BYTES, MAX_SUMMARY_FILES } from "./workspace-changes.js";
import { projectProviderAllowanceResponse } from "./provider-allowance.js";

const API_VERSION = "v1" as const;
const DAEMON_VERSION = "0.0.0";
const SESSION_COOKIE = "loomrail_session";
const CSRF_HEADER = "x-loomrail-csrf";
const BOOTSTRAP_TTL_MS = 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const LEGACY_MOCK_BUDGET = 100;
const DEFAULT_MOCK_BUDGET_THRESHOLDS = [0.5, 0.8, 0.95] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const PROVIDER_ALLOWANCE_READ_DEADLINE_MS = 3_000;

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
  /** Release version shown in diagnostics and privacy-safe report previews. */
  productVersion?: string;
  now?: Clock;
  logger?: DaemonLoggerOption;
  loggerStream?: DaemonLoggerStream;
  // Injected so a test can drive the daemon's own dispatch drain with an adapter that hands off,
  // stalls, or runs into a wall. Without it the session-handoff paths are only ever reachable by
  // calling `runStageAttempt` directly, which is how a jam in the drain around those paths stayed
  // invisible. Production leaves this unset and resolves from the Project preference plus safe
  // compatibility/auth observations; an environment override is optional but cannot bypass admission.
  providerAdapter?: ProviderAdapter;
  /** Injected availability/routing seam for deterministic provider-selection integration tests. */
  providerRegistry?: ProviderRegistry;
  /** Test seam; production always uses the Q16 three-second outer allowance deadline. */
  providerAllowanceReadDeadlineMs?: number;
  /** Optional bounded A3 concurrency policy; defaults to three globally, per Project and provider. */
  schedulingLimits?: SchedulerLimits;
  /** Test seam; production reads `.loomrail/browser-qa.json` and uses isolated Playwright. */
  browserQADriver?: BrowserDriver;
  /** Test seam for a validated project-local target and manifest. */
  browserQAConfigResolver?: BrowserQAConfigResolver;
  /** Test seam; production stores heavy QA evidence beside the state database. */
  browserQAArtifactsDirectory?: string;
  /** Test seam; production stores bounded verification output outside every Project worktree. */
  verificationArtifactsDirectory?: string;
  /** Test seam; production owns the exact-argv supervised recipe executor. */
  verificationRecipeExecutor?: VerificationRecipeExecutor;
  /** Injected only for daemon route tests; production owns the real bounded stdio gateway. */
  mcpGateway?: McpGateway;
  // Injected for the same reason as `providerAdapter` above, and only for it: the heartbeat is the
  // one mechanism here that is driven by wall-clock time rather than by a request, so without a
  // shorter interval the only way to observe it end a stream is to wait out the real fifteen
  // seconds -- which is why the chain from the timer through `tick()` to the session recheck was
  // covered only in its middle link. Production always gets HEARTBEAT_INTERVAL_MS.
  heartbeatIntervalMs?: number;
  constitutionPublisher?: typeof publishProjectConstitution;
  /** Test seam; production writes the marker-bound owner-approved verification Plan. */
  verificationPlanPublisher?: typeof publishVerificationPlan;
  /** Injected only for crash/failure integration tests; production uses the marker-bound publisher. */
  scaffoldPublisher?: typeof publishProjectScaffold;
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
const scaffoldParamsSchema = z.object({ operationId: opaqueIdSchema }).strict();
const mcpProposalParamsSchema = z.object({ projectId: opaqueIdSchema, challengeId: opaqueIdSchema }).strict();
const mcpRevisionParamsSchema = z.object({ projectId: opaqueIdSchema, revisionId: opaqueIdSchema }).strict();
const workItemParamsSchema = z.object({ workItemId: opaqueIdSchema }).strict();
const verificationRunParamsSchema = z.object({ runId: opaqueIdSchema }).strict();
const verificationCheckParamsSchema = z.object({ checkId: opaqueIdSchema }).strict();
const qaAttachmentParamsSchema = z
  .object({ workItemId: opaqueIdSchema, attachmentId: opaqueIdSchema })
  .strict();

const publishQAAttachment = (attachment: QAAttachmentRef): QAAttachmentSummary => ({
  schemaVersion: attachment.schemaVersion,
  id: attachment.id,
  qaRunId: attachment.qaRunId,
  kind: attachment.kind,
  contentHash: attachment.contentHash,
  byteSize: attachment.byteSize,
  targetId: attachment.targetId,
  scenarioId: attachment.scenarioId,
  capturedAt: attachment.capturedAt,
  retentionClass: attachment.retentionClass,
});
const stageAttemptParamsSchema = z.object({ stageAttemptId: opaqueIdSchema }).strict();
const humanRequestParamsSchema = z.object({ humanRequestId: opaqueIdSchema }).strict();
const reviewFindingParamsSchema = z.object({ findingId: opaqueIdSchema }).strict();
const qaDefectParamsSchema = z.object({ defectId: opaqueIdSchema }).strict();
const qaCorrectionGateParamsSchema = z
  .object({ workItemId: opaqueIdSchema, humanRequestId: opaqueIdSchema })
  .strict();
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
    // Handlers parse their own responses through the same schemas inside the same `try`, so a
    // ZodError here is not always the client's fault: a persisted row that no longer satisfies a
    // response contract lands here too. It cannot be told apart at this point, so it is at least
    // recorded -- issue paths only, never the values -- instead of being returned as a silent 400.
    request.log.warn(
      {
        correlationId,
        issues: error.issues.slice(0, 5).map((issue) => issue.path.map(String).join(".")),
      },
      "A request or response did not satisfy its contract",
    );
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
  if (error instanceof ProjectReadinessScanError) {
    const status = error.code === "GIT_UNAVAILABLE" ? 500 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof ProjectVerificationScanError) {
    return reply.code(409).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof ProjectVerificationPublicationError) {
    return reply.code(409).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof ProjectScaffoldingError) {
    const status =
      error.code === "INVALID_OPERATION_ID" ||
      error.code === "INVALID_TARGET_PATH" ||
      error.code === "TARGET_NAME_UNSUPPORTED" ||
      error.code === "RECIPE_UNAVAILABLE"
        ? 400
        : error.code === "GIT_INIT_FAILED" || error.code === "REPOSITORY_INVALID"
          ? 500
          : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId));
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
  if (error instanceof ReadinessDomainError) {
    const status =
      error.code === "PROJECT_NOT_FOUND" ||
      error.code === "READINESS_RUN_NOT_FOUND" ||
      error.code === "READINESS_CHECK_NOT_FOUND"
        ? 404
        : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof VerificationDomainError) {
    const status =
      error.code === "PROJECT_NOT_FOUND" ||
      error.code === "PUBLICATION_NOT_FOUND" ||
      error.code === "WORK_ITEM_NOT_FOUND"
        ? 404
        : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof ScaffoldDomainError) {
    const status =
      error.code === "PROJECT_NOT_FOUND" || error.code === "SCAFFOLD_OPERATION_NOT_FOUND" ? 404 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof ProviderSelectionDomainError) {
    const status = error.code === "PROJECT_NOT_FOUND" ? 404 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof McpProposalError) {
    const status =
      error.code === "MCP_PROPOSAL_NOT_FOUND" ? 404 : error.code === "MCP_PROPOSAL_LIMIT_REACHED" ? 429 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof Context7PresetError) {
    return reply.code(503).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof McpGatewayError) {
    const status = error.code === "CONSENT_MISMATCH" || error.code === "PROBE_ALREADY_RUNNING" ? 409 : 400;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof McpDomainError) {
    const status =
      error.code === "PROJECT_NOT_FOUND" ||
      error.code === "PROFILE_NOT_FOUND" ||
      error.code === "CONSENT_NOT_FOUND" ||
      error.code === "GRANT_NOT_FOUND"
        ? 404
        : error.code === "EXECUTABLE_FORBIDDEN" || error.code === "SCRIPT_PATH_REQUIRED"
          ? 400
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
  if (error instanceof ReviewFindingDispositionError) {
    const status = error.code === "REVIEW_FINDING_NOT_FOUND" ? 404 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof QADefectDispositionError) {
    const status = error.code === "QA_DEFECT_NOT_FOUND" ? 404 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof QACorrectionError) {
    const status = error.code === "QA_CORRECTION_REQUEST_INVALID" ? 404 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof VerificationCorrectionError) {
    const status = error.code === "REQUEST_INVALID" ? 404 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId));
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
      error.code === "PROJECT_NOT_FOUND" ||
      error.code === "VERIFICATION_RUN_NOT_FOUND" ||
      error.code === "VERIFICATION_CHECK_NOT_FOUND"
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
  const productVersion = options.productVersion ?? DAEMON_VERSION;
  const reportingRuntime = describeReportingRuntime({ productVersion });

  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const bootstrap: BootstrapGrant = {
    tokenHash: hashSecret(options.bootstrapToken),
    expiresAt: new Date(startedAt.getTime() + BOOTSTRAP_TTL_MS),
    used: false,
  };
  const sessions = new Map<string, Session>();
  const databasePath = options.stateDatabasePath ?? ":memory:";
  const mcpGateway =
    options.mcpGateway ??
    createMcpGateway({
      ...(databasePath === ":memory:"
        ? {}
        : { registryDirectory: join(dirname(resolve(databasePath)), "mcp-processes") }),
    });
  const mcpProposals = createMcpProposalChallengeStore({
    now,
    createId: () => randomUUID(),
  });
  // Resolved as a value, not only as a constructed adapter: which provider a daemon is running --
  // and whether the environment asked for one this daemon does not know -- is something the owner
  // has to be able to see, in the log and in the launcher's startup report, before watching a
  // delivery run and drawing conclusions about who did the work.
  const providerResolution = resolveDefaultProviderAdapter();
  // Existing integration tests deliberately exercise deterministic workflows and historically
  // relied on an unset environment meaning Mock. Keep that harness deterministic unless the test
  // explicitly supplies a provider env/registry; production never runs with NODE_ENV=test.
  const registryEnvironment =
    process.env["NODE_ENV"] === "test" && process.env[LOOMRAIL_PROVIDER_ENV_VAR] === undefined
      ? { ...process.env, [LOOMRAIL_PROVIDER_ENV_VAR]: "MOCK" }
      : process.env;
  const providerRegistry = options.providerRegistry ?? createProviderRegistry({ env: registryEnvironment });
  await providerRegistry.refresh();
  const fixedProviderAdapter = options.providerAdapter;
  const schedulingLimits = validateSchedulerLimits(options.schedulingLimits);
  const allowanceReads = new Map<ProviderId, Promise<ProviderAllowanceSnapshot>>();
  const allowanceReadDeadlineMs = z
    .number()
    .int()
    .positive()
    .max(PROVIDER_ALLOWANCE_READ_DEADLINE_MS)
    .parse(options.providerAllowanceReadDeadlineMs ?? PROVIDER_ALLOWANCE_READ_DEADLINE_MS);

  const withAllowanceDeadline = (
    provider: ProviderId,
    pending: Promise<ProviderAllowanceSnapshot>,
    onTimeout: () => void,
  ): Promise<ProviderAllowanceSnapshot> =>
    new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (result: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        result();
      };
      const timer = setTimeout(() => {
        onTimeout();
        finish(() => {
          resolvePromise(
            providerAllowanceSnapshotSchema.parse({
              schemaVersion: 1,
              provider,
              observedAt: now().toISOString(),
              freshness: "UNAVAILABLE",
              buckets: [],
              unavailableReason: "PROVIDER_TIMEOUT",
            }),
          );
        });
      }, allowanceReadDeadlineMs);
      timer.unref();
      pending.then(
        (snapshot) => {
          finish(() => {
            resolvePromise(snapshot);
          });
        },
        (error: unknown) => {
          finish(() => {
            rejectPromise(
              error instanceof Error
                ? error
                : new Error("The provider allowance reader rejected without an Error", { cause: error }),
            );
          });
        },
      );
    });

  const readAllowanceOnce = (
    provider: ProviderId,
    adapter: ProviderAdapter,
  ): Promise<ProviderAllowanceSnapshot> => {
    const current = allowanceReads.get(provider);
    if (current !== undefined) {
      return withAllowanceDeadline(provider, current, () => {
        if (allowanceReads.get(provider) === current) allowanceReads.delete(provider);
      });
    }
    if (adapter.readAllowance === undefined) {
      throw new StateStoreError(
        "PERSISTENCE_FAILURE",
        "The selected provider has no bounded allowance reader",
      );
    }
    const pending = adapter.readAllowance();
    allowanceReads.set(provider, pending);
    pending.then(
      () => {
        if (allowanceReads.get(provider) === pending) allowanceReads.delete(provider);
      },
      () => {
        if (allowanceReads.get(provider) === pending) allowanceReads.delete(provider);
      },
    );
    return withAllowanceDeadline(provider, pending, () => {
      if (allowanceReads.get(provider) === pending) allowanceReads.delete(provider);
    });
  };

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

  for (const report of await mcpGateway.recoverOrphans()) {
    app.log.warn(
      {
        action: report.action,
        processRecord: report.recordFile,
        reason: report.reason,
        serverPid: report.serverPid,
      },
      "MCP orphan process reconciliation completed",
    );
  }

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
  const browserQAArtifactsDirectory =
    options.browserQAArtifactsDirectory ??
    (databasePath === ":memory:"
      ? join(tmpdir(), "loomrail-browser-qa", randomUUID())
      : join(dirname(resolve(databasePath)), "artifacts"));
  const verificationArtifactsDirectory =
    options.verificationArtifactsDirectory ??
    (databasePath === ":memory:"
      ? join(tmpdir(), "loomrail-verification-output", randomUUID())
      : join(dirname(resolve(databasePath)), "verification-output"));

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

  const resolveProjectProvider = (
    projectId: string,
    stage?: WorkflowStage,
    avoidProvider?: ProviderId | null,
  ) => {
    if (fixedProviderAdapter !== undefined) return fixedProviderAdapter;
    const result = localState.query({ type: "GET_PROJECT", projectId });
    if (result.type !== "PROJECT" || result.project === null) {
      throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
    }
    return providerRegistry.resolve(result.project, { stage, avoidProvider }).adapter;
  };

  // Startup has to report what AUTO means even before the first Project is registered. This value
  // is never persisted or returned as a Project; it only supplies the preference fields the same
  // resolver requires for an ordinary Project.
  const startupProjectionProject: Project = {
    schemaVersion: 1,
    id: "provider-startup-projection",
    workspaceId: "workspace-local",
    fixtureId: null,
    name: "Provider startup projection",
    repositoryPath: resolve("/"),
    providerPreference: "AUTO",
    status: "ACTIVE",
    version: 1,
    createdAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
  };
  const listedProjects = localState.query({ type: "LIST_PROJECTS" });
  const startupProject =
    listedProjects.type === "PROJECTS"
      ? (listedProjects.projects[0] ?? startupProjectionProject)
      : startupProjectionProject;
  const startupProviderAdapter = fixedProviderAdapter ?? providerRegistry.resolve(startupProject).adapter;
  const providerCapabilities = startupProviderAdapter.capabilities();

  await reconcileBrowserQAArtifacts({
    state: localState,
    artifactsDirectory: browserQAArtifactsDirectory,
    logger: app.log,
  });
  await cleanupExpiredBrowserQAArtifacts({
    state: localState,
    artifactsDirectory: browserQAArtifactsDirectory,
    now: now(),
    logger: app.log,
  });
  await cleanupExpiredVerificationOutputs({
    state: localState,
    artifactsDirectory: verificationArtifactsDirectory,
    now: now(),
    logger: app.log,
  });

  const constitutionPublisher = options.constitutionPublisher ?? publishProjectConstitution;
  const publicationCommandId = (
    action: "complete" | "fail",
    publicationId: string,
    version: number,
  ): string =>
    `constitution-${action}-${createHash("sha256")
      .update(`${publicationId}\0${version.toString()}`)
      .digest("hex")}`;

  // Drains are serialised. Each one lists EVERY pending row, and two request handlers awaiting the
  // same drain concurrently would publish the same operation twice: the loser then records a FAIL
  // (EEXIST on the target) that lands before the winner's COMPLETE, and a fully written result is
  // shown as failed. One chain per drain kind; a failed pass never blocks the next.
  const serialised = (run: () => Promise<void>): (() => Promise<void>) => {
    let chain: Promise<void> = Promise.resolve();
    return () => {
      chain = chain.then(run, run);
      return chain;
    };
  };

  const drainConstitutionPublications = serialised(async (): Promise<void> => {
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
  });

  const verificationPlanPublisher = options.verificationPlanPublisher ?? publishVerificationPlan;
  const verificationPublicationCommandId = (
    action: "complete" | "fail",
    publicationId: string,
    version: number,
  ): string =>
    `verification-plan-${action}-${createHash("sha256")
      .update(`${publicationId}\0${version.toString()}`)
      .digest("hex")}`;

  const drainVerificationPlanPublications = async (): Promise<void> => {
    const result = localState.query({ type: "LIST_PENDING_VERIFICATION_PLAN_PUBLICATIONS" });
    if (result.type !== "VERIFICATION_PLAN_PUBLICATIONS") return;
    for (const bundle of result.publications) {
      const projectResult = localState.query({ type: "GET_PROJECT", projectId: bundle.plan.projectId });
      const project = projectResult.type === "PROJECT" ? projectResult.project : null;
      try {
        if (project === null) {
          throw new ProjectVerificationPublicationError(
            "REPOSITORY_UNAVAILABLE",
            "The Project repository is no longer available",
          );
        }
        await verificationPlanPublisher({
          repositoryPath: project.repositoryPath,
          expectedTargetDigest: bundle.publication.expectedTargetDigest,
          plan: bundle.plan,
        });
        localState.execute({
          schemaVersion: 1,
          commandId: verificationPublicationCommandId(
            "complete",
            bundle.publication.id,
            bundle.publication.version,
          ),
          correlationId: `verification-plan-publication-${bundle.publication.id}`,
          actor: { type: "SYSTEM", id: "verification-publisher" },
          type: "COMPLETE_VERIFICATION_PLAN_PUBLICATION",
          payload: {
            publicationId: bundle.publication.id,
            expectedVersion: bundle.publication.version,
          },
        });
      } catch (error: unknown) {
        const errorCode = error instanceof ProjectVerificationPublicationError ? error.code : "WRITE_FAILED";
        app.log.error(
          {
            publicationId: bundle.publication.id,
            projectId: bundle.publication.projectId,
            errorCode,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Verification Plan publication failed",
        );
        try {
          localState.execute({
            schemaVersion: 1,
            commandId: verificationPublicationCommandId(
              "fail",
              bundle.publication.id,
              bundle.publication.version,
            ),
            correlationId: `verification-plan-publication-${bundle.publication.id}`,
            actor: { type: "SYSTEM", id: "verification-publisher" },
            type: "FAIL_VERIFICATION_PLAN_PUBLICATION",
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
            "Verification Plan publication failure could not be recorded",
          );
        }
      }
    }
  };

  const readVerificationPlanSettings = async (projectId: string) => {
    const projectResult = localState.query({ type: "GET_PROJECT", projectId });
    const project = projectResult.type === "PROJECT" ? projectResult.project : null;
    if (project === null) {
      throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
    }
    const proposal = await scanVerificationPlanProposal({
      projectId,
      repositoryPath: project.repositoryPath,
    });
    const stored = localState.query({ type: "GET_PROJECT_VERIFICATION_PLAN", projectId });
    if (stored.type !== "PROJECT_VERIFICATION_PLAN") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "Verification Plan settings are unavailable");
    }
    return verificationPlanSettingsResponseSchema.parse({
      schemaVersion: 1,
      projectId,
      projectVersion: stored.project.version,
      proposal,
      plan: stored.plan,
      publication: stored.publication,
    });
  };

  const scaffoldPublisher = options.scaffoldPublisher ?? publishProjectScaffold;
  const scaffoldCommandId = (action: "complete" | "fail", operationId: string, version: number): string =>
    `scaffold-${action}-${createHash("sha256")
      .update(`${operationId}\0${version.toString()}`)
      .digest("hex")}`;

  const scaffoldFailureCode = (error: unknown): ScaffoldOperationErrorCode => {
    if (error instanceof GitMissingError) return "GIT_UNAVAILABLE";
    if (!(error instanceof ProjectScaffoldingError)) return "SCAFFOLD_WRITE_FAILED";
    switch (error.code) {
      case "TARGET_EXISTS":
      case "MARKER_MISMATCH":
        return "TARGET_CONFLICT";
      case "TARGET_PARENT_UNAVAILABLE":
        return "TARGET_PARENT_UNAVAILABLE";
      case "PROPOSAL_CHANGED":
      case "RECIPE_UNAVAILABLE":
      case "INVALID_TARGET_PATH":
      case "TARGET_NAME_UNSUPPORTED":
      case "INVALID_OPERATION_ID":
        return "RECIPE_CHANGED";
      case "FILE_CONFLICT":
        return "SCAFFOLD_FILE_CONFLICT";
      case "GIT_INIT_FAILED":
        return "GIT_INIT_FAILED";
      case "REPOSITORY_INVALID":
        return "REPOSITORY_INVALID";
      case "TARGET_INSIDE_REPOSITORY":
        return "TARGET_CONFLICT";
    }
  };

  const drainScaffoldOperations = serialised(async (): Promise<void> => {
    const result = localState.query({ type: "LIST_PENDING_SCAFFOLD_OPERATIONS" });
    if (result.type !== "SCAFFOLD_OPERATIONS") return;
    for (const operation of result.operations) {
      try {
        await scaffoldPublisher({ operationId: operation.id, proposal: operation.proposal });
        localState.execute({
          schemaVersion: 1,
          commandId: scaffoldCommandId("complete", operation.id, operation.version),
          correlationId: `scaffold-operation-${operation.id}`,
          actor: { type: "SYSTEM", id: "scaffold-publisher" },
          type: "COMPLETE_PROJECT_SCAFFOLD",
          payload: { operationId: operation.id, expectedVersion: operation.version },
        });
      } catch (error: unknown) {
        const errorCode = scaffoldFailureCode(error);
        app.log.error(
          {
            operationId: operation.id,
            projectId: operation.projectId,
            errorCode,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Project scaffold publication failed",
        );
        try {
          localState.execute({
            schemaVersion: 1,
            commandId: scaffoldCommandId("fail", operation.id, operation.version),
            correlationId: `scaffold-operation-${operation.id}`,
            actor: { type: "SYSTEM", id: "scaffold-publisher" },
            type: "FAIL_PROJECT_SCAFFOLD",
            payload: { operationId: operation.id, expectedVersion: operation.version, errorCode },
          });
        } catch (recordError: unknown) {
          app.log.error(
            {
              operationId: operation.id,
              errorName: recordError instanceof Error ? recordError.name : "UnknownError",
            },
            "Project scaffold failure could not be recorded",
          );
        }
      }
    }
  });

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

  localState.execute({
    schemaVersion: 1,
    commandId: `reconcile-${randomUUID()}`,
    correlationId: `startup-${randomUUID()}`,
    actor: { type: "SYSTEM", id: "local-daemon" },
    type: "RECONCILE_WORKFLOWS",
    payload: {},
  });
  const verificationRunner = createProjectVerificationRunner({
    state: localState,
    artifactsDirectory: verificationArtifactsDirectory,
    createCommandId: () => `verification-command-${randomUUID()}`,
    createArtifactId: () => `verification-output-${randomUUID()}`,
    now,
    logger: app.log,
    ...(options.verificationRecipeExecutor === undefined
      ? {}
      : { executeRecipe: options.verificationRecipeExecutor }),
  });

  const verificationPlatform = (): "darwin" | "linux" | "win32" => {
    const current = normalizePlatform();
    if (current === "other") {
      throw new StateStoreError(
        "PERSISTENCE_FAILURE",
        "Project verification is not supported on this operating system",
      );
    }
    return current;
  };

  // Spec §6: one stage attempt is a sequence of context-assembled provider sessions, not a single
  // provider call. The worker owns the whole dispatch queue as a background pass (A1.5 spec D4/D5);
  // `runStageAttempt` still owns everything inside one attempt. An adopted Project Plan is measured
  // at the Review -> QA seam before Browser QA gets an AgentRun or browser authority.
  const worker = createSessionWorker({
    state: localState,
    resolveAdapter: resolveProjectProvider,
    template: mockDeliveryTemplate,
    workspacesRoot,
    createCommandId: () => `session-${randomUUID()}`,
    logger: app.log,
    schedulingLimits,
    browserQA: createBrowserQAStageRunner({
      state: localState,
      driver:
        options.browserQADriver ??
        createPlaywrightDriver({ artifactsDirectory: browserQAArtifactsDirectory }),
      resolveConfig:
        options.browserQAConfigResolver ??
        ((project) => resolveProjectBrowserQAConfig(project, { fixtureTargetOrigin: allowedOrigin })),
      createCommandId: () => `browser-qa-command-${randomUUID()}`,
      createAttachmentId: () => `browser-qa-attachment-${randomUUID()}`,
      logger: app.log,
    }),
    projectVerification: createProjectVerificationWorkflowGate({
      state: localState,
      runner: verificationRunner,
      platform: verificationPlatform,
      createCommandId: () => `verification-workflow-${randomUUID()}`,
    }),
    openMcpConnections: createMcpConnectionOpener({
      state: localState,
      gateway: mcpGateway,
      createCommandId: (kind) => `mcp-call-${kind.toLowerCase()}-${randomUUID()}`,
    }),
  });

  const readVerificationTree = async (worktreePath: string): Promise<string> => {
    try {
      return await treeOfWorktree({ worktreePath });
    } catch (error: unknown) {
      if (error instanceof GitMissingError) {
        throw new WorkItemChangesError(
          "GIT_UNAVAILABLE",
          "The verification tree could not be read because git could not be started on this machine",
          { cause: error },
        );
      }
      throw new WorkItemChangesError(
        "CHANGES_UNREADABLE",
        "The verification tree could not be read from the WorkItem workspace",
        { cause: error },
      );
    }
  };

  const readVerificationRunSnapshot = async (
    runId: string,
    treeCache: Map<string, Promise<string>> = new Map(),
  ) => {
    const context = localState.query({ type: "GET_VERIFICATION_RUN_CONTEXT", runId });
    if (context.type !== "VERIFICATION_RUN_CONTEXT") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "The verification Run context is unavailable");
    }
    const current = localState.query({
      type: "GET_PROJECT_VERIFICATION_PLAN",
      projectId: context.run.projectId,
    });
    if (current.type !== "PROJECT_VERIFICATION_PLAN") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "The current verification Plan is unavailable");
    }
    const cachedTree = treeCache.get(context.workspace.worktreePath);
    const treePromise = cachedTree ?? readVerificationTree(context.workspace.worktreePath);
    if (cachedTree === undefined) treeCache.set(context.workspace.worktreePath, treePromise);
    const freshness = projectVerificationRunFreshness(context.run, {
      currentPlan: current.plan ?? undefined,
      publication: current.publication ?? undefined,
      currentTree: await treePromise,
    });
    return verificationRunSnapshotResponseSchema.parse({
      schemaVersion: 1,
      run: context.run,
      plan: context.plan,
      checks: context.checks,
      ...freshness,
    });
  };
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
    if (session) {
      // Sliding expiry. The bootstrap grant is single-use and the launcher mints exactly one per
      // process, so a session that simply ran out after 12 h had no way back except restarting the
      // daemon -- which aborts every live provider session. An owner who is still using the tab
      // keeps it; a tab left idle for the full lifetime still expires, and the SSE heartbeat is
      // deliberately not a renewal (it re-checks through `sessionForRequest`, which stays pure).
      const remainingMs = session.expiresAt.getTime() - now().getTime();
      if (remainingMs < SESSION_TTL_MS / 2) {
        session.expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
        const sessionToken = request.cookies[SESSION_COOKIE];
        if (sessionToken !== undefined) {
          reply.setCookie(SESSION_COOKIE, sessionToken, {
            httpOnly: true,
            sameSite: "strict",
            path: "/",
            maxAge: Math.floor(SESSION_TTL_MS / 1_000),
          });
        }
      }
      return session;
    }
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

  const providerAllowanceForProject = (project: Project) => {
    const stored = localState.query({ type: "GET_PROVIDER_ALLOWANCES", projectId: project.id });
    if (stored.type !== "PROVIDER_ALLOWANCES") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "Provider allowance state could not be loaded");
    }
    const registryResolution = providerRegistry.resolve(project);
    const effectiveProvider = (fixedProviderAdapter ?? registryResolution.adapter).capabilities().provider;
    return projectProviderAllowanceResponse({
      projectId: project.id,
      effectiveProvider,
      snapshots: stored.snapshots,
      availability: providerRegistry.availability(),
      now: now(),
    });
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
      try {
        return daemonStatusResponseSchema.parse({
          apiVersion: API_VERSION,
          authenticated: true,
          daemon: {
            status: "online",
            version: productVersion,
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
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/insights", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      // Same error boundary as every other route: without it a store failure here would reach
      // Fastify's default handler and answer with a body outside `apiErrorResponseSchema`, with no
      // correlation id for the owner to quote.
      try {
        const result = localState.query({ type: "GET_REPORTING_FACTS" });
        if (result.type !== "REPORTING_FACTS") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The reporting facts could not be read");
        }
        return insightsResponseSchema.parse(
          buildReportingSnapshot({ facts: result.facts, runtime: reportingRuntime }),
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
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

    app.get("/api/v1/projects/:projectId/mcp-profiles", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const result = localState.query({
          type: "GET_PROJECT_MCP_PROFILES",
          projectId: params.projectId,
        });
        if (result.type !== "PROJECT_MCP_PROFILES") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "MCP profiles could not be loaded");
        }
        return mcpProfilesResponseSchema.parse({
          schemaVersion: 1,
          projectId: result.project.id,
          projectVersion: result.project.version,
          profiles: result.profiles,
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/mcp-profile-proposals", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = proposeMcpProfileRequestSchema.parse(request.body);
        const projectResult = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        if (projectResult.type !== "PROJECT" || projectResult.project === null) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        if (projectResult.project.version !== body.expectedProjectVersion) {
          throw new McpDomainError(
            "PROJECT_VERSION_CONFLICT",
            "The Project changed after MCP settings were loaded",
            {
              expectedVersion: body.expectedProjectVersion,
              actualVersion: projectResult.project.version,
            },
          );
        }
        if (body.candidate.profileId !== null) {
          const profileResult = localState.query({
            type: "GET_PROJECT_MCP_PROFILES",
            projectId: params.projectId,
          });
          const found =
            profileResult.type === "PROJECT_MCP_PROFILES" &&
            profileResult.profiles.some(({ revision }) => revision.profileId === body.candidate.profileId);
          if (!found) {
            throw new McpDomainError(
              "PROFILE_NOT_FOUND",
              "The MCP profile being revised does not exist in this Project",
            );
          }
        }
        const candidate = await mcpGateway.resolveCandidate(body.candidate);
        const canonicalDigest = createHash("sha256")
          .update(canonicalMcpProfileSource(candidate))
          .digest("hex");
        return mcpProfileProposalSchema.parse(
          mcpProposals.issue({
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            candidate,
            canonicalDigest,
          }),
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/mcp-presets/context7/proposal", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = proposeContext7PresetRequestSchema.parse(request.body);
        const profileResult = localState.query({
          type: "GET_PROJECT_MCP_PROFILES",
          projectId: params.projectId,
        });
        if (profileResult.type !== "PROJECT_MCP_PROFILES") {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        if (profileResult.project.version !== body.expectedProjectVersion) {
          throw new McpDomainError(
            "PROJECT_VERSION_CONFLICT",
            "The Project changed after MCP settings were loaded",
            {
              expectedVersion: body.expectedProjectVersion,
              actualVersion: profileResult.project.version,
            },
          );
        }

        const bundled = resolveBundledContext7Candidate();
        const existing = profileResult.profiles.find(
          ({ revision }) =>
            revision.name === CONTEXT7_PRESET_NAME &&
            CONTEXT7_PRESET_TOOLS.every((tool) => revision.declaredTools.includes(tool)),
        );
        const candidate = await mcpGateway.resolveCandidate({
          ...bundled,
          profileId: existing?.revision.profileId ?? null,
        });
        const canonicalDigest = createHash("sha256")
          .update(canonicalMcpProfileSource(candidate))
          .digest("hex");
        if (existing?.revision.canonicalDigest === canonicalDigest) {
          throw new McpDomainError("PROFILE_UNCHANGED", "The bundled Context7 profile is already current");
        }
        return mcpProfileProposalSchema.parse(
          mcpProposals.issue({
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            candidate,
            canonicalDigest,
          }),
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/mcp-profile-proposals/:challengeId/confirm", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = mcpProposalParamsSchema.parse(request.params);
        const body = confirmMcpProfileRequestSchema.parse(request.body);
        if (body.challengeId !== params.challengeId) {
          throw new McpProposalError(
            "MCP_PROPOSAL_MISMATCH",
            "The confirmation body and route name different MCP proposals",
          );
        }
        const proposal = mcpProposals.consume({
          projectId: params.projectId,
          expectedProjectVersion: body.expectedProjectVersion,
          challengeId: params.challengeId,
          canonicalDigest: body.canonicalDigest,
        });
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CONFIRM_MCP_PROFILE",
          payload: {
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            candidate: proposal.candidate,
            canonicalDigest: proposal.canonicalDigest,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/mcp-profiles/:revisionId/probe", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = mcpRevisionParamsSchema.parse(request.params);
        const body = probeMcpProfileRequestSchema.parse(request.body);
        const profileResult = localState.query({
          type: "GET_PROJECT_MCP_PROFILES",
          projectId: params.projectId,
        });
        const profile =
          profileResult.type === "PROJECT_MCP_PROFILES"
            ? profileResult.profiles.find(({ revision }) => revision.id === params.revisionId)
            : undefined;
        if (!profile) {
          throw new McpDomainError(
            "PROFILE_NOT_FOUND",
            "The MCP profile revision does not exist in this Project",
          );
        }
        const observation = await mcpGateway.probe(profile.revision, profile.consent);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "SYSTEM", id: "local-daemon" },
          type: "RECORD_MCP_CAPABILITY_SNAPSHOT",
          payload: {
            projectId: params.projectId,
            profileRevisionId: params.revisionId,
            ...observation,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.put("/api/v1/projects/:projectId/mcp-profiles/:revisionId/grant", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = mcpRevisionParamsSchema.parse(request.params);
        const body = setMcpProfileGrantRequestSchema.parse(request.body);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "SET_MCP_PROFILE_GRANT",
          payload: {
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            profileRevisionId: params.revisionId,
            expectedGrantVersion: body.expectedGrantVersion,
            tools: body.tools,
            ownerAttestsReadOnly: body.ownerAttestsReadOnly,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.delete("/api/v1/projects/:projectId/mcp-profiles/:revisionId/grant", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = mcpRevisionParamsSchema.parse(request.params);
        const body = revokeMcpProfileGrantRequestSchema.parse(request.body);
        const result = localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "REVOKE_MCP_PROFILE_GRANT",
          payload: {
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            profileRevisionId: params.revisionId,
            expectedGrantVersion: body.expectedGrantVersion,
          },
        });
        if (result.type !== "MCP_GRANT_CHANGED") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The MCP grant was not revoked");
        }
        mcpGateway.revoke(result.grant.id);
        return result;
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

    app.post("/api/v1/scaffolds/propose", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const body = proposeProjectScaffoldRequestSchema.parse(request.body);
        const proposal = await proposeProjectScaffold({
          recipeId: body.recipeId,
          targetPath: body.targetPath,
        });
        return proposeProjectScaffoldResponseSchema.parse({ schemaVersion: 1, proposal });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/scaffolds/publish", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const body = publishProjectScaffoldRequestSchema.parse(request.body);
        // The proposal arrives from the browser, and REQUEST_PROJECT_SCAFFOLD below writes a durable
        // Project for its `targetPath` -- a row that carries the UNIQUE `repository_path`, that
        // REGISTER_PROJECT then refuses to duplicate, and that nothing in Loomrail ever deletes.
        // Publishing an unverified proposal therefore does not merely fail: it takes the path with
        // it, permanently, for an operation whose retry can never succeed either. So both halves of
        // the preview are re-established here, before anything durable is written.
        //
        // The Project lookup runs first and reads PROVISIONING rows too, so a second publish of an
        // already-claimed target still answers "a Project owns this" rather than the weaker "the
        // directory exists", and so a row left by an earlier failure is visible rather than silent.
        const ownerOfTarget = localState.query({
          type: "GET_PROJECT_BY_REPOSITORY_PATH",
          repositoryPath: body.proposal.targetPath,
        });
        if (ownerOfTarget.type === "PROJECT" && ownerOfTarget.project !== null) {
          throw new ScaffoldDomainError(
            "PROJECT_ALREADY_EXISTS",
            "A Project already owns this scaffold target",
          );
        }
        // Compared whole rather than by digest alone: the digest travels inside the same untrusted
        // body, so a request that keeps a valid digest and edits any other field would otherwise be
        // taken at its word. Both sides go through the same schema first, which fixes key order, so
        // this comparison is over normalised values and not over however the request happened to be
        // serialised.
        const authoritative = scaffoldProposalSchema.parse(
          await proposeProjectScaffold({
            recipeId: body.proposal.recipeId,
            targetPath: body.proposal.targetPath,
          }),
        );
        if (JSON.stringify(authoritative) !== JSON.stringify(scaffoldProposalSchema.parse(body.proposal))) {
          throw new ProjectScaffoldingError(
            "PROPOSAL_CHANGED",
            "The scaffold proposal changed before publication",
          );
        }
        const requested = localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "REQUEST_PROJECT_SCAFFOLD",
          payload: { proposal: authoritative },
        });
        if (requested.type !== "PROJECT_SCAFFOLD_REQUESTED") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The scaffold operation was not created");
        }
        await drainScaffoldOperations();
        const result = localState.query({
          type: "GET_SCAFFOLD_OPERATION",
          operationId: requested.operation.id,
        });
        if (result.type !== "SCAFFOLD_OPERATION") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The scaffold operation is unavailable");
        }
        return scaffoldOperationResponseSchema.parse({ schemaVersion: 1, operation: result.operation });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/scaffolds/:operationId", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = scaffoldParamsSchema.parse(request.params);
        const result = localState.query({
          type: "GET_SCAFFOLD_OPERATION",
          operationId: params.operationId,
        });
        if (result.type !== "SCAFFOLD_OPERATION") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The scaffold operation is unavailable");
        }
        return scaffoldOperationResponseSchema.parse({ schemaVersion: 1, operation: result.operation });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/scaffolds", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const result = localState.query({ type: "LIST_OPEN_SCAFFOLD_OPERATIONS" });
        if (result.type !== "SCAFFOLD_OPERATIONS") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "Scaffold operations are unavailable");
        }
        return scaffoldOperationsResponseSchema.parse({
          schemaVersion: 1,
          operations: result.operations,
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/scaffolds/:operationId/retry", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = scaffoldParamsSchema.parse(request.params);
        const body = retryProjectScaffoldRequestSchema.parse(request.body);
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "RETRY_PROJECT_SCAFFOLD",
          payload: { operationId: params.operationId, expectedVersion: body.expectedVersion },
        });
        await drainScaffoldOperations();
        const result = localState.query({
          type: "GET_SCAFFOLD_OPERATION",
          operationId: params.operationId,
        });
        if (result.type !== "SCAFFOLD_OPERATION") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The scaffold operation is unavailable");
        }
        return scaffoldOperationResponseSchema.parse({ schemaVersion: 1, operation: result.operation });
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

    app.get("/api/v1/projects/:projectId/verification-plan", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        return await readVerificationPlanSettings(params.projectId);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/verification-plan/adopt", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = adoptVerificationPlanRequestSchema.parse(request.body);
        const settings = await readVerificationPlanSettings(params.projectId);
        if (settings.proposal.proposalHash !== body.proposalHash) {
          throw new VerificationDomainError(
            "PROPOSAL_HASH_MISMATCH",
            "The verification preview changed before adoption",
          );
        }
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "ADOPT_VERIFICATION_PLAN",
          payload: {
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            proposal: settings.proposal,
          },
        });
        await drainVerificationPlanPublications();
        return await readVerificationPlanSettings(params.projectId);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/verification-plan/disable", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = disableVerificationPlanRequestSchema.parse(request.body);
        const settings = await readVerificationPlanSettings(params.projectId);
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "DISABLE_VERIFICATION_PLAN",
          payload: {
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            expectedPlanRevision: body.expectedPlanRevision,
            expectedPlanContentHash: body.expectedPlanContentHash,
            expectedTargetDigest:
              settings.proposal.target.state === "PRESENT" ? settings.proposal.target.digest : null,
          },
        });
        await drainVerificationPlanPublications();
        return await readVerificationPlanSettings(params.projectId);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/verification-plan/publication/retry", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = retryVerificationPlanPublicationRequestSchema.parse(request.body);
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "RETRY_VERIFICATION_PLAN_PUBLICATION",
          payload: {
            projectId: params.projectId,
            publicationId: body.publicationId,
            expectedVersion: body.expectedVersion,
          },
        });
        await drainVerificationPlanPublications();
        return await readVerificationPlanSettings(params.projectId);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/work-items/:workItemId/verification-runs", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const workItem = localState.query({ type: "GET_WORK_ITEM", workItemId: params.workItemId });
        if (workItem.type !== "WORK_ITEM" || workItem.workItem === null) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        const result = localState.query({
          type: "LIST_WORK_ITEM_VERIFICATION_RUNS",
          workItemId: params.workItemId,
          limit: 25,
        });
        if (result.type !== "VERIFICATION_RUNS") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "Verification Runs could not be loaded");
        }
        const failures = localState.query({
          type: "LIST_WORK_ITEM_VERIFICATION_FAILURES",
          workItemId: params.workItemId,
          limit: 100,
        });
        const corrections = localState.query({
          type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
          workItemId: params.workItemId,
          limit: 100,
        });
        if (failures.type !== "VERIFICATION_FAILURES" || corrections.type !== "VERIFICATION_CORRECTIONS") {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "Project verification correction history could not be loaded",
          );
        }
        const treeCache = new Map<string, Promise<string>>();
        return verificationRunsResponseSchema.parse({
          schemaVersion: 1,
          runs: await Promise.all(result.runs.map(({ id }) => readVerificationRunSnapshot(id, treeCache))),
          failures: failures.failures,
          correctionRuns: corrections.correctionRuns,
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/verification-runs", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = z
          .union([retryVerificationRunRequestSchema, startVerificationRunRequestSchema])
          .parse(request.body);
        const workspaceResult = localState.query({
          type: "GET_WORKSPACE_BY_WORK_ITEM",
          workItemId: params.workItemId,
        });
        const workspace = workspaceResult.type === "WORKSPACE" ? workspaceResult.workspace : null;
        if (workspace === null) {
          throw new VerificationDomainError(
            "WORKSPACE_UNAVAILABLE",
            "Verification needs a prepared WorkItem workspace",
          );
        }
        const commonPayload = {
          workItemId: params.workItemId,
          expectedWorkItemVersion: body.expectedWorkItemVersion,
          expectedPlanRevision: body.expectedPlanRevision,
          expectedPlanContentHash: body.expectedPlanContentHash,
          implementationTree: await readVerificationTree(workspace.worktreePath),
          platform: verificationPlatform(),
        };
        const reserved = localState.execute(
          "retryOfRunId" in body
            ? {
                schemaVersion: 1,
                commandId: body.commandId,
                correlationId,
                actor: { type: "HUMAN", id: "local-owner" },
                type: "RETRY_VERIFICATION_RUN",
                payload: {
                  ...commonPayload,
                  retryOfRunId: body.retryOfRunId,
                  expectedRetryOfRunVersion: body.expectedRetryOfRunVersion,
                },
              }
            : {
                schemaVersion: 1,
                commandId: body.commandId,
                correlationId,
                actor: { type: "HUMAN", id: "local-owner" },
                type: "START_VERIFICATION_RUN",
                payload: commonPayload,
              },
        );
        if (reserved.type !== "VERIFICATION_RUN_RESERVED") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The verification Run was not reserved");
        }
        verificationRunner.wake(reserved.run.id);
        return await readVerificationRunSnapshot(reserved.run.id);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/verification-runs/:runId/cancel", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = verificationRunParamsSchema.parse(request.params);
        const body = cancelVerificationRunRequestSchema.parse(request.body);
        await verificationRunner.cancel({
          runId: params.runId,
          expectedVersion: body.expectedVersion,
          commandId: body.commandId,
          correlationId,
        });
        return await readVerificationRunSnapshot(params.runId);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/verification-checks/:checkId/output", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = verificationCheckParamsSchema.parse(request.params);
        const output = await verificationRunner.readOutput(params.checkId);
        if (output === null) {
          return await reply
            .code(404)
            .send(
              createError(
                "VERIFICATION_OUTPUT_UNAVAILABLE",
                "Verification output is unavailable",
                correlationId,
              ),
            );
        }
        return await reply
          .header("cache-control", "no-store")
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .type("text/plain; charset=utf-8")
          .send(output);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/projects/:projectId/readiness", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const result = localState.query({
          type: "GET_PROJECT_READINESS_SNAPSHOT",
          projectId: params.projectId,
        });
        if (result.type !== "PROJECT_READINESS_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The Project Readiness snapshot is unavailable");
        }
        return projectReadinessSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/readiness/run", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = runProjectReadinessRequestSchema.parse(request.body);
        const projectResult = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        const project = projectResult.type === "PROJECT" ? projectResult.project : null;
        if (project === null) throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        const constitutionResult = localState.query({
          type: "GET_PROJECT_CONSTITUTION_SNAPSHOT",
          projectId: params.projectId,
        });
        if (constitutionResult.type !== "PROJECT_CONSTITUTION_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The Constitution snapshot is unavailable");
        }
        const assessment = await assessProjectReadiness(project.repositoryPath, {
          activeConstitution: constitutionResult.snapshot.activeConstitution !== null,
        });
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "RECORD_PROJECT_READINESS_ASSESSMENT",
          payload: {
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            ...assessment,
            checks: [...assessment.checks],
          },
        });
        const result = localState.query({
          type: "GET_PROJECT_READINESS_SNAPSHOT",
          projectId: params.projectId,
        });
        if (result.type !== "PROJECT_READINESS_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The Project Readiness snapshot is unavailable");
        }
        return projectReadinessSnapshotSchema.parse(result.snapshot);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/readiness/attest", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = attestProjectReadinessRequestSchema.parse(request.body);
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "ATTEST_PROJECT_READINESS_CHECK",
          payload: {
            projectId: params.projectId,
            runId: body.runId,
            checkId: body.checkId,
            expectedRunVersion: body.expectedRunVersion,
            outcome: body.outcome,
            rationale: body.rationale,
          },
        });
        const result = localState.query({
          type: "GET_PROJECT_READINESS_SNAPSHOT",
          projectId: params.projectId,
        });
        if (result.type !== "PROJECT_READINESS_SNAPSHOT") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The Project Readiness snapshot is unavailable");
        }
        return projectReadinessSnapshotSchema.parse(result.snapshot);
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

    app.get("/api/v1/work-items/:workItemId/reviews", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const workItem = localState.query({ type: "GET_WORK_ITEM", workItemId: params.workItemId });
        if (workItem.type !== "WORK_ITEM" || !workItem.workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        const snapshot = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        const run = snapshot.type === "WORKFLOW_SNAPSHOT" ? snapshot.snapshot.run : null;
        if (run === null) {
          return reviewStateResponseSchema.parse({ schemaVersion: 1, reports: [], findings: [] });
        }
        const reports = localState.query({ type: "LIST_REVIEW_REPORTS", pipelineRunId: run.id });
        const findings = localState.query({ type: "LIST_REVIEW_FINDINGS", pipelineRunId: run.id });
        if (reports.type !== "REVIEW_REPORTS" || findings.type !== "REVIEW_FINDINGS") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The review state could not be loaded");
        }
        const enrichedReports = reports.reports.map((report) => {
          const author = localState.query({ type: "GET_AGENT_RUN", agentRunId: report.authorAgentRunId });
          const reviewer = localState.query({
            type: "GET_AGENT_RUN",
            agentRunId: report.reviewerAgentRunId,
          });
          const authorRun = author.type === "AGENT_RUNS" ? author.runs[0] : undefined;
          const reviewerRun = reviewer.type === "AGENT_RUNS" ? reviewer.runs[0] : undefined;
          if (authorRun === undefined || reviewerRun === undefined) {
            throw new StateStoreError("PERSISTENCE_FAILURE", "A review AgentRun could not be loaded");
          }
          return {
            ...report,
            authorProvider: authorRun.provider,
            reviewerProvider: reviewerRun.provider,
          };
        });
        return reviewStateResponseSchema.parse({
          schemaVersion: 1,
          reports: enrichedReports,
          findings: findings.findings,
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/work-items/:workItemId/qa", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const workItem = localState.query({ type: "GET_WORK_ITEM", workItemId: params.workItemId });
        if (workItem.type !== "WORK_ITEM" || !workItem.workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        const snapshot = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        const run = snapshot.type === "WORKFLOW_SNAPSHOT" ? snapshot.snapshot.run : null;
        if (run === null) {
          return qaStateResponseSchema.parse({
            schemaVersion: 1,
            runs: [],
            evidence: [],
            attachments: [],
            defects: [],
            correctionRuns: [],
            retestPlans: [],
          });
        }
        const qaState = localState.query({ type: "GET_QA_STATE", pipelineRunId: run.id });
        if (qaState.type !== "QA_STATE") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The Browser QA state could not be loaded");
        }
        const runs = qaState.runs.slice(-MAX_QA_RUN_HISTORY);
        const includedRunIds = new Set(runs.map(({ id }) => id));
        return qaStateResponseSchema.parse({
          schemaVersion: 1,
          runs,
          evidence: qaState.evidence.filter(({ qaRunId }) => includedRunIds.has(qaRunId)),
          attachments: qaState.attachments
            .filter(({ qaRunId }) => includedRunIds.has(qaRunId))
            .map(publishQAAttachment),
          defects: qaState.defects.filter(({ qaRunId }) => includedRunIds.has(qaRunId)),
          correctionRuns: qaState.correctionRuns,
          retestPlans: qaState.retestPlans,
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/work-items/:workItemId/qa/attachments/:attachmentId", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = qaAttachmentParamsSchema.parse(request.params);
        const workItem = localState.query({ type: "GET_WORK_ITEM", workItemId: params.workItemId });
        if (workItem.type !== "WORK_ITEM" || !workItem.workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        const snapshot = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        const run = snapshot.type === "WORKFLOW_SNAPSHOT" ? snapshot.snapshot.run : null;
        if (run === null) {
          return await reply
            .code(404)
            .send(createError("QA_ATTACHMENT_NOT_FOUND", "The QA attachment does not exist", correlationId));
        }
        const qaState = localState.query({ type: "GET_QA_STATE", pipelineRunId: run.id });
        const attachment =
          qaState.type === "QA_STATE"
            ? qaState.attachments.find(({ id }) => id === params.attachmentId)
            : undefined;
        if (attachment === undefined) {
          return await reply
            .code(404)
            .send(createError("QA_ATTACHMENT_NOT_FOUND", "The QA attachment does not exist", correlationId));
        }

        let handle: Awaited<ReturnType<typeof openVerifiedBrowserQAArtifact>>;
        try {
          handle = await openVerifiedBrowserQAArtifact({
            artifactsDirectory: browserQAArtifactsDirectory,
            attachment,
          });
        } catch (error: unknown) {
          request.log.warn(
            {
              attachmentId: attachment.id,
              qaRunId: attachment.qaRunId,
              error: error instanceof Error ? error.name : "unknown",
            },
            "A Browser QA attachment failed verification while it was opened",
          );
          return await reply
            .code(409)
            .send(
              createError(
                "QA_ATTACHMENT_UNAVAILABLE",
                "The QA attachment is unavailable or no longer matches its evidence",
                correlationId,
              ),
            );
        }

        const screenshot = attachment.kind === "SCREENSHOT";
        return await reply
          .header("cache-control", "private, no-store")
          .header("content-length", attachment.byteSize.toString())
          .header(
            "content-disposition",
            `${screenshot ? "inline" : "attachment"}; filename="browser-qa-evidence.${screenshot ? "png" : "zip"}"`,
          )
          .type(screenshot ? "image/png" : "application/zip")
          .send(handle.createReadStream({ autoClose: true, start: 0 }));
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
          usageReports: result.type === "PROVIDER_SESSIONS" ? result.usageReports : [],
          peakContextWindowUsage: result.type === "PROVIDER_SESSIONS" ? result.peakContextWindowUsage : {},
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/projects/:projectId/provider-selection", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const result = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        if (result.type !== "PROJECT" || result.project === null) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        return projectProviderSelectionResponseSchema.parse(
          providerRegistry.resolve(result.project).response,
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/provider/allowance", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const query = providerAllowanceQuerySchema.parse(request.query);
        const result = localState.query({ type: "GET_PROJECT", projectId: query.projectId });
        if (result.type !== "PROJECT" || result.project === null) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        return projectProviderAllowanceResponseSchema.parse(providerAllowanceForProject(result.project));
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.put("/api/v1/projects/:projectId/provider-selection", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const body = setProjectProviderPreferenceRequestSchema.parse(request.body);
        if (providerRegistry.environment.override !== null || providerRegistry.environment.invalid) {
          return reply
            .code(409)
            .send(
              createError(
                "PROVIDER_OVERRIDE_ACTIVE",
                `${LOOMRAIL_PROVIDER_ENV_VAR} overrides Project provider settings until the daemon restarts`,
                correlationId,
              ),
            );
        }
        localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "SET_PROJECT_PROVIDER_PREFERENCE",
          payload: {
            projectId: params.projectId,
            expectedProjectVersion: body.expectedProjectVersion,
            preference: body.preference,
          },
        });
        const result = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        if (result.type !== "PROJECT" || result.project === null) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        worker.wake();
        return projectProviderSelectionResponseSchema.parse(
          providerRegistry.resolve(result.project).response,
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/provider-selection/refresh", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        refreshProviderAvailabilityRequestSchema.parse(request.body);
        const before = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        if (before.type !== "PROJECT" || before.project === null) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        await providerRegistry.refresh();
        worker.wake();
        return projectProviderSelectionResponseSchema.parse(
          providerRegistry.resolve(before.project).response,
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/:projectId/provider-allowance/refresh", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        refreshProviderAllowanceRequestSchema.parse(request.body);
        const result = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        if (result.type !== "PROJECT" || result.project === null) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        const registryResolution = providerRegistry.resolve(result.project);
        const adapter = fixedProviderAdapter ?? registryResolution.adapter;
        const capabilities = adapter.capabilities();
        if (
          capabilities.provider !== "MOCK" &&
          capabilities.canReportRateLimits === true &&
          adapter.readAllowance !== undefined
        ) {
          const snapshot = await readAllowanceOnce(capabilities.provider, adapter);
          if (snapshot.provider !== capabilities.provider) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "The provider allowance reader returned another provider's snapshot",
            );
          }
          try {
            localState.execute({
              schemaVersion: 1,
              commandId: `provider-allowance-${randomUUID()}`,
              correlationId,
              actor: { type: "SYSTEM", id: "provider-allowance" },
              type: "RECORD_PROVIDER_ALLOWANCE",
              payload: { projectId: result.project.id, snapshot },
            });
          } catch (error: unknown) {
            if (
              !(error instanceof ProviderAllowanceDomainError) ||
              error.code !== "PROVIDER_ALLOWANCE_STALE"
            ) {
              throw error;
            }
          }
        }
        return projectProviderAllowanceResponseSchema.parse(providerAllowanceForProject(result.project));
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    // Compatibility projection for clients that predate per-Project selection. New clients use
    // the route above so the answer follows the Project they are actually showing.
    app.get("/api/v1/provider/capabilities", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const projectsResult = localState.query({ type: "LIST_PROJECTS" });
        const project =
          projectsResult.type === "PROJECTS"
            ? (projectsResult.projects[0] ?? startupProjectionProject)
            : startupProjectionProject;
        const capabilities = (
          fixedProviderAdapter ?? providerRegistry.resolve(project).adapter
        ).capabilities();
        return providerCapabilitiesResponseSchema.parse({
          schemaVersion: 1,
          provider: capabilities.provider,
          start: capabilities.start,
          stages: capabilities.stages,
          checkpointOnRequest: capabilities.checkpointOnRequest,
          contextWindowReporting: capabilities.contextWindowReporting,
          costReporting: capabilities.costReporting,
          canReportRateLimits: capabilities.canReportRateLimits ?? false,
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

    app.get("/api/v1/attention", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const result = localState.query({ type: "GET_ATTENTION_INBOX" });
        if (result.type !== "ATTENTION_INBOX") {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The Attention query returned an unexpected result",
          );
        }
        return attentionInboxResponseSchema.parse(result.inbox);
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/agent-fleet", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        return agentFleetResponseSchema.parse(
          buildAgentFleet({
            state: localState,
            resolveAdapter: resolveProjectProvider,
            schedulingLimits,
          }),
        );
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
              maxEstimatedTokens: body.maxEstimatedTokens ?? LEGACY_MOCK_BUDGET,
              warningThresholds: [...DEFAULT_MOCK_BUDGET_THRESHOLDS],
              modelTierOverride: body.modelTierOverride ?? null,
              agentRunMaxEstimatedTokensOverride: body.agentRunMaxEstimatedTokensOverride ?? null,
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
        worker.pausePipeline(snapshot.snapshot.run.id);
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

    app.post("/api/v1/work-items/:workItemId/pipeline/cancel", async (request, reply) => {
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
        // Validate and commit the cancellation first, while retaining any live session/run/lease.
        // Only a successfully applied (or idempotently replayed) command may stop the provider.
        const cancelled = localState.execute({
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
        if (cancelled.type !== "PIPELINE_CONTROL_APPLIED" || cancelled.action !== "CANCEL") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The pipeline cancellation was not applied");
        }
        const sessions = localState.query({
          type: "LIST_PROVIDER_SESSIONS",
          stageAttemptId: cancelled.stageAttempt.id,
        });
        if (sessions.type !== "PROVIDER_SESSIONS") {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The cancelled provider sessions could not be read",
          );
        }
        const runningSessions = sessions.sessions.filter(({ status }) => status === "RUNNING");
        const stoppedSessionIds = new Set(await worker.revokePipeline(cancelled.run.id));
        // Fail closed only for a session whose child this worker still holds and could not prove
        // stopped. A RUNNING row with no live execution at all has already left the loop (a
        // deadline abort that failed, a stop that raced the loop's unwind): there is nothing left
        // to signal, and refusing here used to leave the run CANCELLED with its sessions RUNNING and
        // every retry of this command answering 500 until the daemon restarted.
        const liveSessionIds = worker.liveSessionIds(cancelled.run.id);
        if (runningSessions.some(({ id }) => liveSessionIds.has(id) && !stoppedSessionIds.has(id))) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "A cancelled ProviderSession has no registered child-stop authority",
          );
        }
        for (const providerSession of runningSessions) {
          localState.execute({
            schemaVersion: 1,
            commandId: `cancel-session-${providerSession.id}`,
            correlationId,
            actor: { type: "SYSTEM", id: "session-loop" },
            type: "END_PROVIDER_SESSION",
            payload: {
              providerSessionId: providerSession.id,
              endReason: "CANCELLED",
              providerStarted: true,
            },
          });
        }
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
            ...(body.modelTierOverride === undefined ? {} : { modelTierOverride: body.modelTierOverride }),
            ...(body.agentRunMaxEstimatedTokensOverride === undefined
              ? {}
              : {
                  agentRunMaxEstimatedTokensOverride: body.agentRunMaxEstimatedTokensOverride,
                }),
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

    app.post("/api/v1/review-findings/:findingId/disposition", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = reviewFindingParamsSchema.parse(request.params);
        const body = disposeReviewFindingRequestSchema.parse(request.body);
        return reviewFindingDisposedResultSchema.parse(
          localState.execute({
            schemaVersion: 1,
            commandId: body.commandId,
            correlationId,
            actor: { type: "HUMAN", id: "local-owner" },
            type: "DISPOSE_REVIEW_FINDING",
            payload: {
              findingId: params.findingId,
              expectedVersion: body.expectedVersion,
              disposition: body.disposition,
              reason: body.reason,
            },
          }),
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/qa-defects/:defectId/waive", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = qaDefectParamsSchema.parse(request.params);
        const body = waiveQADefectRequestSchema.parse(request.body);
        return qaDefectWaivedResultSchema.parse(
          localState.execute({
            schemaVersion: 1,
            commandId: body.commandId,
            correlationId,
            actor: { type: "HUMAN", id: "local-owner" },
            type: "WAIVE_QA_DEFECT",
            payload: {
              defectId: params.defectId,
              expectedVersion: body.expectedVersion,
              reason: body.reason,
            },
          }),
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/qa/correction-gate/:humanRequestId", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = qaCorrectionGateParamsSchema.parse(request.params);
        const body = resolveQACorrectionGateRequestSchema.parse(request.body);
        const current = localState.query({
          type: "GET_WORKFLOW_SNAPSHOT",
          workItemId: params.workItemId,
        });
        if (
          current.type !== "WORKFLOW_SNAPSHOT" ||
          !current.snapshot.humanRequests.some(
            ({ id, status }) => id === params.humanRequestId && status === "OPEN",
          )
        ) {
          throw new QACorrectionError(
            "QA_CORRECTION_REQUEST_INVALID",
            "The exhausted QA correction gate does not exist",
          );
        }
        return qaCorrectionGateResolvedResultSchema.parse(
          localState.execute({
            schemaVersion: 1,
            commandId: body.commandId,
            correlationId,
            actor: { type: "HUMAN", id: "local-owner" },
            type: "RESOLVE_QA_CORRECTION_GATE",
            payload: {
              humanRequestId: params.humanRequestId,
              expectedRequestVersion: body.expectedRequestVersion,
              correctionRunId: body.correctionRunId,
              expectedCorrectionVersion: body.expectedCorrectionVersion,
              expectedPipelineRunVersion: body.expectedPipelineRunVersion,
              action: body.action,
            },
          }),
        );
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post(
      "/api/v1/work-items/:workItemId/verification/correction-gate/:humanRequestId",
      (request, reply) => {
        const correlationId = requestCorrelationId(request);
        if (!authorizeMutation(request, reply, correlationId)) return;
        try {
          const params = qaCorrectionGateParamsSchema.parse(request.params);
          const body = resolveVerificationCorrectionGateRequestSchema.parse(request.body);
          const current = localState.query({
            type: "GET_WORKFLOW_SNAPSHOT",
            workItemId: params.workItemId,
          });
          if (
            current.type !== "WORKFLOW_SNAPSHOT" ||
            !current.snapshot.humanRequests.some(
              ({ id, status }) => id === params.humanRequestId && status === "OPEN",
            )
          ) {
            throw new VerificationCorrectionError(
              "REQUEST_INVALID",
              "The exhausted Project verification correction gate does not exist",
            );
          }
          return verificationCorrectionGateResolvedResultSchema.parse(
            localState.execute({
              schemaVersion: 1,
              commandId: body.commandId,
              correlationId,
              actor: { type: "HUMAN", id: "local-owner" },
              type: "RESOLVE_VERIFICATION_CORRECTION_GATE",
              payload: {
                humanRequestId: params.humanRequestId,
                expectedRequestVersion: body.expectedRequestVersion,
                correctionRunId: body.correctionRunId,
                expectedCorrectionVersion: body.expectedCorrectionVersion,
                qaCorrectionRunId: body.qaCorrectionRunId ?? null,
                expectedQACorrectionVersion: body.expectedQACorrectionVersion ?? null,
                expectedPipelineRunVersion: body.expectedPipelineRunVersion,
                action: body.action,
              },
            }),
          );
        } catch (error: unknown) {
          return sendOperationError(error, request, reply, correlationId);
        }
      },
    );

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

    app.get("/api/v1/work-items/:workItemId/acceptance/:acceptancePackageId/export", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = acceptanceParamsSchema.parse(request.params);
        for (let readAttempt = 0; readAttempt < 2; readAttempt += 1) {
          const workItemResult = localState.query({
            type: "GET_WORK_ITEM",
            workItemId: params.workItemId,
          });
          if (workItemResult.type !== "WORK_ITEM" || !workItemResult.workItem) {
            throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
          }
          const snapshotResult = localState.query({
            type: "GET_WORKFLOW_SNAPSHOT",
            workItemId: params.workItemId,
          });
          const snapshot = snapshotResult.type === "WORKFLOW_SNAPSHOT" ? snapshotResult.snapshot : undefined;
          const acceptancePackage = snapshot?.acceptancePackage;
          if (!snapshot || acceptancePackage?.id !== params.acceptancePackageId || snapshot.run === null) {
            throw new WorkflowDomainError("ACCEPTANCE_NOT_FOUND", "The AcceptancePackage does not exist");
          }

          const qaResult = localState.query({ type: "GET_QA_STATE", pipelineRunId: snapshot.run.id });
          if (qaResult.type !== "QA_STATE") {
            throw new StateStoreError("PERSISTENCE_FAILURE", "The Browser QA state could not be loaded");
          }

          const events: DomainEvent[] = [];
          let afterSequence = 0;
          let auditComplete = false;
          while (events.length < MAX_RELEASE_SUMMARY_AUDIT_EVENTS) {
            const page = localState.query({
              type: "LIST_EVENTS",
              aggregateId: params.workItemId,
              direction: "ASC",
              afterSequence,
              limit: Math.min(500, MAX_RELEASE_SUMMARY_AUDIT_EVENTS - events.length),
            });
            if (page.type !== "EVENTS") {
              throw new StateStoreError(
                "PERSISTENCE_FAILURE",
                "The WorkItem audit trail could not be loaded",
              );
            }
            events.push(...page.events);
            afterSequence = page.nextSequence;
            if (!page.hasMore) {
              auditComplete = true;
              break;
            }
          }

          const rendered = renderReleaseSummary({
            workItem: workItemResult.workItem,
            acceptancePackage,
            artifacts: snapshot.artifacts,
            qaEvidence: qaResult.evidence,
            qaAttachments: qaResult.attachments.map(publishQAAttachment),
            decisions: snapshot.decisions,
            events,
            auditComplete,
          });
          const confirmation = localState.query({
            type: "GET_WORKFLOW_SNAPSHOT",
            workItemId: params.workItemId,
          });
          const confirmedPackage =
            confirmation.type === "WORKFLOW_SNAPSHOT" ? confirmation.snapshot.acceptancePackage : null;
          const stable =
            confirmedPackage?.id === acceptancePackage.id &&
            confirmedPackage.version === acceptancePackage.version &&
            confirmedPackage.status === acceptancePackage.status &&
            confirmedPackage.resolvedAt === acceptancePackage.resolvedAt;
          if (!stable) {
            if (readAttempt === 0) continue;
            throw new WorkflowDomainError(
              "ACCEPTANCE_NOT_READY",
              "The AcceptancePackage changed while its release summary was being assembled",
            );
          }
          if (rendered.type !== "RENDERED") {
            throw new WorkflowDomainError("ACCEPTANCE_NOT_READY", rendered.reason);
          }
          const portableId = acceptancePackage.id.replace(/[^A-Za-z0-9._-]/gu, "-");
          return reply
            .header("cache-control", "private, no-store")
            .header("content-disposition", `attachment; filename="loomrail-acceptance-${portableId}.md"`)
            .header("x-content-type-options", "nosniff")
            .type("text/markdown; charset=utf-8")
            .send(rendered.markdown);
        }
        throw new WorkflowDomainError(
          "ACCEPTANCE_NOT_READY",
          "The AcceptancePackage could not be read consistently",
        );
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

    await drainScaffoldOperations();
    await drainConstitutionPublications();
    await drainVerificationPlanPublications();

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
    // The advertised origin must be the address the browser will actually reach: rewriting `[::1]`
    // to `127.0.0.1` used to point the bootstrap URL at an address an IPv6-only bind does not
    // serve, and made every mutation from the `[::1]` tab fail the exact-Origin check.
    const baseUrl = address;
    allowedOrigin = baseUrl;
    // Startup reconciliation may have restored runnable work, including a bundled demo Browser QA
    // dispatch whose safe target is this exact dynamic origin. Do not let that work race ahead of
    // `listen()` and turn the not-yet-known origin into a durable QA error.
    worker.wake();
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
      whenIdle: async () => {
        await Promise.all([worker.whenIdle(), verificationRunner.whenIdle()]);
      },
      close: async () => {
        if (closing) return;
        closing = true;
        try {
          // The live session must be asked to stop before the server starts closing connections.
          await verificationRunner.stop();
          await worker.stop();
          await mcpGateway.shutdown();
          await app.close();
        } finally {
          localState.close();
        }
      },
    };
  } catch (error: unknown) {
    await verificationRunner.stop().catch(() => undefined);
    await mcpGateway.shutdown().catch(() => undefined);
    localState.close();
    await app.close();
    throw error;
  }
};

export { inspectProviderAvailability } from "./provider-selection.js";
export type { ProviderAvailabilitySnapshot } from "./provider-selection.js";
