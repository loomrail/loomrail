import { describe, expect, it } from "vitest";

import {
  attestProjectReadinessRequestSchema,
  projectReadinessSnapshotSchema,
  readinessCheckDraftSchema,
  runProjectReadinessRequestSchema,
  securityFindingDraftSchema,
} from "../src/index.js";

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
