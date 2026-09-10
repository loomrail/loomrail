import type {
  Actor,
  AdoptLaunchMeasurementPlanCommand,
  CancelLaunchMeasurementRunCommand,
  CompleteLaunchMeasurementRunCommand,
  DisableLaunchMeasurementPlanCommand,
  InterruptLaunchMeasurementRunCommand,
  LaunchBrowserMeasurement,
  LaunchDependencyAuditEvidence,
  LaunchMeasurementFreshness,
  LaunchMeasurementGateResult,
  LaunchMeasurementPlan,
  LaunchMeasurementRun,
  Project,
  StartLaunchMeasurementRunCommand,
  VerificationPlan,
} from "@loomrail/contracts";

export type LaunchMeasurementDomainErrorCode =
  | "OWNER_REQUIRED"
  | "SYSTEM_REQUIRED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_ACTIVE"
  | "PROJECT_VERSION_CONFLICT"
  | "PLAN_NOT_FOUND"
  | "PLAN_NOT_ACTIVE"
  | "PLAN_VERSION_CONFLICT"
  | "PLAN_PROJECT_MISMATCH"
  | "VERIFICATION_PLAN_UNAVAILABLE"
  | "VERIFICATION_PLAN_MISMATCH"
  | "STARTUP_RECIPE_INVALID"
  | "AUDIT_RECIPE_INVALID"
  | "ACTIVE_RUN_EXISTS"
  | "RUN_NOT_FOUND"
  | "RUN_NOT_ACTIVE"
  | "RUN_VERSION_CONFLICT"
  | "RUN_PLAN_MISMATCH"
  | "TREE_MUTATED"
  | "EVIDENCE_INVALID";

export class LaunchMeasurementDomainError extends Error {
  readonly code: LaunchMeasurementDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: LaunchMeasurementDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "LaunchMeasurementDomainError";
    this.code = code;
    this.details = details;
  }
}

export type LaunchMeasurementPlanChangedIntent = {
  type: "LAUNCH_MEASUREMENT_PLAN_CHANGED";
  data: { plan: LaunchMeasurementPlan };
};

export type LaunchMeasurementRunChangedIntent = {
  type: "LAUNCH_MEASUREMENT_RUN_CHANGED";
  data: { run: LaunchMeasurementRun };
};

const requireOwner = (actor: Actor): void => {
  if (actor.type !== "HUMAN") {
    throw new LaunchMeasurementDomainError(
      "OWNER_REQUIRED",
      "Only the owner can configure or control launch measurement",
    );
  }
};

const requireSystem = (actor: Actor): void => {
  if (actor.type !== "SYSTEM") {
    throw new LaunchMeasurementDomainError(
      "SYSTEM_REQUIRED",
      "Only the launch measurement runner can record measured evidence",
    );
  }
};

