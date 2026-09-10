import type {
  AcceptancePackage,
  Actor,
  CreateLaunchReleaseCommand,
  EvidenceArtifact,
  LaunchEnvironment,
  LaunchRelease,
  LaunchReleaseEvidenceRef,
  LaunchReleaseFreshness,
  LaunchReleaseGate,
  LaunchReleaseGateKey,
  LaunchReleaseGateStatus,
  LaunchReleaseWorkItemEvidence,
  LaunchMeasurementPlan,
  LaunchMeasurementRun,
  Project,
  ProjectReadinessSnapshot,
  SaveLaunchEnvironmentCommand,
  VerificationPlan,
} from "@loomrail/contracts";
import {
  MAX_LAUNCH_ENVIRONMENTS,
  MAX_LAUNCH_EVIDENCE_PACKAGE_BYTES,
  launchReleaseGateKeySchema,
} from "@loomrail/contracts";

export type LaunchReleaseDomainErrorCode =
  | "OWNER_REQUIRED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_ACTIVE"
  | "PROJECT_VERSION_CONFLICT"
  | "ENVIRONMENT_NOT_FOUND"
  | "ENVIRONMENT_VERSION_CONFLICT"
  | "ENVIRONMENT_KIND_CONFLICT"
  | "ENVIRONMENT_LIMIT_REACHED"
  | "EVIDENCE_BOUNDARY_INVALID"
  | "RELEASE_NOT_FOUND"
  | "EVIDENCE_PACKAGE_TOO_LARGE";

export class LaunchReleaseDomainError extends Error {
  readonly code: LaunchReleaseDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: LaunchReleaseDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "LaunchReleaseDomainError";
    this.code = code;
    this.details = details;
  }
}

export type LaunchEnvironmentChangedIntent = {
  type: "LAUNCH_ENVIRONMENT_CHANGED";
  data: { environment: LaunchEnvironment };
};

export type LaunchReleaseCreatedIntent = {
  type: "LAUNCH_RELEASE_CREATED";
  data: { release: LaunchRelease };
};

export type LaunchWorkflowEvidenceInput = {
  workItemId: string;
  acceptancePackage: AcceptancePackage | null;
  availableArtifacts: readonly EvidenceArtifact[];
};

const requireOwner = (actor: Actor): void => {
  if (actor.type !== "HUMAN") {
    throw new LaunchReleaseDomainError(
      "OWNER_REQUIRED",
      "Only the owner can configure an Environment or create a Release snapshot",
    );
  }
};

