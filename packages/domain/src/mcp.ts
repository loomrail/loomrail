import type {
  ConfirmMcpProfileCommand,
  McpCapabilitySnapshot,
  McpConsent,
  McpGrant,
  McpProfileCandidate,
  McpProfileRevision,
  McpSessionSnapshot,
  McpToolCallFailureCode,
  McpToolCallRecord,
  Project,
  RecordMcpCapabilitySnapshotCommand,
  RevokeMcpProfileGrantCommand,
  SetMcpProfileGrantCommand,
} from "@loomrail/contracts";

export type McpDomainErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_ACTIVE"
  | "PROJECT_VERSION_CONFLICT"
  | "OWNER_REQUIRED"
  | "SYSTEM_REQUIRED"
  | "EXECUTABLE_FORBIDDEN"
  | "SCRIPT_PATH_REQUIRED"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_PROJECT_MISMATCH"
  | "PROFILE_UNCHANGED"
  | "CANONICAL_DIGEST_MISMATCH"
  | "CONSENT_NOT_FOUND"
  | "CAPABILITY_NOT_READY"
  | "GRANT_NOT_FOUND"
  | "GRANT_VERSION_CONFLICT"
  | "GRANT_REVOKED"
  | "GRANT_UNCHANGED"
  | "TOOL_NOT_DECLARED"
  | "TOOL_NOT_DISCOVERED"
  | "TOOL_NOT_GRANTED"
  | "SESSION_SNAPSHOT_MISMATCH"
  | "PROVIDER_SESSION_NOT_RUNNING"
  | "TOOL_CALL_NOT_STARTED"
  | "TOOL_CALL_OUTCOME_INVALID";

export class McpDomainError extends Error {
  readonly code: McpDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: McpDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "McpDomainError";
    this.code = code;
    this.details = details;
  }
}

// Two kinds of name are refused here. The first is a shell, a downloader or a package launcher --
// something that turns a consented argv vector into "whatever this resolves to today". The second
// is a command-dispatch wrapper: `env`, `xargs`, `nohup` and their relatives do nothing themselves
// except execute their own first argument, so `/usr/bin/env` + `["bash", "-c", ...]` would walk
// straight past a list that only knows the shell by name, and the owner would be consenting to an
// "exact command" whose exactness ends at the wrapper.
const forbiddenExecutableNames = new Set([
  "ash",
  "bash",
  "bunx",
  "busybox",
  "cmd",
  "curl",
  "dash",
  "doas",
  "env",
  "fish",
  "ksh",
  "nice",
  "nohup",
  "npm",
  "npx",
  "open",
  "osascript",
  "pnpm",
  "powershell",
  "pwsh",
  "setsid",
  "sh",
  "start",
  "stdbuf",
  "sudo",
  "timeout",
  "uvx",
  "wget",
  "wsl",
  "xargs",
  "yarn",
  "zsh",
]);
const scriptRuntimeNames = new Set(["node", "nodejs", "python", "python3"]);
const absolutePathPattern = /^(?:[/\\]|[A-Za-z]:[/\\])/;

const executableName = (path: string): string => {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path
    .slice(slash + 1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/u, "");
};

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/**
 * The policy half of proposal validation. It returns a normalized candidate but performs no I/O:
 * checking that the path names an executable file belongs to daemon preflight.
 */
export const validateMcpProfileCandidatePolicy = (candidate: McpProfileCandidate): McpProfileCandidate => {
  const name = executableName(candidate.executable);
  if (forbiddenExecutableNames.has(name)) {
    throw new McpDomainError(
      "EXECUTABLE_FORBIDDEN",
      `The executable ${name} is not allowed for a local MCP profile`,
      { executable: name },
    );
  }
  if (scriptRuntimeNames.has(name)) {
    const scriptPath = candidate.args[0];
    if (scriptPath === undefined || !absolutePathPattern.test(scriptPath)) {
      throw new McpDomainError(
        "SCRIPT_PATH_REQUIRED",
        "A script runtime must receive an absolute script path as its first argument",
      );
    }
  }
  return { ...candidate, declaredTools: sortedUnique(candidate.declaredTools) };
};