const requireProject = (project: Project | undefined, projectId: string): Project => {
  if (project?.id !== projectId) {
    throw new LaunchMeasurementDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (project.status !== "ACTIVE") {
    throw new LaunchMeasurementDomainError(
      "PROJECT_NOT_ACTIVE",
      "Launch measurement needs an active Project",
    );
  }
  return project;
};

const requireVerificationRecipes = (
  configuration: LaunchMeasurementPlan["configuration"],
  verificationPlan: VerificationPlan | undefined,
): void => {
  if (verificationPlan?.status !== "ACTIVE") {
    throw new LaunchMeasurementDomainError(
      "VERIFICATION_PLAN_UNAVAILABLE",
      "Launch measurement needs an active owner-approved verification Plan",
    );
  }
  if (
    verificationPlan.id !== configuration.verificationPlanId ||
    verificationPlan.revision !== configuration.verificationPlanRevision ||
    verificationPlan.contentHash !== configuration.verificationPlanContentHash
  ) {
    throw new LaunchMeasurementDomainError(
      "VERIFICATION_PLAN_MISMATCH",
      "The selected verification Plan changed after launch measurement was configured",
    );
  }
  const startup = verificationPlan.recipes.find(({ id }) => id === configuration.startupRecipeId);
  if (startup?.kind !== "SERVE" || startup.required) {
    throw new LaunchMeasurementDomainError(
      "STARTUP_RECIPE_INVALID",
      "The startup recipe must be an optional SERVE recipe in the selected verification Plan",
    );
  }
  if (configuration.dependencyAuditRecipeId !== null) {
    const audit = verificationPlan.recipes.find(({ id }) => id === configuration.dependencyAuditRecipeId);
    if (audit?.kind !== "AUDIT") {
      throw new LaunchMeasurementDomainError(
        "AUDIT_RECIPE_INVALID",
        "The dependency audit recipe must be an AUDIT recipe in the selected verification Plan",
      );
    }
  }
};

export const decideLaunchMeasurementPlanAdoption = (
  command: AdoptLaunchMeasurementPlanCommand,
  context: {
    now: string;
    newPlanId: string;
    contentHash: string;
    project: Project | undefined;
    currentPlan: LaunchMeasurementPlan | undefined;
    verificationPlan: VerificationPlan | undefined;
  },
): {
  project: Project;
  plan: LaunchMeasurementPlan;
  event: LaunchMeasurementPlanChangedIntent;
} => {
  requireOwner(command.actor);
  const currentProject = requireProject(context.project, command.payload.projectId);
  if (currentProject.version !== command.payload.expectedProjectVersion) {
    throw new LaunchMeasurementDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after launch measurement settings were loaded",
      {
        expectedVersion: command.payload.expectedProjectVersion,
        actualVersion: currentProject.version,
      },
    );
  }
  if (context.currentPlan !== undefined && context.currentPlan.projectId !== currentProject.id) {
    throw new LaunchMeasurementDomainError(
      "PLAN_PROJECT_MISMATCH",
      "The current launch measurement Plan belongs to a different Project",
    );
  }
  requireVerificationRecipes(command.payload.configuration, context.verificationPlan);
  const plan: LaunchMeasurementPlan = {
    schemaVersion: 1,
    id: context.newPlanId,
    projectId: currentProject.id,
    revision: (context.currentPlan?.revision ?? 0) + 1,
    status: "ACTIVE",
    configuration: command.payload.configuration,
    contentHash: context.contentHash,
    createdAt: context.now,
  };
  const project: Project = {
    ...currentProject,
    version: currentProject.version + 1,
    updatedAt: context.now,
  };
  return { project, plan, event: { type: "LAUNCH_MEASUREMENT_PLAN_CHANGED", data: { plan } } };
};

export const decideLaunchMeasurementPlanDisable = (
  command: DisableLaunchMeasurementPlanCommand,
  context: {
    now: string;
    newPlanId: string;
    contentHash: string;
    project: Project | undefined;
    currentPlan: LaunchMeasurementPlan | undefined;
  },
): {
  project: Project;
  plan: LaunchMeasurementPlan;
  event: LaunchMeasurementPlanChangedIntent;
} => {
  requireOwner(command.actor);
  const currentProject = requireProject(context.project, command.payload.projectId);
  if (currentProject.version !== command.payload.expectedProjectVersion) {
    throw new LaunchMeasurementDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after launch measurement settings were loaded",
    );
  }
  const currentPlan = context.currentPlan;
  if (currentPlan?.projectId !== currentProject.id) {
    throw new LaunchMeasurementDomainError("PLAN_NOT_FOUND", "The launch measurement Plan does not exist");
  }
  if (currentPlan.status !== "ACTIVE") {
    throw new LaunchMeasurementDomainError(
      "PLAN_NOT_ACTIVE",
      "Only an active launch measurement Plan can be disabled",
    );
  }
  if (
    currentPlan.revision !== command.payload.expectedPlanRevision ||
    currentPlan.contentHash !== command.payload.expectedPlanContentHash
  ) {
    throw new LaunchMeasurementDomainError(
      "PLAN_VERSION_CONFLICT",
      "The launch measurement Plan changed after it was loaded",
    );
  }
  const plan: LaunchMeasurementPlan = {
    ...currentPlan,
    id: context.newPlanId,
    revision: currentPlan.revision + 1,
    status: "DISABLED",
    contentHash: context.contentHash,
    createdAt: context.now,
  };
  const project: Project = {
    ...currentProject,
    version: currentProject.version + 1,
    updatedAt: context.now,
  };
  return { project, plan, event: { type: "LAUNCH_MEASUREMENT_PLAN_CHANGED", data: { plan } } };
};