const requireProject = (project: Project | undefined, projectId: string): Project => {
  if (project?.id !== projectId) {
    throw new LaunchReleaseDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (project.status !== "ACTIVE") {
    throw new LaunchReleaseDomainError("PROJECT_NOT_ACTIVE", "Release evidence needs an active Project");
  }
  return project;
};

const changedProject = (project: Project, now: string): Project => ({
  ...project,
  version: project.version + 1,
  updatedAt: now,
});

export const decideSaveLaunchEnvironment = (
  command: SaveLaunchEnvironmentCommand,
  context: {
    now: string;
    newEnvironmentId: string;
    contentHash: string;
    project: Project | undefined;
    currentEnvironment: LaunchEnvironment | undefined;
    environmentCount: number;
    sameKindEnvironment: LaunchEnvironment | undefined;
  },
): { project: Project; environment: LaunchEnvironment; event: LaunchEnvironmentChangedIntent } => {
  requireOwner(command.actor);
  const currentProject = requireProject(context.project, command.payload.projectId);
  if (currentProject.version !== command.payload.expectedProjectVersion) {
    throw new LaunchReleaseDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after launch settings were loaded",
      { expectedVersion: command.payload.expectedProjectVersion, actualVersion: currentProject.version },
    );
  }

  const updating = command.payload.environmentId !== null;
  if (updating) {
    if (context.currentEnvironment?.id !== command.payload.environmentId) {
      throw new LaunchReleaseDomainError("ENVIRONMENT_NOT_FOUND", "The launch Environment does not exist");
    }
    if (context.currentEnvironment.projectId !== currentProject.id) {
      throw new LaunchReleaseDomainError(
        "EVIDENCE_BOUNDARY_INVALID",
        "The launch Environment belongs to a different Project",
      );
    }
    if (context.currentEnvironment.version !== command.payload.expectedEnvironmentVersion) {
      throw new LaunchReleaseDomainError(
        "ENVIRONMENT_VERSION_CONFLICT",
        "The launch Environment changed after it was loaded",
      );
    }
    if (context.currentEnvironment.kind !== command.payload.configuration.kind) {
      throw new LaunchReleaseDomainError(
        "ENVIRONMENT_KIND_CONFLICT",
        "An Environment kind cannot change after creation",
      );
    }
  } else if (context.environmentCount >= MAX_LAUNCH_ENVIRONMENTS) {
    throw new LaunchReleaseDomainError(
      "ENVIRONMENT_LIMIT_REACHED",
      "This Project already has the maximum number of launch Environments",
    );
  }

  if (
    context.sameKindEnvironment !== undefined &&
    context.sameKindEnvironment.id !== context.currentEnvironment?.id
  ) {
    throw new LaunchReleaseDomainError(
      "ENVIRONMENT_KIND_CONFLICT",
      "This Project already has an Environment of the selected kind",
    );
  }

  const environment: LaunchEnvironment = {
    schemaVersion: 1,
    id: context.currentEnvironment?.id ?? context.newEnvironmentId,
    projectId: currentProject.id,
    ...command.payload.configuration,
    contentHash: context.contentHash,
    version: (context.currentEnvironment?.version ?? 0) + 1,
    createdAt: context.currentEnvironment?.createdAt ?? context.now,
    updatedAt: context.now,
  };
  const project = changedProject(currentProject, context.now);
  return {
    project,
    environment,
    event: { type: "LAUNCH_ENVIRONMENT_CHANGED", data: { environment } },
  };
};

const gateRef = (
  kind: LaunchReleaseEvidenceRef["kind"],
  id: string,
  version: number | null,
  testedTree: string | null,
): LaunchReleaseEvidenceRef => ({ kind, id, version, testedTree });

const readinessGateKeys: Readonly<Record<string, LaunchReleaseGateKey>> = {
  SECURITY_ACTIVE_CONSTITUTION: "READINESS/SECURITY_ACTIVE_CONSTITUTION",
  SECURITY_SECRET_PATHS: "READINESS/SECURITY_SECRET_PATHS",
  SECURITY_ENV_IGNORED: "READINESS/SECURITY_ENV_IGNORED",
  SECURITY_CI_HARDENING: "READINESS/SECURITY_CI_HARDENING",
  LEGAL_LICENSE: "READINESS/LEGAL_LICENSE",
  LEGAL_OWNER_REVIEW: "READINESS/LEGAL_OWNER_REVIEW",
  PAYMENTS_OWNER_REVIEW: "READINESS/PAYMENTS_OWNER_REVIEW",
  ANALYTICS_OWNER_REVIEW: "READINESS/ANALYTICS_OWNER_REVIEW",
  DEPS_LOCKFILE_PRESENT: "READINESS/DEPS_LOCKFILE_PRESENT",
  ENV_PROD_SEPARATION: "READINESS/ENV_PROD_SEPARATION",
  SECURITY_HEADERS_OWNER_REVIEW: "READINESS/SECURITY_HEADERS_OWNER_REVIEW",
  OPS_HEALTH_ENDPOINT_DECLARED: "READINESS/OPS_HEALTH_ENDPOINT_DECLARED",
  OPS_ROLLBACK_PLAN: "READINESS/OPS_ROLLBACK_PLAN",
  OPS_BACKUP: "READINESS/OPS_BACKUP",
};