/**
 * Stable bytes the daemon hashes for the exact-consent challenge.
 *
 * The digest covers what spec §D1 says a revision is -- the exact launch and the tools declared for
 * it -- and deliberately not `profileId`, which says where the recipe is filed rather than what it
 * runs. Including it made the digest incomparable across the one boundary the no-op guards exist
 * for: a first consent is proposed with `profileId: null` and every later one with the real id, so
 * an unchanged recipe never matched its own stored digest and `PROFILE_UNCHANGED` could not fire.
 * Re-approving the bundled preset then filed a second, identical revision instead of saying there
 * was nothing to approve.
 *
 * `schemaVersion` is the formula's own version, not the revision record's. It moves to 2 with this
 * change so a digest computed by either formula is recognisably from that formula. A revision stored
 * under version 1 therefore no longer matches a recomputation, which the two callers that compare
 * them read as "changed" -- the owner is asked to consent again rather than silently accepting a
 * digest nobody can reproduce.
 */
export const canonicalMcpProfileSource = (candidate: McpProfileCandidate): string => {
  const normalized = validateMcpProfileCandidatePolicy(candidate);
  return JSON.stringify({
    schemaVersion: 2,
    name: normalized.name,
    transport: "stdio",
    executable: normalized.executable,
    args: normalized.args,
    declaredTools: normalized.declaredTools,
  });
};

const requireProject = (project: Project | undefined, expectedVersion: number): Project => {
  if (!project) throw new McpDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  if (project.status !== "ACTIVE") {
    throw new McpDomainError("PROJECT_NOT_ACTIVE", "Only an active Project can change MCP settings");
  }
  if (project.version !== expectedVersion) {
    throw new McpDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after MCP settings were loaded",
      { expectedVersion, actualVersion: project.version },
    );
  }
  return project;
};

const requireOwner = (actor: ConfirmMcpProfileCommand["actor"]): string => {
  if (actor.type !== "HUMAN") {
    throw new McpDomainError("OWNER_REQUIRED", "Only the owner can consent to an MCP process or grant");
  }
  return actor.id;
};

const bumpProject = (project: Project, now: string): Project => ({
  ...project,
  version: project.version + 1,
  updatedAt: now,
});

export type McpProfileConsentedIntent = {
  type: "MCP_PROFILE_CONSENTED";
  data: { revision: McpProfileRevision; consent: McpConsent };
};

export const decideMcpProfileConfirmation = (
  command: ConfirmMcpProfileCommand,
  context: {
    now: string;
    canonicalDigest: string;
    newProfileId: string;
    newRevisionId: string;
    newConsentId: string;
    project?: Project;
    latestRevision?: McpProfileRevision;
  },
): {
  project: Project;
  revision: McpProfileRevision;
  consent: McpConsent;
  event: McpProfileConsentedIntent;
} => {
  const currentProject = requireProject(context.project, command.payload.expectedProjectVersion);
  const ownerId = requireOwner(command.actor);
  const candidate = validateMcpProfileCandidatePolicy(command.payload.candidate);
  if (context.canonicalDigest !== command.payload.canonicalDigest) {
    throw new McpDomainError(
      "CANONICAL_DIGEST_MISMATCH",
      "The confirmed MCP command does not match its canonical digest",
    );
  }

  let profileId: string;
  let revisionNumber: number;
  if (candidate.profileId === null) {
    if (context.latestRevision !== undefined) {
      throw new McpDomainError(
        "PROFILE_PROJECT_MISMATCH",
        "A new MCP profile cannot replace an existing one",
      );
    }
    profileId = context.newProfileId;
    revisionNumber = 1;
  } else {
    const latest = context.latestRevision;
    if (latest?.profileId !== candidate.profileId) {
      throw new McpDomainError("PROFILE_NOT_FOUND", "The MCP profile being revised does not exist");
    }
    if (latest.projectId !== currentProject.id) {
      throw new McpDomainError("PROFILE_PROJECT_MISMATCH", "The MCP profile belongs to another Project");
    }
    if (latest.canonicalDigest === context.canonicalDigest) {
      throw new McpDomainError("PROFILE_UNCHANGED", "The exact MCP profile revision already exists");
    }
    profileId = latest.profileId;
    revisionNumber = latest.revision + 1;
  }

  const project = bumpProject(currentProject, context.now);
  const revision: McpProfileRevision = {
    schemaVersion: 1,
    id: context.newRevisionId,
    profileId,
    projectId: project.id,
    revision: revisionNumber,
    name: candidate.name,
    executable: candidate.executable,
    args: [...candidate.args],
    declaredTools: [...candidate.declaredTools],
    canonicalDigest: context.canonicalDigest,
    createdAt: context.now,
  };
  const consent: McpConsent = {
    schemaVersion: 1,
    id: context.newConsentId,
    projectId: project.id,
    profileRevisionId: revision.id,
    canonicalDigest: revision.canonicalDigest,
    ownerId,
    consentedAt: context.now,
  };
  return {
    project,
    revision,
    consent,
    event: { type: "MCP_PROFILE_CONSENTED", data: { revision, consent } },
  };
};

