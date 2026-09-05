import { describe, expect, it } from "vitest";

import {
  attestProjectReadinessRequestSchema,
  domainEventSchema,
  projectReadinessAssessedEventSchema,
  projectReadinessAssessedResultSchema,
  projectReadinessSnapshotSchema,
  readinessCheckDraftSchema,
  runProjectReadinessRequestSchema,
  securityFindingDraftSchema,
} from "../src/index.js";
import type { ProjectReadinessRun, ReadinessCheck } from "../src/index.js";

describe("Project Readiness contracts", () => {
  it("rejects executable or caller-selected filesystem options on the run request", () => {
    expect(
      runProjectReadinessRequestSchema.safeParse({
        schemaVersion: 1,
        commandId: "run-readiness",
        expectedProjectVersion: 1,
        repositoryPath: "/tmp/another-repository",
        command: "npm audit",
      }).success,
    ).toBe(false);
  });

  it("keeps scanner drafts bounded and strict", () => {
    expect(
      readinessCheckDraftSchema.safeParse({
        key: "SECURITY_SECRET_PATHS",
        category: "SECURITY",
        mode: "AUTOMATED",
        status: "ACTION_REQUIRED",
        summary: "Review the path",
        findings: [],
        secretValue: "must-not-enter-the-contract",
      }).success,
    ).toBe(false);
  });

  it("requires a rationale for every owner attestation", () => {
    expect(
      attestProjectReadinessRequestSchema.safeParse({
        schemaVersion: 1,
        commandId: "attest-readiness",
        runId: "run-one",
        checkId: "check-one",
        expectedRunVersion: 1,
        outcome: "NOT_APPLICABLE",
        rationale: "   ",
      }).success,
    ).toBe(false);
  });

  it("does not allow child records without a readiness run", () => {
    expect(
      projectReadinessSnapshotSchema.safeParse({
        schemaVersion: 1,
        run: null,
        checks: [
          {
            schemaVersion: 1,
            id: "check-one",
            runId: "run-one",
            projectId: "project-one",
            key: "LEGAL_OWNER_REVIEW",
            category: "LEGAL",
            mode: "OWNER",
            status: "ACTION_REQUIRED",
            summary: "Review legal obligations",
            version: 1,
          },
        ],
        findings: [],
        attestations: [],
      }).success,
    ).toBe(false);
  });
});

describe("readiness catalog v2 vocabulary", () => {
  it("accepts the six launch-readiness keys and their categories", () => {
    const drafts = [
      { key: "DEPS_LOCKFILE_PRESENT", category: "DEPENDENCIES", mode: "AUTOMATED" },
      { key: "ENV_PROD_SEPARATION", category: "ENVIRONMENT", mode: "AUTOMATED" },
      { key: "SECURITY_HEADERS_OWNER_REVIEW", category: "SECURITY", mode: "OWNER" },
      { key: "OPS_HEALTH_ENDPOINT_DECLARED", category: "OPERATIONS", mode: "OWNER" },
      { key: "OPS_ROLLBACK_PLAN", category: "OPERATIONS", mode: "OWNER" },
      { key: "OPS_BACKUP", category: "OPERATIONS", mode: "OWNER" },
    ] as const;

    for (const draft of drafts) {
      expect(
        readinessCheckDraftSchema.parse({
          ...draft,
          status: "ACTION_REQUIRED",
          summary: "fixture",
          findings: [],
        }).key,
      ).toBe(draft.key);
    }
  });

  it("accepts the five launch-readiness finding codes", () => {
    for (const code of [
      "LOCKFILE_MISSING",
      "LOCKFILE_AMBIGUOUS",
      "DEPENDENCY_INPUT_UNVERIFIABLE",
      "PROD_ENV_NOT_IGNORED",
      "INLINE_SECRET_IN_CI",
    ] as const) {
      expect(
        securityFindingDraftSchema.parse({ code, severity: "HIGH", path: null, message: "fixture" }).code,
      ).toBe(code);
    }
  });

  it("still rejects a key outside the closed catalog", () => {
    expect(() =>
      readinessCheckDraftSchema.parse({
        key: "OPS_MONITORING",
        category: "OPERATIONS",
        mode: "OWNER",
        status: "ACTION_REQUIRED",
        summary: "fixture",
        findings: [],
      }),
    ).toThrow();
  });
});

