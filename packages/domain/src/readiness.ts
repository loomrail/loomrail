import type {
  AttestProjectReadinessCheckCommand,
  Project,
  ProjectReadinessRun,
  ReadinessAttestation,
  ReadinessCheck,
  ReadinessCheckDraft,
  RecordProjectReadinessAssessmentCommand,
  SecurityFinding,
} from "@loomrail/contracts";

export type ReadinessDomainErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_VERSION_CONFLICT"
  | "PROJECT_NOT_ACTIVE"
  | "READINESS_CATALOG_INVALID"
  | "READINESS_RUN_NOT_FOUND"
  | "READINESS_RUN_NOT_LATEST"
  | "READINESS_RUN_VERSION_CONFLICT"
  | "READINESS_CHECK_NOT_FOUND"
  | "READINESS_CHECK_NOT_OWNER"
  | "READINESS_ATTESTATION_UNCHANGED"
  | "OWNER_REQUIRED";

export class ReadinessDomainError extends Error {
  readonly code: ReadinessDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: ReadinessDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "ReadinessDomainError";
    this.code = code;
    this.details = details;
  }
}

const catalog = [
  ["SECURITY_ACTIVE_CONSTITUTION", "SECURITY", "AUTOMATED"],
  ["SECURITY_SECRET_PATHS", "SECURITY", "AUTOMATED"],
  ["SECURITY_ENV_IGNORED", "SECURITY", "AUTOMATED"],
  ["SECURITY_CI_HARDENING", "SECURITY", "AUTOMATED"],
  ["LEGAL_LICENSE", "LEGAL", "AUTOMATED"],
  ["LEGAL_OWNER_REVIEW", "LEGAL", "OWNER"],
  ["PAYMENTS_OWNER_REVIEW", "PAYMENTS", "OWNER"],
  ["ANALYTICS_OWNER_REVIEW", "ANALYTICS", "OWNER"],
] as const satisfies readonly (readonly [
  ReadinessCheckDraft["key"],
  ReadinessCheckDraft["category"],
  ReadinessCheckDraft["mode"],
])[];

const requireProject = (project: Project | undefined, expectedVersion: number): Project => {
  if (!project) throw new ReadinessDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  if (project.version !== expectedVersion) {
    throw new ReadinessDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after readiness was loaded",
      { expectedVersion, actualVersion: project.version },
    );
  }
  if (project.status !== "ACTIVE") {
    throw new ReadinessDomainError("PROJECT_NOT_ACTIVE", "Only an active Project can be checked");
  }
  return project;
};

const validateCatalog = (drafts: readonly ReadinessCheckDraft[]): void => {
  const byKey = new Map(drafts.map((draft) => [draft.key, draft]));
  if (byKey.size !== catalog.length || drafts.length !== catalog.length) {
    throw new ReadinessDomainError(
      "READINESS_CATALOG_INVALID",
      "The readiness assessment catalog is incomplete",
    );
  }
  for (const [key, category, mode] of catalog) {
    const draft = byKey.get(key);
    if (draft?.category !== category || draft.mode !== mode) {
      throw new ReadinessDomainError(
        "READINESS_CATALOG_INVALID",
        "The readiness assessment catalog is invalid",
      );
    }
    if (mode === "OWNER" && (draft.status !== "ACTION_REQUIRED" || draft.findings.length > 0)) {
      throw new ReadinessDomainError(
        "READINESS_CATALOG_INVALID",
        "Owner readiness checks must begin unresolved and without scanner findings",
      );
    }
    if (mode === "AUTOMATED" && (draft.status === "PASSED") !== (draft.findings.length === 0)) {
      throw new ReadinessDomainError(
        "READINESS_CATALOG_INVALID",
        "Automated readiness status must agree with its findings",
      );
    }
  }
};

export type ProjectReadinessAssessedIntent = {
  type: "PROJECT_READINESS_ASSESSED";
  data: {
    run: ProjectReadinessRun;
    checks: readonly ReadinessCheck[];
    findings: readonly SecurityFinding[];
  };
};

export const decideProjectReadinessAssessment = (
  command: RecordProjectReadinessAssessmentCommand,
  context: {
    now: string;
    newRunId: string;
    newCheckIds: readonly string[];
    newFindingIds: readonly string[];
    project?: Project;
  },
): {
  run: ProjectReadinessRun;
  checks: readonly ReadinessCheck[];
  findings: readonly SecurityFinding[];
  event: ProjectReadinessAssessedIntent;
} => {
  const project = requireProject(context.project, command.payload.expectedProjectVersion);
  validateCatalog(command.payload.checks);
  if (context.newCheckIds.length !== catalog.length) {
    throw new ReadinessDomainError("READINESS_CATALOG_INVALID", "Readiness check identifiers are incomplete");
  }
  const findingCount = command.payload.checks.reduce((count, check) => count + check.findings.length, 0);
  if (context.newFindingIds.length !== findingCount) {
    throw new ReadinessDomainError(
      "READINESS_CATALOG_INVALID",
      "Readiness finding identifiers are incomplete",
    );
  }

  let findingIndex = 0;
  const findings: SecurityFinding[] = [];
  const checks = catalog.map(([key], checkIndex): ReadinessCheck => {
    const draft = command.payload.checks.find((candidate) => candidate.key === key);
    const id = context.newCheckIds[checkIndex];
    if (!draft || !id) {
      throw new ReadinessDomainError(
        "READINESS_CATALOG_INVALID",
        "Readiness assessment catalog is incomplete",
      );
    }
    const check: ReadinessCheck = {
      schemaVersion: 1,
      id,
      runId: context.newRunId,
      projectId: project.id,
      key: draft.key,
      category: draft.category,
      mode: draft.mode,
      status: draft.status,
      summary: draft.summary,
      version: 1,
    };
    for (const draftFinding of draft.findings) {
      const findingId = context.newFindingIds[findingIndex];
      if (!findingId) {
        throw new ReadinessDomainError("READINESS_CATALOG_INVALID", "Readiness findings are incomplete");
      }
      findings.push({
        schemaVersion: 1,
        id: findingId,
        runId: context.newRunId,
        checkId: check.id,
        projectId: project.id,
        ...draftFinding,
      });
      findingIndex += 1;
    }
    return check;
  });
  const run: ProjectReadinessRun = {
    schemaVersion: 1,
    id: context.newRunId,
    projectId: project.id,
    repositoryHead: command.payload.repositoryHead,
    sourceDigest: command.payload.sourceDigest,
    workingTreeDirty: command.payload.workingTreeDirty,
    status: checks.some((check) => check.status === "ACTION_REQUIRED") ? "ACTION_REQUIRED" : "READY",
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
  };
  const event: ProjectReadinessAssessedIntent = {
    type: "PROJECT_READINESS_ASSESSED",
    data: { run, checks, findings },
  };
  return { run, checks, findings, event };
};