const measuredGateKeys: Readonly<Record<string, LaunchReleaseGateKey>> = {
  PERF_WEB_VITALS: "MEASURED/PERF_WEB_VITALS",
  PERF_BUNDLE_BUDGET: "MEASURED/PERF_BUNDLE_BUDGET",
  SEC_RESPONSE_HEADERS: "MEASURED/SEC_RESPONSE_HEADERS",
  SEC_UNAUTHENTICATED_ROUTES: "MEASURED/SEC_UNAUTHENTICATED_ROUTES",
  SEC_CLIENT_BUNDLE_SECRETS: "MEASURED/SEC_CLIENT_BUNDLE_SECRETS",
  DEPS_AUDIT: "MEASURED/DEPS_AUDIT",
};

const unwaivable = new Set<LaunchReleaseGateKey>([
  "READINESS/SECURITY_SECRET_PATHS",
  "READINESS/ENV_PROD_SEPARATION",
  "MEASURED/SEC_CLIENT_BUNDLE_SECRETS",
]);

const gate = (
  key: LaunchReleaseGateKey,
  status: LaunchReleaseGateStatus,
  summary: string,
  evidenceRefs: readonly LaunchReleaseEvidenceRef[],
): LaunchReleaseGate => ({
  key,
  status,
  required: true,
  waivable: !unwaivable.has(key),
  summary,
  evidenceRefs: [...evidenceRefs],
});

const readinessGates = (
  snapshot: ProjectReadinessSnapshot,
  source: { sourceTree: string; sourceHead: string | null; sourceHeadTree: string | null },
): LaunchReleaseGate[] => {
  const byKey = new Map(snapshot.checks.map((check) => [check.key, check]));
  return Object.entries(readinessGateKeys).map(([readinessKey, releaseKey]) => {
    const check = byKey.get(readinessKey as ProjectReadinessSnapshot["checks"][number]["key"]);
    if (snapshot.run === null || check === undefined) {
      return gate(releaseKey, "ACTION_REQUIRED", "No current Project readiness evidence is recorded.", []);
    }
    const dirty = snapshot.run.workingTreeDirty;
    const sourceCurrent =
      snapshot.run.repositoryHead !== null &&
      snapshot.run.repositoryHead === source.sourceHead &&
      source.sourceHeadTree === source.sourceTree;
    const passed = check.status !== "ACTION_REQUIRED";
    return gate(
      releaseKey,
      !sourceCurrent ? "STALE" : passed && !dirty ? "PASSED" : "ACTION_REQUIRED",
      !sourceCurrent
        ? "Project readiness evidence belongs to a different repository tree."
        : dirty && passed
          ? "The readiness check passed, but its repository snapshot contained uncommitted changes."
          : check.summary,
      [gateRef("READINESS_CHECK", check.id, check.version, sourceCurrent ? source.sourceTree : null)],
    );
  });
};

const measuredGates = (input: {
  sourceTree: string;
  plan: LaunchMeasurementPlan | undefined;
  run: LaunchMeasurementRun | undefined;
}): LaunchReleaseGate[] => {
  const resultByKey = new Map(input.run?.results.map((result) => [result.key, result]) ?? []);
  const sourceCurrent =
    input.plan?.status === "ACTIVE" &&
    input.run?.planId === input.plan.id &&
    input.run.planRevision === input.plan.revision &&
    input.run.planContentHash === input.plan.contentHash &&
    input.run.testedTree === input.sourceTree;
  return Object.entries(measuredGateKeys).map(([measurementKey, releaseKey]) => {
    const result = resultByKey.get(measurementKey as LaunchMeasurementRun["results"][number]["key"]);
    if (input.run === undefined || input.plan === undefined || result === undefined) {
      return gate(releaseKey, "ACTION_REQUIRED", "No complete launch measurement evidence is recorded.", []);
    }
    if (!sourceCurrent) {
      return gate(releaseKey, "STALE", "Launch measurement evidence belongs to a different tree or Plan.", [
        gateRef("LAUNCH_MEASUREMENT_RUN", input.run.id, input.run.version, input.run.testedTree),
      ]);
    }
    return gate(releaseKey, result.status === "ERROR" ? "FAILED" : result.status, result.summary, [
      gateRef("LAUNCH_MEASUREMENT_RUN", input.run.id, input.run.version, input.run.testedTree),
    ]);
  });
};