export const decideLaunchMeasurementRunReservation = (
  command: StartLaunchMeasurementRunCommand,
  context: {
    now: string;
    newRunId: string;
    project: Project | undefined;
    plan: LaunchMeasurementPlan | undefined;
    verificationPlan: VerificationPlan | undefined;
    activeRun: LaunchMeasurementRun | undefined;
  },
): { run: LaunchMeasurementRun; event: LaunchMeasurementRunChangedIntent } => {
  requireOwner(command.actor);
  const project = requireProject(context.project, command.payload.projectId);
  const plan = context.plan;
  if (plan?.projectId !== project.id || plan.status !== "ACTIVE") {
    throw new LaunchMeasurementDomainError(
      "PLAN_NOT_ACTIVE",
      "Launch measurement needs the active owner-approved Plan",
    );
  }
  if (
    plan.revision !== command.payload.expectedPlanRevision ||
    plan.contentHash !== command.payload.expectedPlanContentHash
  ) {
    throw new LaunchMeasurementDomainError(
      "PLAN_VERSION_CONFLICT",
      "The launch measurement Plan changed after it was loaded",
    );
  }
  requireVerificationRecipes(plan.configuration, context.verificationPlan);
  if (
    context.activeRun !== undefined &&
    (context.activeRun.status === "RUNNING" ||
      context.activeRun.status === "CANCELLING" ||
      context.activeRun.status === "BLOCKED")
  ) {
    throw new LaunchMeasurementDomainError(
      "ACTIVE_RUN_EXISTS",
      "This Project already has an active launch measurement Run",
    );
  }
  const run: LaunchMeasurementRun = {
    schemaVersion: 1,
    id: context.newRunId,
    projectId: project.id,
    planId: plan.id,
    planRevision: plan.revision,
    planContentHash: plan.contentHash,
    verificationPlanId: plan.configuration.verificationPlanId,
    verificationPlanRevision: plan.configuration.verificationPlanRevision,
    verificationPlanContentHash: plan.configuration.verificationPlanContentHash,
    testedTree: command.payload.testedTree,
    status: "RUNNING",
    results: [],
    errorCode: null,
    startedAt: context.now,
    completedAt: null,
    version: 1,
  };
  return { run, event: { type: "LAUNCH_MEASUREMENT_RUN_CHANGED", data: { run } } };
};

const requireActiveRun = (
  run: LaunchMeasurementRun | undefined,
  expectedVersion: number,
): LaunchMeasurementRun => {
  if (run === undefined) {
    throw new LaunchMeasurementDomainError("RUN_NOT_FOUND", "The launch measurement Run does not exist");
  }
  if (run.version !== expectedVersion) {
    throw new LaunchMeasurementDomainError(
      "RUN_VERSION_CONFLICT",
      "The launch measurement Run changed after it was loaded",
      { expectedVersion, actualVersion: run.version },
    );
  }
  if (run.status !== "RUNNING" && run.status !== "CANCELLING" && run.status !== "BLOCKED") {
    throw new LaunchMeasurementDomainError(
      "RUN_NOT_ACTIVE",
      "Only an active launch measurement Run can change",
    );
  }
  return run;
};

export const decideLaunchMeasurementRunCancellation = (
  command: CancelLaunchMeasurementRunCommand,
  context: { run: LaunchMeasurementRun | undefined },
): { run: LaunchMeasurementRun; event: LaunchMeasurementRunChangedIntent } => {
  requireOwner(command.actor);
  const current = requireActiveRun(context.run, command.payload.expectedVersion);
  if (current.status === "CANCELLING") {
    throw new LaunchMeasurementDomainError(
      "RUN_NOT_ACTIVE",
      "The launch measurement Run is already cancelling",
    );
  }
  const run: LaunchMeasurementRun = {
    ...current,
    status: "CANCELLING",
    errorCode: null,
    version: current.version + 1,
  };
  return { run, event: { type: "LAUNCH_MEASUREMENT_RUN_CHANGED", data: { run } } };
};

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

const assertMeasurementShape = (plan: LaunchMeasurementPlan, measurement: LaunchBrowserMeasurement): void => {
  const configuration = plan.configuration;
  const observedHeaders = new Set(measurement.headers.map(({ name }) => name));
  const observedRoutes = new Set(measurement.privateRoutes.map(({ path }) => path));
  if (
    measurement.samples.length !== configuration.samples ||
    configuration.requiredHeaders.some((header) => !observedHeaders.has(header)) ||
    observedHeaders.size !== configuration.requiredHeaders.length ||
    configuration.privateRoutes.some((path) => !observedRoutes.has(path)) ||
    observedRoutes.size !== configuration.privateRoutes.length
  ) {
    throw new LaunchMeasurementDomainError(
      "EVIDENCE_INVALID",
      "Measured evidence does not match the approved launch measurement Plan",
    );
  }
};