export type McpGrantChangedIntent = { type: "MCP_GRANT_CHANGED"; data: { grant: McpGrant } };

const requireRevisionAndConsent = (
  project: Project,
  revision: McpProfileRevision | undefined,
  consent: McpConsent | undefined,
): { revision: McpProfileRevision; consent: McpConsent } => {
  if (!revision) throw new McpDomainError("PROFILE_NOT_FOUND", "The MCP profile revision does not exist");
  if (revision.projectId !== project.id) {
    throw new McpDomainError(
      "PROFILE_PROJECT_MISMATCH",
      "The MCP profile revision belongs to another Project",
    );
  }
  if (
    consent?.profileRevisionId !== revision.id ||
    consent.projectId !== project.id ||
    consent.canonicalDigest !== revision.canonicalDigest
  ) {
    throw new McpDomainError("CONSENT_NOT_FOUND", "The MCP profile revision has no matching owner consent");
  }
  return { revision, consent };
};

export const decideMcpCapabilitySnapshot = (
  command: RecordMcpCapabilitySnapshotCommand,
  context: {
    now: string;
    newSnapshotId: string;
    project?: Project;
    revision?: McpProfileRevision;
    consent?: McpConsent;
  },
): McpCapabilitySnapshot => {
  if (command.actor.type !== "SYSTEM") {
    throw new McpDomainError("SYSTEM_REQUIRED", "Only the daemon can record an MCP capability probe");
  }
  const project = context.project;
  if (!project) throw new McpDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  if (project.status !== "ACTIVE") {
    throw new McpDomainError("PROJECT_NOT_ACTIVE", "Only an active Project can probe an MCP profile");
  }
  const { revision } = requireRevisionAndConsent(project, context.revision, context.consent);
  return {
    schemaVersion: 1,
    id: context.newSnapshotId,
    projectId: project.id,
    profileRevisionId: revision.id,
    state: command.payload.state,
    protocolVersion: command.payload.protocolVersion,
    tools: sortedUnique(command.payload.tools),
    resources: sortedUnique(command.payload.resources),
    prompts: sortedUnique(command.payload.prompts),
    observedAt: context.now,
  };
};

