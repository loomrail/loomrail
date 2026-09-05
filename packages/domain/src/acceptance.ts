import type {
  AcceptanceCriterionClaim,
  AcceptanceCriterionEvidence,
  AcceptancePackage,
  Decision,
  DomainEvent,
  EvidenceArtifact,
  QAAttachmentSummary,
  QAEvidenceBundle,
  VerificationEvidence,
  WorkItem,
} from "@loomrail/contracts";

export type BindAcceptanceCriteriaInput = {
  acceptanceCriteria: readonly string[];
  claims: readonly AcceptanceCriterionClaim[];
  reviewArtifact: EvidenceArtifact;
  qaArtifact: EvidenceArtifact;
  verificationEvidence?: VerificationEvidence | undefined;
};

export type BindAcceptanceCriteriaResult =
  { type: "BOUND"; criteria: readonly AcceptanceCriterionEvidence[] } | { type: "INVALID"; reason: string };

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

// Code-unit order, never `localeCompare`: the release summary is an audit artifact and its order
// must be the same on every machine that renders it.
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Turns a provider's criterion claims into authority-bound package rows.
 *
 * The provider is allowed to explain implementation and select checks, but never to name an
 * artifact or a tree. Those identities arrive separately from durable current state and are
 * attached only after the proposed mapping proves total and exact.
 */
export const bindAcceptanceCriteria = (input: BindAcceptanceCriteriaInput): BindAcceptanceCriteriaResult => {
  if (input.acceptanceCriteria.length === 0) {
    return { type: "INVALID", reason: "Owner acceptance requires at least one acceptance criterion" };
  }
  if (!unique(input.acceptanceCriteria)) {
    return { type: "INVALID", reason: "Owner acceptance criteria must be unique" };
  }
  if (input.claims.length !== input.acceptanceCriteria.length) {
    return {
      type: "INVALID",
      reason: "Acceptance criterion claims must cover every criterion exactly once",
    };
  }
  if (!unique(input.claims.map(({ criterion }) => criterion))) {
    return { type: "INVALID", reason: "Acceptance criterion claims must not repeat a criterion" };
  }

  const criteria: AcceptanceCriterionEvidence[] = [];
  for (const [index, criterion] of input.acceptanceCriteria.entries()) {
    const claim = input.claims[index];
    if (claim?.criterion !== criterion) {
      return {
        type: "INVALID",
        reason: "Acceptance criterion claims must preserve the recorded criterion order and text",
      };
    }
    if (!input.reviewArtifact.checks.includes(claim.reviewCheck)) {
      return {
        type: "INVALID",
        reason: "An acceptance criterion references a check absent from the current Review evidence",
      };
    }
    if (!input.qaArtifact.checks.includes(claim.qaCheck)) {
      return {
        type: "INVALID",
        reason: "An acceptance criterion references a check absent from the current measured QA evidence",
      };
    }
    criteria.push({
      criterion,
      implementation: claim.implementation,
      reviewArtifactId: input.reviewArtifact.id,
      qaArtifactId: input.qaArtifact.id,
      reviewCheck: claim.reviewCheck,
      qaCheck: claim.qaCheck,
      ...(input.verificationEvidence === undefined
        ? {}
        : { verificationCheckIds: [...input.verificationEvidence.requiredCheckIds] }),
      verification: claim.ownerVerification,
      knownRisk: claim.knownRisk,
    });
  }
  return { type: "BOUND", criteria };
};

export const MAX_RELEASE_SUMMARY_AUDIT_EVENTS = 1_000;
export const MAX_RELEASE_SUMMARY_BYTES = 512 * 1_024;

export type RenderReleaseSummaryInput = {
  workItem: WorkItem;
  acceptancePackage: AcceptancePackage;
  artifacts: readonly EvidenceArtifact[];
  qaEvidence: readonly QAEvidenceBundle[];
  qaAttachments: readonly QAAttachmentSummary[];
  decisions: readonly Decision[];
  events: readonly DomainEvent[];
  auditComplete: boolean;
};