const evaluateGates = (
  plan: LaunchMeasurementPlan,
  measurement: LaunchBrowserMeasurement,
  audit: LaunchDependencyAuditEvidence | null,
  testedTree: string,
): LaunchMeasurementGateResult[] => {
  assertMeasurementShape(plan, measurement);
  const { thresholds } = plan.configuration;
  const lcpSamples = measurement.samples.flatMap(({ lcpMs }) => (lcpMs === null ? [] : [lcpMs]));
  const inpSamples = measurement.samples.flatMap(({ inpMs }) => (inpMs === null ? [] : [inpMs]));
  const clsSamples = measurement.samples.flatMap(({ cls }) => (cls === null ? [] : [cls]));
  const medianLcpMs = median(lcpSamples);
  const medianInpMs = median(inpSamples);
  const medianCls = median(clsSamples);
  const vitalsComplete =
    lcpSamples.length === measurement.samples.length &&
    inpSamples.length === measurement.samples.length &&
    clsSamples.length === measurement.samples.length;
  const vitalsPass =
    vitalsComplete &&
    medianLcpMs !== null &&
    medianLcpMs <= thresholds.lcpMs &&
    medianInpMs !== null &&
    medianInpMs <= thresholds.inpMs &&
    medianCls !== null &&
    medianCls <= thresholds.cls;
  const webVitals: LaunchMeasurementGateResult = {
    key: "PERF_WEB_VITALS",
    status: vitalsComplete ? (vitalsPass ? "PASSED" : "FAILED") : "ACTION_REQUIRED",
    summary: vitalsComplete
      ? vitalsPass
        ? "Measured web vitals are within the approved thresholds."
        : "One or more measured web vitals exceed the approved thresholds."
      : "The browser could not observe every required web vital sample.",
    evidence: {
      lcpSamplesMs: lcpSamples,
      inpSamplesMs: inpSamples,
      clsSamples,
      medianLcpMs,
      medianInpMs,
      medianCls,
      thresholds: { lcpMs: thresholds.lcpMs, inpMs: thresholds.inpMs, cls: thresholds.cls },
    },
  };

  const scriptByteSamples = measurement.samples.map(({ scriptBytes }) => scriptBytes);
  const medianScriptBytes = median(scriptByteSamples) ?? 0;
  const bundle: LaunchMeasurementGateResult = {
    key: "PERF_BUNDLE_BUDGET",
    status: medianScriptBytes <= thresholds.scriptBytes ? "PASSED" : "FAILED",
    summary:
      medianScriptBytes <= thresholds.scriptBytes
        ? "Measured script bytes are within the approved budget."
        : "Measured script bytes exceed the approved budget.",
    evidence: { scriptByteSamples, medianScriptBytes, budgetBytes: thresholds.scriptBytes },
  };

  const headersPass = measurement.headers.every(({ present }) => present);
  const headers: LaunchMeasurementGateResult = {
    key: "SEC_RESPONSE_HEADERS",
    status: headersPass ? "PASSED" : "FAILED",
    summary: headersPass
      ? "Every approved response header was present."
      : "One or more approved response headers were absent.",
    evidence: measurement.headers,
  };

  const routesConfigured = plan.configuration.privateRoutes.length > 0;
  const routesPass =
    routesConfigured &&
    measurement.privateRoutes.every(({ statusCode }) => statusCode === 401 || statusCode === 403);
  const routes: LaunchMeasurementGateResult = {
    key: "SEC_UNAUTHENTICATED_ROUTES",
    status: routesConfigured ? (routesPass ? "PASSED" : "FAILED") : "ACTION_REQUIRED",
    summary: routesConfigured
      ? routesPass
        ? "Every approved private route rejected an unauthenticated request."
        : "At least one approved private route accepted or redirected an unauthenticated request."
      : "No private route is configured for unauthenticated-access measurement.",
    evidence: measurement.privateRoutes,
  };

  const secretsPass = measurement.secrets.every(({ count }) => count === 0);
  const secrets: LaunchMeasurementGateResult = {
    key: "SEC_CLIENT_BUNDLE_SECRETS",
    status: secretsPass ? "PASSED" : "FAILED",
    summary: secretsPass
      ? "No configured secret pattern was found in bounded client scripts."
      : "A secret-like value was found in a bounded client script scan.",
    evidence: { scannedScriptBytes: measurement.scannedScriptBytes, findings: measurement.secrets },
  };

  const auditConfigured = plan.configuration.dependencyAuditRecipeId !== null;
  const auditMatches =
    auditConfigured &&
    audit !== null &&
    audit.recipeId === plan.configuration.dependencyAuditRecipeId &&
    audit.testedTree === testedTree;
  const auditPass = auditMatches && audit.status === "PASSED";
  const dependencies: LaunchMeasurementGateResult = {
    key: "DEPS_AUDIT",
    status:
      !auditConfigured || audit === null || !auditMatches
        ? "ACTION_REQUIRED"
        : auditPass
          ? "PASSED"
          : audit.status === "FAILED"
            ? "FAILED"
            : "ERROR",
    summary: !auditConfigured
      ? "No owner-approved dependency audit recipe is configured."
      : audit === null || !auditMatches
        ? "No current dependency audit evidence matches this tree and recipe."
        : auditPass
          ? "Current dependency audit evidence passed."
          : "Current dependency audit evidence did not pass.",
    evidence: auditMatches ? audit : null,
  };

  return [webVitals, bundle, headers, routes, secrets, dependencies];
};

