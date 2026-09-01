import { describe, expect, it } from "vitest";

import {
  attestProjectReadinessRequestSchema,
  projectReadinessSnapshotSchema,
  readinessCheckDraftSchema,
  runProjectReadinessRequestSchema,
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