// The catalog the shipped release wrote into the append-only `events` table: eight checks across
// four categories. Those rows are immutable -- migration 0052 does not rewrite them -- so every
// schema on the read-back path has to keep admitting the sizes history already contains.
const historicalCatalog = [
  ["SECURITY_ACTIVE_CONSTITUTION", "SECURITY", "AUTOMATED"],
  ["SECURITY_SECRET_PATHS", "SECURITY", "AUTOMATED"],
  ["SECURITY_ENV_IGNORED", "SECURITY", "AUTOMATED"],
  ["SECURITY_CI_HARDENING", "SECURITY", "AUTOMATED"],
  ["LEGAL_LICENSE", "LEGAL", "AUTOMATED"],
  ["LEGAL_OWNER_REVIEW", "LEGAL", "OWNER"],
  ["PAYMENTS_OWNER_REVIEW", "PAYMENTS", "OWNER"],
  ["ANALYTICS_OWNER_REVIEW", "ANALYTICS", "OWNER"],
] as const satisfies readonly (readonly [
  ReadinessCheck["key"],
  ReadinessCheck["category"],
  ReadinessCheck["mode"],
])[];

const historicalRun: ProjectReadinessRun = {
  schemaVersion: 1,
  id: "run-legacy",
  projectId: "project-one",
  repositoryHead: "0123456789abcdef0123456789abcdef01234567",
  sourceDigest: "0123456789abcdef".repeat(4),
  workingTreeDirty: false,
  status: "ACTION_REQUIRED",
  version: 1,
  createdAt: "2026-08-26T18:00:00.000Z",
  updatedAt: "2026-08-26T18:00:00.000Z",
};

const historicalChecks: readonly ReadinessCheck[] = historicalCatalog.map(
  ([key, category, mode], index): ReadinessCheck => ({
    schemaVersion: 1,
    id: `check-legacy-${String(index + 1)}`,
    runId: historicalRun.id,
    projectId: historicalRun.projectId,
    key,
    category,
    mode,
    status: mode === "OWNER" ? "ACTION_REQUIRED" : "PASSED",
    summary: "Recorded under the eight-check catalog",
    version: 1,
  }),
);

const historicalAssessedEvent = {
  schemaVersion: 1,
  sequence: 41,
  id: "event-legacy",
  type: "PROJECT_READINESS_ASSESSED",
  aggregateType: "PROJECT",
  aggregateId: historicalRun.projectId,
  projectId: historicalRun.projectId,
  actor: { type: "HUMAN", id: "owner-one" },
  occurredAt: historicalRun.createdAt,
  correlationId: "correlation-legacy",
  data: { run: historicalRun, checks: historicalChecks, findings: [] },
};

describe("readiness history recorded before catalog v2", () => {
  it("still parses a stored eight-check PROJECT_READINESS_ASSESSED event", () => {
    expect(projectReadinessAssessedEventSchema.parse(historicalAssessedEvent).data.checks).toHaveLength(8);
  });

  it("still reads an eight-check assessment through the stored-event union", () => {
    // The daemon resolves its newest stored event through domainEventSchema before it can serve
    // anything; a rejection here is a cold start that never completes.
    expect(domainEventSchema.parse(historicalAssessedEvent).type).toBe("PROJECT_READINESS_ASSESSED");
  });

  it("still parses an eight-check readiness command receipt", () => {
    expect(
      projectReadinessAssessedResultSchema.parse({
        schemaVersion: 1,
        replayed: true,
        type: "PROJECT_READINESS_ASSESSED",
        run: historicalRun,
        checks: historicalChecks,
        findings: [],
      }).checks,
    ).toHaveLength(8);
  });

  it("keeps the read-back bound at the current catalog size", () => {
    expect(
      projectReadinessAssessedEventSchema.safeParse({
        ...historicalAssessedEvent,
        id: "event-oversized",
        correlationId: "correlation-oversized",
        data: {
          run: historicalRun,
          checks: [...historicalChecks, ...historicalChecks],
          findings: [],
        },
      }).success,
    ).toBe(false);
  });
});