export const decideLaunchMeasurementRunCompletion = (
  command: CompleteLaunchMeasurementRunCommand,
  context: { now: string; run: LaunchMeasurementRun | undefined; plan: LaunchMeasurementPlan | undefined },
): { run: LaunchMeasurementRun; event: LaunchMeasurementRunChangedIntent } => {
  requireSystem(command.actor);
  const current = requireActiveRun(context.run, command.payload.expectedVersion);
  const plan = context.plan;
  if (
    plan?.id !== current.planId ||
    plan.revision !== current.planRevision ||
    plan.contentHash !== current.planContentHash
  ) {
    throw new LaunchMeasurementDomainError(
      "RUN_PLAN_MISMATCH",
      "The launch measurement Run no longer matches its Plan",
    );
  }
  if (command.payload.currentTree !== current.testedTree) {
    throw new LaunchMeasurementDomainError(
      "TREE_MUTATED",
      "The repository tree changed during launch measurement",
    );
  }
  const results = evaluateGates(
    plan,
    command.payload.browserMeasurement,
    command.payload.dependencyAudit,
    current.testedTree,
  );
  const run: LaunchMeasurementRun = {
    ...current,
    status: results.every(({ status }) => status === "PASSED") ? "PASSED" : "FAILED",
    results,
    errorCode: null,
    completedAt: context.now,
    version: current.version + 1,
  };
  return { run, event: { type: "LAUNCH_MEASUREMENT_RUN_CHANGED", data: { run } } };
};

export const decideLaunchMeasurementRunInterruption = (
  command: InterruptLaunchMeasurementRunCommand,
  context: { now: string; run: LaunchMeasurementRun | undefined },
): { run: LaunchMeasurementRun; event: LaunchMeasurementRunChangedIntent } => {
  requireSystem(command.actor);
  const current = requireActiveRun(context.run, command.payload.expectedVersion);
  if (!command.payload.processStopped) {
    const run: LaunchMeasurementRun = {
      ...current,
      status: "BLOCKED",
      results: [],
      errorCode: "SERVICE_TERMINATION_FAILED",
      completedAt: null,
      version: current.version + 1,
    };
    return { run, event: { type: "LAUNCH_MEASUREMENT_RUN_CHANGED", data: { run } } };
  }
  const run: LaunchMeasurementRun = {
    ...current,
    status: command.payload.errorCode === "OWNER_CANCELLED" ? "INTERRUPTED" : "ERROR",
    results: [],
    errorCode: command.payload.errorCode,
    completedAt: context.now,
    version: current.version + 1,
  };
  return { run, event: { type: "LAUNCH_MEASUREMENT_RUN_CHANGED", data: { run } } };
};

export const launchMeasurementFreshness = (input: {
  run: LaunchMeasurementRun;
  currentTree: string;
  currentPlan: LaunchMeasurementPlan | undefined;
  currentVerificationPlan: VerificationPlan | undefined;
}): LaunchMeasurementFreshness => {
  const reasons: LaunchMeasurementFreshness["reasons"] = [];
  if (input.currentTree !== input.run.testedTree) reasons.push("TREE_CHANGED");
  if (
    input.currentPlan?.status !== "ACTIVE" ||
    input.currentPlan.id !== input.run.planId ||
    input.currentPlan.revision !== input.run.planRevision ||
    input.currentPlan.contentHash !== input.run.planContentHash
  ) {
    reasons.push("PLAN_CHANGED");
  }
  if (
    input.currentVerificationPlan?.status !== "ACTIVE" ||
    input.currentVerificationPlan.id !== input.run.verificationPlanId ||
    input.currentVerificationPlan.revision !== input.run.verificationPlanRevision ||
    input.currentVerificationPlan.contentHash !== input.run.verificationPlanContentHash
  ) {
    reasons.push("VERIFICATION_PLAN_CHANGED");
  }
  return { status: reasons.length === 0 ? "CURRENT" : "STALE", reasons };
};