const requireWorkflowBoundary = (
  project: Project,
  input: LaunchWorkflowEvidenceInput,
): LaunchReleaseWorkItemEvidence => {
  const packageValue = input.acceptancePackage;
  if (packageValue === null) {
    return {
      workItemId: input.workItemId,
      pipelineRunId: null,
      acceptancePackageId: null,
      acceptancePackageVersion: null,
      acceptanceStatus: null,
      reviewArtifactId: null,
      qaArtifactId: null,
      verificationRunId: null,
      verificationPlanId: null,
      verificationPlanRevision: null,
      verificationPlanContentHash: null,
      testedTree: null,
    };
  }
  if (packageValue.projectId !== project.id || packageValue.workItemId !== input.workItemId) {
    throw new LaunchReleaseDomainError(
      "EVIDENCE_BOUNDARY_INVALID",
      "An AcceptancePackage crosses the selected Project or WorkItem boundary",
    );
  }
  const availableById = new Map(input.availableArtifacts.map((artifact) => [artifact.id, artifact]));
  const referencedArtifacts = packageValue.artifactIds.map((artifactId) => availableById.get(artifactId));
  if (referencedArtifacts.some((artifact) => artifact === undefined)) {
    throw new LaunchReleaseDomainError(
      "EVIDENCE_BOUNDARY_INVALID",
      "The AcceptancePackage names workflow evidence that is unavailable",
    );
  }
  const selectedArtifacts = referencedArtifacts.filter(
    (artifact): artifact is EvidenceArtifact => artifact !== undefined,
  );
  if (
    selectedArtifacts.some(
      (artifact) =>
        artifact.projectId !== project.id ||
        artifact.workItemId !== input.workItemId ||
        artifact.pipelineRunId !== packageValue.pipelineRunId,
    )
  ) {
    throw new LaunchReleaseDomainError(
      "EVIDENCE_BOUNDARY_INVALID",
      "Workflow evidence crosses a Project, WorkItem or PipelineRun boundary",
    );
  }
  const review = selectedArtifacts.find(({ kind }) => kind === "REVIEW_REPORT");
  const qa = selectedArtifacts.find(({ kind }) => kind === "QA_REPORT");
  const authorityBoundReview =
    review?.reviewReportId !== undefined && review.testedTree !== undefined ? review : undefined;
  const authorityBoundQA =
    qa?.qaRunId !== undefined && qa.qaEvidenceBundleId !== undefined && qa.testedTree !== undefined
      ? qa
      : undefined;
  const verifiedTree = packageValue.verificationEvidence?.implementationTree ?? null;
  const evidenceTrees = [verifiedTree, authorityBoundReview?.testedTree, authorityBoundQA?.testedTree].filter(
    (value): value is string => value !== null && value !== undefined,
  );
  if (new Set(evidenceTrees).size > 1) {
    throw new LaunchReleaseDomainError(
      "EVIDENCE_BOUNDARY_INVALID",
      "Review, QA and Verification evidence do not share one implementation tree",
    );
  }
  return {
    workItemId: input.workItemId,
    pipelineRunId: packageValue.pipelineRunId,
    acceptancePackageId: packageValue.id,
    acceptancePackageVersion: packageValue.version,
    acceptanceStatus: packageValue.status,
    reviewArtifactId: authorityBoundReview?.id ?? null,
    qaArtifactId: authorityBoundQA?.id ?? null,
    verificationRunId: packageValue.verificationEvidence?.verificationRunId ?? null,
    verificationPlanId: packageValue.verificationEvidence?.planId ?? null,
    verificationPlanRevision: packageValue.verificationEvidence?.planRevision ?? null,
    verificationPlanContentHash: packageValue.verificationEvidence?.planContentHash ?? null,
    testedTree: verifiedTree ?? authorityBoundReview?.testedTree ?? authorityBoundQA?.testedTree ?? null,
  };
};