export const decideMcpProfileGrant = (
  command: SetMcpProfileGrantCommand,
  context: {
    now: string;
    newGrantId: string;
    project?: Project;
    revision?: McpProfileRevision;
    consent?: McpConsent;
    capability?: McpCapabilitySnapshot;
    currentGrant?: McpGrant;
  },
): { project: Project; grant: McpGrant; event: McpGrantChangedIntent } => {
  const currentProject = requireProject(context.project, command.payload.expectedProjectVersion);
  const ownerId = requireOwner(command.actor);
  const { revision } = requireRevisionAndConsent(currentProject, context.revision, context.consent);
  const capability = context.capability;
  if (
    capability?.projectId !== currentProject.id ||
    capability.profileRevisionId !== revision.id ||
    capability.state !== "READY"
  ) {
    throw new McpDomainError(
      "CAPABILITY_NOT_READY",
      "A successful capability probe is required before granting MCP tools",
    );
  }

  const tools = sortedUnique(command.payload.tools);
  const declared = new Set(revision.declaredTools);
  const discovered = new Set(capability.tools);
  for (const tool of tools) {
    if (!declared.has(tool)) {
      throw new McpDomainError("TOOL_NOT_DECLARED", `The MCP tool ${tool} was not declared by the owner`, {
        tool,
      });
    }
    if (!discovered.has(tool)) {
      throw new McpDomainError("TOOL_NOT_DISCOVERED", `The MCP tool ${tool} was not found by the probe`, {
        tool,
      });
    }
  }

  const current = context.currentGrant;
  if (current === undefined) {
    if (command.payload.expectedGrantVersion !== null) {
      throw new McpDomainError("GRANT_NOT_FOUND", "The expected MCP grant does not exist");
    }
  } else {
    if (current.profileRevisionId !== revision.id || current.projectId !== currentProject.id) {
      throw new McpDomainError("GRANT_NOT_FOUND", "The MCP grant does not match this profile revision");
    }
    if (command.payload.expectedGrantVersion !== current.version) {
      throw new McpDomainError("GRANT_VERSION_CONFLICT", "The MCP grant changed after it was loaded", {
        expectedVersion: command.payload.expectedGrantVersion ?? 0,
        actualVersion: current.version,
      });
    }
    if (!current.enabled) {
      throw new McpDomainError("GRANT_REVOKED", "A revoked MCP grant cannot be enabled again");
    }
    if (
      current.tools.length === tools.length &&
      current.tools.every((tool, index) => tool === tools[index])
    ) {
      throw new McpDomainError("GRANT_UNCHANGED", "The same MCP tools are already granted");
    }
  }

  const project = bumpProject(currentProject, context.now);
  const grant: McpGrant = current
    ? {
        ...current,
        tools,
        version: current.version + 1,
        grantedBy: ownerId,
        updatedAt: context.now,
      }
    : {
        schemaVersion: 1,
        id: context.newGrantId,
        projectId: project.id,
        profileRevisionId: revision.id,
        tools,
        enabled: true,
        version: 1,
        grantedBy: ownerId,
        createdAt: context.now,
        updatedAt: context.now,
        revokedAt: null,
      };
  return { project, grant, event: { type: "MCP_GRANT_CHANGED", data: { grant } } };
};

export const decideMcpProfileGrantRevocation = (
  command: RevokeMcpProfileGrantCommand,
  context: {
    now: string;
    project?: Project;
    revision?: McpProfileRevision;
    consent?: McpConsent;
    currentGrant?: McpGrant;
  },
): { project: Project; grant: McpGrant; event: McpGrantChangedIntent } => {
  const currentProject = requireProject(context.project, command.payload.expectedProjectVersion);
  requireOwner(command.actor);
  const { revision } = requireRevisionAndConsent(currentProject, context.revision, context.consent);
  const current = context.currentGrant;
  if (current?.profileRevisionId !== revision.id || current.projectId !== currentProject.id) {
    throw new McpDomainError("GRANT_NOT_FOUND", "The MCP grant does not exist");
  }
  if (current.version !== command.payload.expectedGrantVersion) {
    throw new McpDomainError("GRANT_VERSION_CONFLICT", "The MCP grant changed after it was loaded", {
      expectedVersion: command.payload.expectedGrantVersion,
      actualVersion: current.version,
    });
  }
  if (!current.enabled) throw new McpDomainError("GRANT_REVOKED", "The MCP grant is already revoked");

  const project = bumpProject(currentProject, context.now);
  const grant: McpGrant = {
    ...current,
    enabled: false,
    version: current.version + 1,
    updatedAt: context.now,
    revokedAt: context.now,
  };
  return { project, grant, event: { type: "MCP_GRANT_CHANGED", data: { grant } } };
};