export type RenderReleaseSummaryResult =
  | { type: "RENDERED"; markdown: string; byteSize: number }
  | { type: "INVALID"; reason: string }
  | { type: "AUDIT_INCOMPLETE"; reason: string }
  | { type: "TOO_LARGE"; reason: string };

const redactPaths = (value: string): string =>
  value
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'`]+/gu, "[redacted path]")
    .replace(/(^|[\s("'`])\/(?!\/)[^\s<>"'`]+/gmu, "$1[redacted path]");

const escapeMarkdown = (value: string): string =>
  redactPaths(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/gu, "\\$1");

const inline = (value: string): string => escapeMarkdown(value.replace(/\s+/gu, " ").trim());

const quoted = (value: string): readonly string[] =>
  value.split(/\r?\n/u).map((line) => `> ${escapeMarkdown(line)}`);

const answerSummary = (decision: Decision): string =>
  decision.answer.type === "OPTION" ? decision.answer.optionIds.join(", ") : decision.answer.text;

const invalid = (reason: string): RenderReleaseSummaryResult => ({ type: "INVALID", reason });

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

/**
 * Renders one acceptance read model without granting the export any workflow or filesystem
 * authority. All mutable facts are inputs; the same validated snapshot always produces the same
 * bytes on every platform.
 */
export const renderReleaseSummary = (input: RenderReleaseSummaryInput): RenderReleaseSummaryResult => {
  const { acceptancePackage: packageValue, workItem } = input;
  if (packageValue.workItemId !== workItem.id || packageValue.projectId !== workItem.projectId) {
    return invalid("The AcceptancePackage does not belong to the requested WorkItem");
  }
  if (!input.auditComplete || input.events.length > MAX_RELEASE_SUMMARY_AUDIT_EVENTS) {
    return {
      type: "AUDIT_INCOMPLETE",
      reason: "The complete WorkItem audit trail does not fit the bounded release summary",
    };
  }

  const bindingStates = new Set(
    packageValue.criteria.map(({ reviewCheck, qaCheck }) =>
      reviewCheck !== undefined && qaCheck !== undefined ? "BOUND" : "LEGACY_UNBOUND",
    ),
  );
  if (bindingStates.size > 1) {
    return invalid("An AcceptancePackage cannot mix bound and legacy criterion rows");
  }
  if (bindingStates.has("BOUND")) {
    if (
      packageValue.criteria.length === 0 ||
      packageValue.criteria.length !== workItem.acceptanceCriteria.length ||
      packageValue.criteria.some(({ criterion }, index) => criterion !== workItem.acceptanceCriteria[index])
    ) {
      return invalid("Bound criterion evidence must exactly cover the recorded acceptance criteria");
    }
  }

  const verificationEvidence = packageValue.verificationEvidence;
  if (
    verificationEvidence !== undefined &&
    verificationEvidence !== null &&
    (verificationEvidence.projectId !== workItem.projectId ||
      verificationEvidence.workItemId !== workItem.id ||
      verificationEvidence.pipelineRunId !== packageValue.pipelineRunId)
  ) {
    return invalid("Project verification evidence crosses an AcceptancePackage boundary");
  }
  const requiredVerificationCheckIds = new Set(verificationEvidence?.requiredCheckIds ?? []);
  if (verificationEvidence === undefined || verificationEvidence === null) {
    if (packageValue.criteria.some(({ verificationCheckIds }) => verificationCheckIds !== undefined)) {
      return invalid("Criterion Project checks have no package Verification evidence");
    }
  } else if (
    packageValue.criteria.some(({ verificationCheckIds }) => {
      if (verificationCheckIds?.length !== requiredVerificationCheckIds.size) {
        return true;
      }
      return (
        new Set(verificationCheckIds).size !== verificationCheckIds.length ||
        verificationCheckIds.some((checkId) => !requiredVerificationCheckIds.has(checkId))
      );
    })
  ) {
    return invalid("Every criterion must bind the complete required Project verification set");
  }

  const artifactsById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const packageArtifactIds = new Set(packageValue.artifactIds);
  if (
    packageArtifactIds.size !== packageValue.artifactIds.length ||
    packageValue.artifactIds.some((id) => !artifactsById.has(id))
  ) {
    return invalid("The AcceptancePackage references missing or duplicate evidence artifacts");
  }
  if (
    packageValue.artifactIds.some((id) => {
      const artifactValue = artifactsById.get(id);
      return (
        artifactValue?.projectId !== workItem.projectId ||
        artifactValue.workItemId !== workItem.id ||
        artifactValue.pipelineRunId !== packageValue.pipelineRunId
      );
    })
  ) {
    return invalid("Acceptance evidence crosses a WorkItem, Project, or PipelineRun boundary");
  }

  for (const criterion of packageValue.criteria) {
    const review = artifactsById.get(criterion.reviewArtifactId);
    const qa = artifactsById.get(criterion.qaArtifactId);
    if (
      !packageArtifactIds.has(criterion.reviewArtifactId) ||
      !packageArtifactIds.has(criterion.qaArtifactId) ||
      review?.kind !== "REVIEW_REPORT" ||
      qa?.kind !== "QA_REPORT"
    ) {
      return invalid("Criterion evidence does not resolve to the package Review and QA artifacts");
    }
    if (
      criterion.reviewCheck !== undefined &&
      (!review.checks.includes(criterion.reviewCheck) || !qa.checks.includes(criterion.qaCheck ?? ""))
    ) {
      return invalid("Criterion evidence selects a check absent from its referenced artifact");
    }
    if (
      verificationEvidence !== undefined &&
      verificationEvidence !== null &&
      (review.testedTree !== verificationEvidence.implementationTree ||
        qa.testedTree !== verificationEvidence.implementationTree)
    ) {
      return invalid("Project verification, Review, and QA evidence must name one implementation tree");
    }
  }

  const relevantQARunIds = new Set(
    packageValue.artifactIds.flatMap((id) => {
      const qaRunId = artifactsById.get(id)?.qaRunId;
      return qaRunId === undefined ? [] : [qaRunId];
    }),
  );
  const qaEvidence = input.qaEvidence
    .filter(({ qaRunId }) => relevantQARunIds.has(qaRunId))
    .sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id));
  if (
    qaEvidence.some(
      (evidence) =>
        evidence.projectId !== workItem.projectId ||
        evidence.workItemId !== workItem.id ||
        evidence.pipelineRunId !== packageValue.pipelineRunId,
    )
  ) {
    return invalid("Measured QA evidence crosses a WorkItem, Project, or PipelineRun boundary");
  }
  for (const artifactId of packageValue.artifactIds) {
    const artifactValue = artifactsById.get(artifactId);
    if (artifactValue?.qaEvidenceBundleId === undefined) continue;
    const evidence = qaEvidence.find(({ id }) => id === artifactValue.qaEvidenceBundleId);
    if (
      !evidence ||
      evidence.qaRunId !== artifactValue.qaRunId ||
      evidence.workItemId !== workItem.id ||
      evidence.projectId !== workItem.projectId ||
      evidence.pipelineRunId !== packageValue.pipelineRunId
    ) {
      return invalid("Measured QA evidence does not match its referenced QA artifact");
    }
  }

  const relevantAttachmentIds = new Set(qaEvidence.flatMap(({ attachmentIds }) => attachmentIds));
  const attachments = input.qaAttachments
    .filter(({ id }) => relevantAttachmentIds.has(id))
    .sort((left, right) => compareText(left.capturedAt, right.capturedAt) || compareText(left.id, right.id));
  const attachmentIds = new Set(attachments.map(({ id }) => id));
  if (qaEvidence.some((evidence) => evidence.attachmentIds.some((id) => !attachmentIds.has(id)))) {
    return invalid("Measured QA evidence references unavailable attachment metadata");
  }

  if (
    input.decisions.some(
      ({ projectId, workItemId }) => projectId !== workItem.projectId || workItemId !== workItem.id,
    ) ||
    input.events.some(
      ({ projectId, aggregateId, aggregateType }) =>
        projectId !== workItem.projectId || aggregateId !== workItem.id || aggregateType !== "WORK_ITEM",
    )
  ) {
    return invalid("The release summary input crosses a WorkItem or Project boundary");
  }
  const decisions = [...input.decisions].sort(
    (left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id),
  );
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  if (new Set(events.map(({ sequence }) => sequence)).size !== events.length) {
    return invalid("The release summary audit trail repeats an Event sequence");
  }

  const lines: string[] = [
    "# Loomrail Release Summary",
    "",
    "## Delivery",
    "",
    `- WorkItem: \`${workItem.id}\``,
    `- Title: ${inline(workItem.title)}`,
    `- Project: \`${workItem.projectId}\``,
    `- PipelineRun: \`${packageValue.pipelineRunId}\``,
    `- AcceptancePackage: \`${packageValue.id}\` (v${packageValue.version.toString()})`,
    `- Status: \`${packageValue.status}\``,
    `- Created: \`${packageValue.createdAt}\``,
    "",
    "## Release note",
    "",
    ...quoted(packageValue.releaseNote),
    ...(verificationEvidence === undefined || verificationEvidence === null
      ? []
      : [
          "",
          "## Project verification",
          "",
          `- Project verification Run: \`${verificationEvidence.verificationRunId}\``,
          `- Plan: \`${verificationEvidence.planId}\` revision ${verificationEvidence.planRevision.toString()}`,
          `- Tested tree: \`${verificationEvidence.implementationTree}\``,
          `- Platform: \`${verificationEvidence.platform}\``,
          `- Required checks passed: ${verificationEvidence.requiredCheckIds.length.toString()}`,
          `- Optional checks not passed: ${verificationEvidence.optionalFailedCheckIds.length.toString()}`,
          `- Completed: \`${verificationEvidence.completedAt}\``,
        ]),
    "",
    "## Criterion matrix",
  ];

  packageValue.criteria.forEach((criterion, index) => {
    const bound = criterion.reviewCheck !== undefined && criterion.qaCheck !== undefined;
    lines.push(
      "",
      `### ${(index + 1).toString()}. ${inline(criterion.criterion)}`,
      "",
      `- Evidence binding: \`${bound ? "BOUND" : "LEGACY_UNBOUND"}\``,
      `- Review artifact: \`${criterion.reviewArtifactId}\``,
      `- QA artifact: \`${criterion.qaArtifactId}\``,
      ...(bound
        ? [
            `- Selected Review check: ${inline(criterion.reviewCheck ?? "")}`,
            `- Selected QA check: ${inline(criterion.qaCheck ?? "")}`,
          ]
        : []),
      ...(criterion.verificationCheckIds === undefined
        ? []
        : [
            `- Selected Project checks: ${criterion.verificationCheckIds.map((id) => `\`${id}\``).join(", ")}`,
          ]),
      `- Known risk: ${criterion.knownRisk === null ? "None recorded" : inline(criterion.knownRisk)}`,
      "",
      "Implementation:",
      ...quoted(criterion.implementation),
      "",
      "Owner verification:",
      ...quoted(criterion.verification),
    );
  });

  lines.push("", "## Overall verification", "");
  packageValue.verifyInstructions.forEach((instruction, index) => {
    lines.push(`${(index + 1).toString()}. ${inline(instruction)}`);
  });

  lines.push("", "## Evidence artifacts");
  for (const id of packageValue.artifactIds) {
    const artifactValue = artifactsById.get(id);
    if (artifactValue === undefined)
      return invalid("The AcceptancePackage evidence changed during rendering");
    const authority =
      artifactValue.reviewReportId === undefined
        ? artifactValue.qaRunId === undefined
          ? "Legacy compact artifact"
          : `QARun \`${artifactValue.qaRunId}\`, QAEvidenceBundle \`${artifactValue.qaEvidenceBundleId ?? "missing"}\``
        : `ReviewReport \`${artifactValue.reviewReportId}\``;
    lines.push(
      "",
      `### ${artifactValue.kind} \`${artifactValue.id}\``,
      "",
      `- Provider: \`${artifactValue.provider}\``,
      `- StageAttempt: \`${artifactValue.stageAttemptId}\``,
      `- Tested tree: ${artifactValue.testedTree === undefined ? "Legacy unmeasured artifact" : `\`${artifactValue.testedTree}\``}`,
      `- Authority: ${authority}`,
      "",
      ...quoted(artifactValue.summary),
      "",
      ...artifactValue.checks.map((check) => `- ${inline(check)}`),
    );
  }

  lines.push("", "## Measured browser QA");
  if (qaEvidence.length === 0) {
    lines.push("", "No measured QA bundle is attached to this legacy package.");
  } else {
    for (const evidence of qaEvidence) {
      lines.push(
        "",
        `### QAEvidenceBundle \`${evidence.id}\``,
        "",
        `- QARun: \`${evidence.qaRunId}\``,
        `- Verdict: \`${evidence.verdict}\``,
        `- Tested tree: \`${evidence.testedTree}\``,
        `- Environment: ${inline(`${evidence.environment.osFamily} · ${evidence.environment.browserName} ${evidence.environment.browserVersion}`)}`,
        `- Executions: ${evidence.executions.length.toString()}`,
        `- Attachments: ${evidence.attachmentIds.length.toString()}`,
      );
      evidence.executions.forEach((execution) => {
        lines.push(
          "",
          `- Execution \`${execution.targetId}/${execution.scenarioId}\` · ${execution.durationMs.toString()} ms`,
          ...execution.steps.map(
            (step) => `  - Step \`${step.id}\`: \`${step.status}\` · ${step.durationMs.toString()} ms`,
          ),
          ...execution.assertions.map(
            (assertion) =>
              `  - Assertion \`${assertion.id}\`: \`${assertion.status}\`${assertion.details === null ? "" : ` · ${inline(assertion.details)}`}`,
          ),
        );
      });
      evidence.observations.forEach((observation) => {
        lines.push(
          `- Observation \`${observation.kind}/${observation.severity}\` at \`${observation.targetId}/${observation.scenarioId}\`${observation.blocking ? " · blocking" : ""}: ${inline(observation.summary)}`,
        );
      });
    }
  }

  lines.push("", "## QA attachments");
  if (attachments.length === 0) {
    lines.push("", "No attachment metadata is recorded.");
  } else {
    lines.push("");
    attachments.forEach((attachment) => {
      lines.push(
        `- \`${attachment.kind}\` \`${attachment.id}\` · ${attachment.targetId}/${attachment.scenarioId} · ${attachment.byteSize.toString()} bytes · \`${attachment.contentHash}\``,
      );
    });
  }

  lines.push("", "## Owner resolution", "");
  if (packageValue.resolvedAt === null) {
    lines.push("Pending owner decision.");
  } else {
    lines.push(
      `- Resolved: \`${packageValue.resolvedAt}\``,
      `- Actor: \`${packageValue.resolvedBy?.type ?? "UNKNOWN"}:${packageValue.resolvedBy?.id ?? "unknown"}\``,
      `- Reason: ${packageValue.resolutionReason === null ? "None recorded" : inline(packageValue.resolutionReason)}`,
    );
  }

  lines.push("", "## Decisions");
  if (decisions.length === 0) {
    lines.push("", "No decisions are recorded.");
  } else {
    lines.push("");
    decisions.forEach((decision) => {
      lines.push(
        `- \`${decision.createdAt}\` · \`${decision.id}\` · request \`${decision.humanRequestId}\` · ${inline(answerSummary(decision))}${decision.reason === null ? "" : ` · ${inline(decision.reason)}`}`,
      );
    });
  }

  lines.push("", "## Audit trail");
  if (events.length === 0) {
    lines.push("", "No Events are recorded.");
  } else {
    lines.push("");
    events.forEach((event) => {
      lines.push(
        `${event.sequence.toString()}. \`${event.occurredAt}\` · \`${event.type}\` · \`${event.actor.type}:${event.actor.id}\` · correlation \`${event.correlationId}\``,
      );
    });
  }

  const markdown = `${lines.join("\n")}\n`;
  const byteSize = utf8ByteLength(markdown);
  if (byteSize > MAX_RELEASE_SUMMARY_BYTES) {
    return { type: "TOO_LARGE", reason: "The complete release summary exceeds the 512 KiB limit" };
  }
  return { type: "RENDERED", markdown, byteSize };
};