const aggregateGate = (
  key: LaunchReleaseGateKey,
  workItems: readonly LaunchReleaseWorkItemEvidence[],
  selector: (
    evidence: LaunchReleaseWorkItemEvidence,
  ) => { id: string; kind: LaunchReleaseEvidenceRef["kind"] } | null,
  sourceTree: string,
): LaunchReleaseGate => {
  const selected = workItems.map(selector);
  if (workItems.length === 0) {
    return gate(key, "ACTION_REQUIRED", "No WorkItems were selected for this Release snapshot.", []);
  }
  if (selected.some((value) => value === null)) {
    return gate(key, "ACTION_REQUIRED", "One or more selected WorkItems have no complete evidence.", []);
  }
  const stale = workItems.some(({ testedTree }) => testedTree !== sourceTree);
  return gate(
    key,
    stale ? "STALE" : "PASSED",
    stale
      ? "One or more selected WorkItems were verified on a different tree."
      : "Every selected WorkItem has current authority-bound evidence.",
    selected.flatMap((value, index) => {
      if (value === null) return [];
      const item = workItems[index];
      return [
        gateRef(
          value.kind,
          value.id,
          value.kind === "ACCEPTANCE_PACKAGE" ? (item?.acceptancePackageVersion ?? null) : null,
          item?.testedTree ?? null,
        ),
      ];
    }),
  );
};

const workflowGates = (
  workItems: readonly LaunchReleaseWorkItemEvidence[],
  sourceTree: string,
  verificationPlan: VerificationPlan | undefined,
): LaunchReleaseGate[] => {
  const verification = aggregateGate(
    "VERIFICATION/REQUIRED_RECIPES",
    workItems,
    (item) =>
      item.verificationRunId === null ? null : { id: item.verificationRunId, kind: "VERIFICATION_RUN" },
    sourceTree,
  );
  if (
    verification.status === "PASSED" &&
    (verificationPlan?.status !== "ACTIVE" ||
      workItems.some(
        (item) =>
          item.verificationRunId === null ||
          item.verificationPlanId !== verificationPlan.id ||
          item.verificationPlanRevision !== verificationPlan.revision ||
          item.verificationPlanContentHash !== verificationPlan.contentHash,
      ))
  ) {
    verification.status = "STALE";
    verification.summary =
      "Selected verification evidence does not match an active Project Verification Plan.";
  }
  return [
    verification,
    aggregateGate(
      "REVIEW/SELECTED_WORK_ITEMS",
      workItems,
      (item) =>
        item.reviewArtifactId === null ? null : { id: item.reviewArtifactId, kind: "EVIDENCE_ARTIFACT" },
      sourceTree,
    ),
    aggregateGate(
      "QA/SELECTED_WORK_ITEMS",
      workItems,
      (item) => (item.qaArtifactId === null ? null : { id: item.qaArtifactId, kind: "EVIDENCE_ARTIFACT" }),
      sourceTree,
    ),
    aggregateGate(
      "ACCEPTANCE/SELECTED_WORK_ITEMS",
      workItems,
      (item) =>
        item.acceptancePackageId === null || item.acceptanceStatus !== "ACCEPTED"
          ? null
          : { id: item.acceptancePackageId, kind: "ACCEPTANCE_PACKAGE" },
      sourceTree,
    ),
  ];
};

