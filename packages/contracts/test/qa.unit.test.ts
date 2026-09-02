import { describe, expect, it } from "vitest";

import {
  MAX_QA_ATTACHMENT_BYTES,
  qaAttachmentDraftSchema,
  qaAttachmentRefSchema,
  qaDefectSchema,
  qaDriverResultSchema,
  qaPlanSnapshotSchema,
  qaRunSchema,
  qaTargetOriginSchema,
} from "../src/qa.js";

const plan = {
  schemaVersion: 1 as const,
  revision: 1,
  contentHash: `sha256:${"a".repeat(64)}`,
  targets: [
    { id: "desktop-light-en", viewport: { width: 1_280, height: 800 }, locale: "en-US", theme: "LIGHT" },
  ],
  scenarios: [
    {
      id: "owner-acceptance",
      title: "Owner can inspect the current work",
      steps: [
        { id: "open-cockpit", title: "Open the Task Cockpit", action: { type: "NAVIGATE", path: "/" } },
      ],
      assertions: [
        {
          id: "current-work-visible",
          title: "Current work is visible",
          rule: { type: "VISIBLE", locator: { by: "TEXT", value: "Current work" } },
        },
      ],
    },
  ],
};

describe("browser QA contracts", () => {
  it("accepts bare loopback origins and rejects remote, credentialed, and path targets", () => {
    expect(qaTargetOriginSchema.safeParse("http://127.0.0.1:4173").success).toBe(true);
    expect(qaTargetOriginSchema.safeParse("http://localhost:4173").success).toBe(true);
    expect(qaTargetOriginSchema.safeParse("https://example.com").success).toBe(false);
    expect(qaTargetOriginSchema.safeParse("http://owner:secret@127.0.0.1:4173").success).toBe(false);
    expect(qaTargetOriginSchema.safeParse("http://127.0.0.1:4173/admin").success).toBe(false);
  });

  it("requires unique planned targets, scenarios, steps, and assertions", () => {
    expect(qaPlanSnapshotSchema.safeParse(plan).success).toBe(true);
    expect(
      qaPlanSnapshotSchema.safeParse({ ...plan, targets: [...plan.targets, plan.targets[0]] }).success,
    ).toBe(false);
    expect(
      qaPlanSnapshotSchema.safeParse({
        ...plan,
        scenarios: [
          {
            ...plan.scenarios[0],
            assertions: [plan.scenarios[0]?.assertions[0], plan.scenarios[0]?.assertions[0]],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      qaPlanSnapshotSchema.safeParse({
        ...plan,
        scenarios: [
          {
            ...plan.scenarios[0],
            steps: [
              {
                id: "external",
                title: "Leave the target",
                action: { type: "NAVIGATE", path: "https://example.com" },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps QARun status, completion, and driver error coherent", () => {
    const running = {
      schemaVersion: 1,
      id: "qa-run-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      pipelineRunId: "pipeline-1",
      stageAttemptId: "qa-attempt-1",
      agentRunId: "agent-run-1",
      driverId: "PLAYWRIGHT",
      testedTree: "b".repeat(40),
      targetOrigin: "http://127.0.0.1:4173",
      plan,
      status: "RUNNING",
      error: null,
      startedAt: "2026-09-02T10:00:00.000Z",
      completedAt: null,
      version: 1,
    } as const;
    expect(qaRunSchema.safeParse(running).success).toBe(true);
    expect(qaRunSchema.safeParse({ ...running, completedAt: running.startedAt }).success).toBe(false);
    expect(
      qaRunSchema.safeParse({ ...running, status: "ERROR", completedAt: running.startedAt }).success,
    ).toBe(false);
  });

  it("bounds measured evidence and never accepts a provider-style aggregate verdict", () => {
    const measured = {
      outcome: "MEASURED",
      environment: {
        osFamily: "MACOS",
        runtimeName: "NODE",
        runtimeVersion: "24.7.0",
        browserName: "CHROMIUM",
        browserVersion: "140.0",
      },
      executions: [
        {
          targetId: "desktop-light-en",
          scenarioId: "owner-acceptance",
          durationMs: 80,
          steps: [{ id: "open-cockpit", status: "PASSED", durationMs: 50 }],
          assertions: [{ id: "current-work-visible", status: "PASSED", details: null }],
        },
      ],
      observations: [],
      attachments: [],
      defects: [],
    } as const;
    expect(qaDriverResultSchema.safeParse(measured).success).toBe(true);
    expect(qaDriverResultSchema.safeParse({ ...measured, verdict: "PASSED" }).success).toBe(false);
  });

  it("keeps attachment storage keys relative and portable", () => {
    const attachment = {
      schemaVersion: 1,
      id: "attachment-1",
      qaRunId: "qa-run-1",
      kind: "TRACE",
      contentHash: `sha256:${"c".repeat(64)}`,
      byteSize: 1_024,
      targetId: "desktop-light-en",
      scenarioId: "owner-acceptance",
      capturedAt: "2026-09-02T10:01:00.000Z",
      retentionClass: "STANDARD_30_DAYS",
      storageKey: "qa-run-1/trace.zip",
    } as const;
    expect(qaAttachmentRefSchema.safeParse(attachment).success).toBe(true);
    expect(qaAttachmentRefSchema.safeParse({ ...attachment, storageKey: "/tmp/trace.zip" }).success).toBe(
      false,
    );
    expect(qaAttachmentRefSchema.safeParse({ ...attachment, storageKey: "../trace.zip" }).success).toBe(
      false,
    );
    expect(qaAttachmentRefSchema.safeParse({ ...attachment, storageKey: "qa-run-1/CON.zip" }).success).toBe(
      false,
    );
    expect(
      qaAttachmentRefSchema.safeParse({ ...attachment, storageKey: "qa-run-1/trace?.zip" }).success,
    ).toBe(false);
    expect(
      qaAttachmentDraftSchema.safeParse({
        handle: "trace",
        kind: attachment.kind,
        contentHash: attachment.contentHash,
        byteSize: MAX_QA_ATTACHMENT_BYTES + 1,
        targetId: attachment.targetId,
        scenarioId: attachment.scenarioId,
        capturedAt: attachment.capturedAt,
      }).success,
    ).toBe(false);
  });

  it("requires complete resolution data when a QA defect leaves OPEN", () => {
    const defect = {
      schemaVersion: 1,
      id: "defect-1",
      qaRunId: "qa-run-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      testedTree: "d".repeat(40),
      ordinal: 1,
      status: "OPEN",
      severity: "HIGH",
      title: "The required state is missing",
      description: "The current work state does not render on the mobile target.",
      reproduction: ["Open the mobile target.", "Inspect the current work region."],
      targetId: "desktop-light-en",
      scenarioId: "owner-acceptance",
      resolutionReason: null,
      createdAt: "2026-09-02T10:01:00.000Z",
      resolvedAt: null,
      version: 1,
    } as const;
    expect(qaDefectSchema.safeParse(defect).success).toBe(true);
    expect(
      qaDefectSchema.safeParse({ ...defect, status: "RESOLVED", resolutionReason: "Fixed." }).success,
    ).toBe(false);
    expect(
      qaDefectSchema.safeParse({
        ...defect,
        status: "RESOLVED",
        resolutionReason: "Fixed and verified by the scoped retest.",
        resolvedAt: "2026-09-02T11:00:00.000Z",
        version: 2,
      }).success,
    ).toBe(true);
  });
});