export type ProjectReadinessAttestedIntent = {
  type: "PROJECT_READINESS_ATTESTED";
  data: {
    run: ProjectReadinessRun;
    check: ReadinessCheck;
    attestation: ReadinessAttestation;
  };
};

export const decideProjectReadinessAttestation = (
  command: AttestProjectReadinessCheckCommand,
  context: {
    now: string;
    newAttestationId: string;
    run?: ProjectReadinessRun;
    latestRunId?: string;
    check?: ReadinessCheck;
    checks: readonly ReadinessCheck[];
  },
): {
  run: ProjectReadinessRun;
  check: ReadinessCheck;
  attestation: ReadinessAttestation;
  event: ProjectReadinessAttestedIntent;
} => {
  // An OWNER-mode check is the owner's judgement about licences, payments and data handling, and it
  // is what flips a Run to READY. That the actor is the owner is therefore part of the decision, not
  // a detail of whichever route happens to reach it -- the deterministic model owns this, the same
  // way `requireOwner` owns MCP consent.
  if (command.actor.type !== "HUMAN") {
    throw new ReadinessDomainError("OWNER_REQUIRED", "Only the owner can attest a Project Readiness check");
  }
  const currentRun = context.run;
  if (currentRun?.id !== command.payload.runId) {
    throw new ReadinessDomainError("READINESS_RUN_NOT_FOUND", "The Project Readiness Run does not exist");
  }
  if (currentRun.projectId !== command.payload.projectId) {
    throw new ReadinessDomainError("READINESS_RUN_NOT_FOUND", "The Project Readiness Run does not exist");
  }
  if (context.latestRunId !== currentRun.id) {
    throw new ReadinessDomainError(
      "READINESS_RUN_NOT_LATEST",
      "Only the latest Readiness Run can be attested",
    );
  }
  if (currentRun.version !== command.payload.expectedRunVersion) {
    throw new ReadinessDomainError(
      "READINESS_RUN_VERSION_CONFLICT",
      "The Readiness Run changed after it was loaded",
      { expectedVersion: command.payload.expectedRunVersion, actualVersion: currentRun.version },
    );
  }
  const currentCheck = context.check;
  if (currentCheck?.id !== command.payload.checkId) {
    throw new ReadinessDomainError(
      "READINESS_CHECK_NOT_FOUND",
      "The Readiness Check does not exist in this Run",
    );
  }
  if (currentCheck.runId !== currentRun.id || currentCheck.projectId !== currentRun.projectId) {
    throw new ReadinessDomainError(
      "READINESS_CHECK_NOT_FOUND",
      "The Readiness Check does not exist in this Run",
    );
  }
  if (currentCheck.mode !== "OWNER") {
    throw new ReadinessDomainError(
      "READINESS_CHECK_NOT_OWNER",
      "Automated Readiness Checks cannot be attested",
    );
  }
  if (currentCheck.status === command.payload.outcome) {
    throw new ReadinessDomainError(
      "READINESS_ATTESTATION_UNCHANGED",
      "The owner check already has this attestation outcome",
    );
  }

  const check: ReadinessCheck = {
    ...currentCheck,
    status: command.payload.outcome,
    version: currentCheck.version + 1,
  };
  const allChecks = context.checks.map((candidate) => (candidate.id === check.id ? check : candidate));
  const run: ProjectReadinessRun = {
    ...currentRun,
    status: allChecks.some((candidate) => candidate.status === "ACTION_REQUIRED")
      ? "ACTION_REQUIRED"
      : "READY",
    version: currentRun.version + 1,
    updatedAt: context.now,
  };
  const attestation: ReadinessAttestation = {
    schemaVersion: 1,
    id: context.newAttestationId,
    runId: run.id,
    checkId: check.id,
    projectId: run.projectId,
    outcome: command.payload.outcome,
    rationale: command.payload.rationale,
    actor: command.actor,
    createdAt: context.now,
  };
  const event: ProjectReadinessAttestedIntent = {
    type: "PROJECT_READINESS_ATTESTED",
    data: { run, check, attestation },
  };
  return { run, check, attestation, event };
};