export const decideCreateLaunchRelease = (
  command: CreateLaunchReleaseCommand,
  context: {
    now: string;
    newReleaseId: string;
    contentHash: string;
    project: Project | undefined;
    environment: LaunchEnvironment | undefined;
    readiness: ProjectReadinessSnapshot;
    verificationPlan: VerificationPlan | undefined;
    measurementPlan: LaunchMeasurementPlan | undefined;
    measurementRun: LaunchMeasurementRun | undefined;
    workflowEvidence: readonly LaunchWorkflowEvidenceInput[];
  },
): { project: Project; release: LaunchRelease; event: LaunchReleaseCreatedIntent } => {
  requireOwner(command.actor);
  const currentProject = requireProject(context.project, command.payload.projectId);
  if (currentProject.version !== command.payload.expectedProjectVersion) {
    throw new LaunchReleaseDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after release evidence was loaded",
      { expectedVersion: command.payload.expectedProjectVersion, actualVersion: currentProject.version },
    );
  }
  const environment = context.environment;
  if (environment?.id !== command.payload.environmentId || environment.projectId !== currentProject.id) {
    throw new LaunchReleaseDomainError("ENVIRONMENT_NOT_FOUND", "The launch Environment does not exist");
  }
  if (
    environment.version !== command.payload.expectedEnvironmentVersion ||
    environment.contentHash !== command.payload.expectedEnvironmentContentHash
  ) {
    throw new LaunchReleaseDomainError(
      "ENVIRONMENT_VERSION_CONFLICT",
      "The launch Environment changed after it was loaded",
    );
  }
  if (context.readiness.run !== null && context.readiness.run.projectId !== currentProject.id) {
    throw new LaunchReleaseDomainError(
      "EVIDENCE_BOUNDARY_INVALID",
      "Project readiness evidence belongs to another Project",
    );
  }
  if (
    [context.verificationPlan, context.measurementPlan, context.measurementRun].some(
      (value) => value !== undefined && value.projectId !== currentProject.id,
    )
  ) {
    throw new LaunchReleaseDomainError(
      "EVIDENCE_BOUNDARY_INVALID",
      "Project launch evidence belongs to another Project",
    );
  }
  const inputByWorkItem = new Map(context.workflowEvidence.map((value) => [value.workItemId, value]));
  if (
    inputByWorkItem.size !== command.payload.workItemIds.length ||
    command.payload.workItemIds.some((id) => !inputByWorkItem.has(id))
  ) {
    throw new LaunchReleaseDomainError(
      "EVIDENCE_BOUNDARY_INVALID",
      "Release workflow evidence does not match the owner-selected WorkItems",
    );
  }
  const selectedWorkItems = command.payload.workItemIds.map((id) => {
    const input = inputByWorkItem.get(id);
    if (input === undefined) {
      throw new LaunchReleaseDomainError(
        "EVIDENCE_BOUNDARY_INVALID",
        "A selected WorkItem has no workflow evidence",
      );
    }
    return requireWorkflowBoundary(currentProject, input);
  });
  const gates = [
    ...readinessGates(context.readiness, {
      sourceTree: command.payload.sourceTree,
      sourceHead: command.payload.sourceHead,
      sourceHeadTree: command.payload.sourceHeadTree,
    }),
    ...measuredGates({
      sourceTree: command.payload.sourceTree,
      plan: context.measurementPlan,
      run: context.measurementRun,
    }),
    ...workflowGates(selectedWorkItems, command.payload.sourceTree, context.verificationPlan),
  ];
  const orderedGates = launchReleaseGateKeySchema.options.map((key) => {
    const found = gates.find((candidate) => candidate.key === key);
    if (found === undefined) {
      throw new LaunchReleaseDomainError(
        "EVIDENCE_BOUNDARY_INVALID",
        "The release gate catalog is incomplete",
      );
    }
    return found;
  });
  const required = orderedGates.filter(({ required }) => required);
  const release: LaunchRelease = {
    schemaVersion: 1,
    id: context.newReleaseId,
    projectId: currentProject.id,
    sourceTree: command.payload.sourceTree,
    source: {
      readinessRunId: context.readiness.run?.id ?? null,
      readinessSourceDigest: context.readiness.run?.sourceDigest ?? null,
      workingTreeDirty: context.readiness.run?.workingTreeDirty ?? null,
      verificationPlanId: context.verificationPlan?.id ?? null,
      verificationPlanRevision: context.verificationPlan?.revision ?? null,
      verificationPlanContentHash: context.verificationPlan?.contentHash ?? null,
      launchMeasurementPlanId: context.measurementPlan?.id ?? null,
      launchMeasurementPlanRevision: context.measurementPlan?.revision ?? null,
      launchMeasurementPlanContentHash: context.measurementPlan?.contentHash ?? null,
      launchMeasurementRunId: context.measurementRun?.id ?? null,
      launchMeasurementRunVersion: context.measurementRun?.version ?? null,
    },
    environment: {
      ...environment,
      requiredEnvironmentVariables: [...environment.requiredEnvironmentVariables],
    },
    selectedWorkItems,
    gates: orderedGates,
    requiredGateCount: required.length,
    passedRequiredGateCount: required.filter(({ status }) => status === "PASSED").length,
    contentHash: context.contentHash,
    createdAt: context.now,
  };
  const project = changedProject(currentProject, context.now);
  return { project, release, event: { type: "LAUNCH_RELEASE_CREATED", data: { release } } };
};

