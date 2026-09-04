import type {
  CompleteVerificationPlanPublicationCommand,
  FailVerificationPlanPublicationCommand,
  RetryVerificationPlanPublicationCommand,
  VerificationPlan,
  VerificationPlanPublication,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideVerificationPlanPublicationCompleted,
  decideVerificationPlanPublicationFailed,
  decideVerificationPlanPublicationRetry,
} from "../src/verification.js";

const now = "2026-09-05T10:00:00.000Z";
const plan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-1",
  projectId: "project-1",
  revision: 1,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "package-test",
      kind: "UNIT",
      label: "Tests",
      required: true,
      executable: "pnpm",
      argv: ["run", "test"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "a".repeat(64),
        scriptName: "test",
        scriptBodyPreview: "vitest run",
      },
    },
  ],
  sourceProposalHash: "b".repeat(64),
  contentHash: "c".repeat(64),
  createdAt: now,
};
const publication: VerificationPlanPublication = {
  schemaVersion: 1,
  id: "verification-publication-1",
  projectId: plan.projectId,
  planId: plan.id,
  targetPath: ".loomrail/verification-plan.json",
  expectedTargetDigest: null,
  contentHash: plan.contentHash,
  status: "PENDING",
  attempts: 0,
  lastErrorCode: null,
  version: 1,
  createdAt: now,
  updatedAt: now,
  appliedAt: null,
};

const base = {
  schemaVersion: 1 as const,
  correlationId: "correlation-publication",
};

describe("verification plan publication lifecycle", () => {
  it("lets only the daemon complete a pending publication", () => {
    const command: CompleteVerificationPlanPublicationCommand = {
      ...base,
      commandId: "complete-publication",
      actor: { type: "SYSTEM", id: "verification-publisher" },
      type: "COMPLETE_VERIFICATION_PLAN_PUBLICATION",
      payload: { publicationId: publication.id, expectedVersion: publication.version },
    };

    const decision = decideVerificationPlanPublicationCompleted(command, { now, plan, publication });

    expect(decision.publication).toMatchObject({
      status: "APPLIED",
      attempts: 1,
      lastErrorCode: null,
      version: 2,
      appliedAt: now,
    });
    expect(decision.event.type).toBe("VERIFICATION_PLAN_PUBLICATION_APPLIED");
  });

  it("records a closed publisher failure without manufacturing an applied plan", () => {
    const command: FailVerificationPlanPublicationCommand = {
      ...base,
      commandId: "fail-publication",
      actor: { type: "SYSTEM", id: "verification-publisher" },
      type: "FAIL_VERIFICATION_PLAN_PUBLICATION",
      payload: {
        publicationId: publication.id,
        expectedVersion: publication.version,
        errorCode: "TARGET_CHANGED",
      },
    };

    const decision = decideVerificationPlanPublicationFailed(command, { now, plan, publication });

    expect(decision.publication).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastErrorCode: "TARGET_CHANGED",
      version: 2,
      appliedAt: null,
    });
    expect(decision.event.type).toBe("VERIFICATION_PLAN_PUBLICATION_FAILED");
  });

  it("requires an explicit owner retry of the latest failed publication", () => {
    const failed: VerificationPlanPublication = {
      ...publication,
      status: "FAILED",
      attempts: 1,
      lastErrorCode: "TARGET_CHANGED",
      version: 2,
    };
    const command: RetryVerificationPlanPublicationCommand = {
      ...base,
      commandId: "retry-publication",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RETRY_VERIFICATION_PLAN_PUBLICATION",
      payload: { projectId: plan.projectId, publicationId: failed.id, expectedVersion: failed.version },
    };

    const decision = decideVerificationPlanPublicationRetry(command, {
      now,
      plan,
      publication: failed,
      latestPlanRevision: plan.revision,
    });

    expect(decision.publication).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastErrorCode: null,
      version: 3,
    });
    expect(decision.event.type).toBe("VERIFICATION_PLAN_PUBLICATION_RETRIED");
  });

  it("refuses stale versions, wrong actors, mismatched plans, and invalid statuses", () => {
    const complete: CompleteVerificationPlanPublicationCommand = {
      ...base,
      commandId: "complete-publication",
      actor: { type: "SYSTEM", id: "verification-publisher" },
      type: "COMPLETE_VERIFICATION_PLAN_PUBLICATION",
      payload: { publicationId: publication.id, expectedVersion: publication.version },
    };
    expect(() =>
      decideVerificationPlanPublicationCompleted(
        { ...complete, actor: { type: "HUMAN", id: "local-owner" } },
        { now, plan, publication },
      ),
    ).toThrow(expect.objectContaining({ code: "SYSTEM_REQUIRED" }));
    expect(() =>
      decideVerificationPlanPublicationCompleted(
        { ...complete, payload: { ...complete.payload, expectedVersion: 9 } },
        { now, plan, publication },
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLICATION_VERSION_CONFLICT" }));
    expect(() =>
      decideVerificationPlanPublicationCompleted(complete, {
        now,
        plan: { ...plan, id: "verification-plan-2" },
        publication,
      }),
    ).toThrow(expect.objectContaining({ code: "PUBLICATION_PLAN_MISMATCH" }));
    expect(() =>
      decideVerificationPlanPublicationCompleted(complete, {
        now,
        plan,
        publication: { ...publication, status: "APPLIED" },
      }),
    ).toThrow(expect.objectContaining({ code: "PUBLICATION_STATUS_INVALID" }));
  });
});