export const decideMcpSessionSnapshots = (context: {
  now: string;
  projectId: string;
  providerSessionId: string;
  revisions: readonly McpProfileRevision[];
  grants: readonly McpGrant[];
  newSnapshotIds: readonly string[];
}): McpSessionSnapshot[] => {
  const revisions = new Map(context.revisions.map((revision) => [revision.id, revision]));
  const enabled = context.grants.filter((grant) => grant.enabled);
  if (enabled.length !== context.newSnapshotIds.length) {
    throw new McpDomainError(
      "SESSION_SNAPSHOT_MISMATCH",
      "Every enabled MCP grant needs exactly one session snapshot ID",
    );
  }
  return enabled.map((grant, index) => {
    const revision = revisions.get(grant.profileRevisionId);
    if (revision?.projectId !== context.projectId || grant.projectId !== context.projectId) {
      throw new McpDomainError(
        "SESSION_SNAPSHOT_MISMATCH",
        "An enabled MCP grant does not resolve to this Project",
      );
    }
    const id = context.newSnapshotIds[index];
    if (id === undefined) {
      throw new McpDomainError("SESSION_SNAPSHOT_MISMATCH", "An MCP session snapshot ID is missing");
    }
    return {
      schemaVersion: 1,
      id,
      projectId: context.projectId,
      providerSessionId: context.providerSessionId,
      profileRevisionId: revision.id,
      profileDigest: revision.canonicalDigest,
      grantId: grant.id,
      grantVersion: grant.version,
      tools: [...grant.tools],
      createdAt: context.now,
    };
  });
};

export const decideMcpToolCallStart = (context: {
  now: string;
  newCallId: string;
  inputDigest: string;
  toolName: string;
  snapshot: McpSessionSnapshot;
  sessionRunning: boolean;
  currentGrant?: McpGrant;
}): McpToolCallRecord => {
  if (!context.sessionRunning) {
    throw new McpDomainError("PROVIDER_SESSION_NOT_RUNNING", "The MCP provider session is not running");
  }
  const grant = context.currentGrant;
  if (grant?.id !== context.snapshot.grantId || grant.projectId !== context.snapshot.projectId) {
    throw new McpDomainError("GRANT_NOT_FOUND", "The MCP session grant does not exist");
  }
  if (!grant.enabled) throw new McpDomainError("GRANT_REVOKED", "The MCP session grant is revoked");
  if (!context.snapshot.tools.includes(context.toolName) || !grant.tools.includes(context.toolName)) {
    throw new McpDomainError("TOOL_NOT_GRANTED", "The MCP tool is not granted to this session", {
      tool: context.toolName,
    });
  }
  return {
    schemaVersion: 1,
    id: context.newCallId,
    projectId: context.snapshot.projectId,
    providerSessionId: context.snapshot.providerSessionId,
    sessionSnapshotId: context.snapshot.id,
    profileRevisionId: context.snapshot.profileRevisionId,
    toolName: context.toolName,
    inputDigest: context.inputDigest,
    status: "STARTED",
    failureCode: null,
    startedAt: context.now,
    finishedAt: null,
  };
};

export const decideMcpToolCallFinished = (
  current: McpToolCallRecord,
  outcome:
    { status: "SUCCEEDED" } | { status: "FAILED" | "UNKNOWN_OUTCOME"; failureCode: McpToolCallFailureCode },
  now: string,
): McpToolCallRecord => {
  if (current.status !== "STARTED") {
    throw new McpDomainError("TOOL_CALL_NOT_STARTED", "Only a started MCP tool call can finish");
  }
  if (outcome.status === "SUCCEEDED") {
    return { ...current, status: "SUCCEEDED", failureCode: null, finishedAt: now };
  }
  if (outcome.status === "UNKNOWN_OUTCOME" && outcome.failureCode !== "CONNECTION_LOST") {
    throw new McpDomainError(
      "TOOL_CALL_OUTCOME_INVALID",
      "An unknown MCP outcome must be caused by a lost connection",
    );
  }
  return { ...current, status: outcome.status, failureCode: outcome.failureCode, finishedAt: now };
};