export const launchReleaseFreshness = (
  release: LaunchRelease,
  current: {
    currentTree: string;
    environment: LaunchEnvironment | undefined;
    readiness: ProjectReadinessSnapshot;
    verificationPlan: VerificationPlan | undefined;
    measurementPlan: LaunchMeasurementPlan | undefined;
    measurementRun: LaunchMeasurementRun | undefined;
    acceptancePackages: readonly AcceptancePackage[];
  },
): LaunchReleaseFreshness => {
  const reasons: LaunchReleaseFreshness["reasons"][number][] = [];
  if (current.currentTree !== release.sourceTree) reasons.push("TREE_CHANGED");
  if (
    current.environment?.id !== release.environment.id ||
    current.environment.version !== release.environment.version ||
    current.environment.contentHash !== release.environment.contentHash
  ) {
    reasons.push("ENVIRONMENT_CHANGED");
  }
  if (
    (current.readiness.run?.id ?? null) !== release.source.readinessRunId ||
    (current.readiness.run?.sourceDigest ?? null) !== release.source.readinessSourceDigest ||
    (current.readiness.run?.workingTreeDirty ?? null) !== release.source.workingTreeDirty
  ) {
    reasons.push("READINESS_CHANGED");
  }
  if (
    (current.verificationPlan?.id ?? null) !== release.source.verificationPlanId ||
    (current.verificationPlan?.revision ?? null) !== release.source.verificationPlanRevision ||
    (current.verificationPlan?.contentHash ?? null) !== release.source.verificationPlanContentHash
  ) {
    reasons.push("VERIFICATION_PLAN_CHANGED");
  }
  if (
    (current.measurementPlan?.id ?? null) !== release.source.launchMeasurementPlanId ||
    (current.measurementPlan?.revision ?? null) !== release.source.launchMeasurementPlanRevision ||
    (current.measurementPlan?.contentHash ?? null) !== release.source.launchMeasurementPlanContentHash ||
    (current.measurementRun?.id ?? null) !== release.source.launchMeasurementRunId ||
    (current.measurementRun?.version ?? null) !== release.source.launchMeasurementRunVersion
  ) {
    reasons.push("MEASUREMENT_CHANGED");
  }
  const packages = new Map(current.acceptancePackages.map((value) => [value.workItemId, value]));
  if (
    release.selectedWorkItems.some((item) => {
      const currentPackage = packages.get(item.workItemId);
      if (item.acceptancePackageId === null) return currentPackage !== undefined;
      return (
        currentPackage?.id !== item.acceptancePackageId ||
        currentPackage.version !== item.acceptancePackageVersion ||
        currentPackage.status !== item.acceptanceStatus
      );
    })
  ) {
    reasons.push("ACCEPTANCE_CHANGED");
  }
  return reasons.length === 0 ? { status: "CURRENT", reasons: [] } : { status: "STALE", reasons };
};

export type RenderLaunchEvidencePackageResult =
  { type: "RENDERED"; markdown: string; byteSize: number } | { type: "TOO_LARGE"; reason: string };

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

const redactPaths = (value: string): string =>
  value
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/giu, "[redacted credential URL]")
    .replace(
      /\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|DATABASE_URL)\s*=\s*[^\s]+/gu,
      "[redacted secret]",
    )
    .replace(/\b[A-Za-z]:[\\/][^\r\n<>"'`]+/gu, "[redacted path]")
    .replace(/(^|[\s("'`])\/(?!\/)[^\r\n<>"'`]+/gmu, "$1[redacted path]");

const escapeMarkdownSyntax = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/gu, "\\$1");

const escapeUntrustedMarkdown = (value: string): string => escapeMarkdownSyntax(redactPaths(value));

export const renderLaunchEvidencePackage = (release: LaunchRelease): RenderLaunchEvidencePackageResult => {
  const lines: string[] = [
    "# Loomrail Launch Evidence Package",
    "",
    `- Release: \`${release.id}\``,
    `- Project: \`${release.projectId}\``,
    `- Snapshot tree: \`${release.sourceTree}\``,
    `- Created: \`${release.createdAt}\``,
    `- Required gates passed: ${release.passedRequiredGateCount.toString()} of ${release.requiredGateCount.toString()}`,
    "",
    "## Environment declaration",
    "",
    `- Name: ${escapeUntrustedMarkdown(release.environment.name)}`,
    `- Kind: \`${release.environment.kind}\``,
    `- Preset: \`${release.environment.presetId}\` revision ${release.environment.presetRevision.toString()}`,
    `- Public origin: ${escapeMarkdownSyntax(release.environment.publicBaseUrl)}`,
    `- Health path: \`${escapeMarkdownSyntax(release.environment.healthPath)}\``,
    `- Required variable names: ${release.environment.requiredEnvironmentVariables.length.toString()}`,
    "",
    "## Gate snapshots",
  ];
  for (const item of release.gates) {
    lines.push(
      "",
      `### ${escapeMarkdownSyntax(item.key)}`,
      "",
      `- Status: \`${item.status}\``,
      `- Required: \`${item.required ? "YES" : "NO"}\``,
      `- Waivable by a future deploy flow: \`${item.waivable ? "YES" : "NO"}\``,
      `- Evidence references: ${item.evidenceRefs.length.toString()}`,
      "",
      escapeUntrustedMarkdown(item.summary),
      ...item.evidenceRefs.map(
        (reference) =>
          `- \`${reference.kind}\` \`${reference.id}\`${reference.testedTree === null ? "" : ` on \`${reference.testedTree}\``}`,
      ),
    );
  }
  lines.push(
    "",
    "## Selected workflow scope",
    "",
    ...(release.selectedWorkItems.length === 0
      ? ["No WorkItems were selected; workflow gates remain action-required."]
      : release.selectedWorkItems.map(
          (item) =>
            `- WorkItem \`${item.workItemId}\` · AcceptancePackage \`${item.acceptancePackageId ?? "missing"}\` · tree \`${item.testedTree ?? "missing"}\``,
        )),
    "",
    "## Limitations",
    "",
    "- This package is a historical evidence snapshot, not a production-safety verdict or deploy approval.",
    "- Loomrail did not contact the declared public origin, inspect hosting credentials or execute a deploy.",
    "- Missing, failed and stale gates remain explicit and are never converted into success.",
    "",
  );
  const markdown = lines.join("\n");
  const byteSize = utf8ByteLength(markdown);
  if (byteSize > MAX_LAUNCH_EVIDENCE_PACKAGE_BYTES) {
    return { type: "TOO_LARGE", reason: "The complete Launch Evidence Package exceeds its byte limit" };
  }
  return { type: "RENDERED", markdown, byteSize };
};
