import type { BrowserDriver } from "@loomrail/browser-qa";
import {
  stateCommandResultSchema,
  type CompleteQARunCommand,
  type PipelineRun,
  type Project,
  type QACorrectionRun,
  type QAEvidenceBundle,
  type QARetestCell,
  type QARetestPlan,
  type QARun,
  type ReserveQARunCommand,
  type StageAttempt,
} from "@loomrail/contracts";
import type { LocalState, StateQuery, StateQueryResult } from "@loomrail/persistence-sqlite";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createBrowserQAStageRunner } from "../src/browser-qa-runner.js";
import { readyBrowserQAConfig } from "./browser-qa-fixture.js";

const project: Project = {
  schemaVersion: 1,
  id: "project-qa",
  workspaceId: "workspace-local",
  fixtureId: "web-app-a",
  name: "Browser QA fixture",
  repositoryPath: "/fixture",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 1,
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

describe("daemon Browser QA runner", () => {
  it("turns a thrown driver failure into a durable error completion without attachments", async () => {
    const config = await readyBrowserQAConfig(project);
    if (config.status !== "READY") throw new Error("Expected the ready Browser QA fixture config");
    const qaRun: QARun = {
      schemaVersion: 1,
      id: "qa-run-driver-error",
      projectId: project.id,
      workItemId: "work-item-qa",
      pipelineRunId: "pipeline-run-qa",
      stageAttemptId: "stage-attempt-qa",
      agentRunId: "agent-run-qa",
      driverId: "PLAYWRIGHT",
      testedTree: "a".repeat(40),
      targetOrigin: config.targetOrigin,
      plan: config.plan,
      scope: { type: "FULL" },
      status: "RUNNING",
      error: null,
      startedAt: "2026-09-02T10:00:00.000Z",
      completedAt: null,
      version: 1,
    };
    const completions: CompleteQARunCommand[] = [];
    const stageAttempt: StageAttempt = {
      schemaVersion: 1,
      id: qaRun.stageAttemptId,
      projectId: qaRun.projectId,
      workItemId: qaRun.workItemId,
      pipelineRunId: qaRun.pipelineRunId,
      correctionRunId: null,
      stage: "QA",
      attempt: 1,
      status: "RUNNING",
      version: 1,
      startedAt: qaRun.startedAt,
      finishedAt: null,
      failureCode: null,
      unproductiveSessions: 0,
      packShareBackoffs: 0,
      resultTree: null,
    };
    const pipelineRun: PipelineRun = {
      schemaVersion: 1,
      id: qaRun.pipelineRunId,
      projectId: qaRun.projectId,
      workItemId: qaRun.workItemId,
      workflowTemplateId: "delivery-v1",
      workflowVersion: 1,
      status: "RUNNING",
      currentStageAttemptId: stageAttempt.id,
      version: 1,
      createdAt: qaRun.startedAt,
      updatedAt: qaRun.startedAt,
      finishedAt: null,
    };
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      execute: (command) => {
        if (command.type === "RESERVE_QA_RUN") {
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "QA_RUN_RESERVED",
            replayed: false,
            workItemId: qaRun.workItemId,
            qaRun,
            event: {
              schemaVersion: 1,
              sequence: 1,
              id: "event-qa-reserved",
              type: "QA_RUN_RESERVED",
              aggregateType: "WORK_ITEM",
              aggregateId: qaRun.workItemId,
              projectId: qaRun.projectId,
              actor: command.actor,
              occurredAt: qaRun.startedAt,
              correlationId: command.correlationId,
              data: { qaRun },
            },
          });
        }
        if (command.type === "COMPLETE_QA_RUN") {
          completions.push(command);
          if (command.payload.result.outcome !== "ERROR") {
            throw new Error("Expected an errored driver completion");
          }
          const completedRun: QARun = {
            ...qaRun,
            status: "ERROR",
            error: {
              code: command.payload.result.code,
              summary: command.payload.result.summary,
            },
            completedAt: "2026-09-02T10:00:01.000Z",
            version: 2,
          };
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "QA_RUN_COMPLETED",
            replayed: false,
            workItemId: qaRun.workItemId,
            qaRun: completedRun,
            evidence: null,
            attachments: [],
            defects: [],
            event: {
              schemaVersion: 1,
              sequence: 2,
              id: "event-qa-completed",
              type: "QA_RUN_COMPLETED",
              aggregateType: "WORK_ITEM",
              aggregateId: qaRun.workItemId,
              projectId: qaRun.projectId,
              actor: command.actor,
              occurredAt: completedRun.completedAt,
              correlationId: command.correlationId,
              data: { qaRun: completedRun, evidenceBundleId: null, defectIds: [] },
            },
          });
        }
        throw new Error(`Unexpected command ${command.type}`);
      },
      query: (query: StateQuery): StateQueryResult => {
        if (query.type === "GET_PROJECT") return { type: "PROJECT", project };
        if (query.type === "GET_WORKFLOW_SNAPSHOT") {
          return {
            type: "WORKFLOW_SNAPSHOT",
            snapshot: {
              schemaVersion: 1,
              run: pipelineRun,
              stageAttempts: [stageAttempt],
              humanRequests: [],
              decisions: [],
              budgetPolicies: [],
              usageRecords: [],
              recoveryReports: [],
              artifacts: [],
              acceptancePackage: null,
            },
          };
        }
        throw new Error(`Unexpected query ${query.type}`);
      },
      close: () => undefined,
    };
    const macOSPath = ["", "Users", "owner", "private.txt"].join("/");
    const driver: BrowserDriver = {
      id: "PLAYWRIGHT",
      run: () => Promise.reject(new Error(`CANARY_DRIVER_FAILURE ${macOSPath}`)),
    };
    const app = Fastify({ logger: false });
    let commandIndex = 0;
    const runner = createBrowserQAStageRunner({
      state,
      driver,
      resolveConfig: readyBrowserQAConfig,
      createCommandId: () => `command-${(commandIndex += 1).toString()}`,
      createAttachmentId: () => "attachment-unexpected",
      logger: app.log,
    });

    await runner.run({
      dispatch: {
        schemaVersion: 1,
        id: "dispatch-qa",
        projectId: project.id,
        workItemId: qaRun.workItemId,
        pipelineRunId: qaRun.pipelineRunId,
        stageAttemptId: qaRun.stageAttemptId,
        mode: "START",
        status: "PENDING",
        createdAt: qaRun.startedAt,
        completedAt: null,
      },
      agentRunId: qaRun.agentRunId,
      testedTree: qaRun.testedTree,
    });

    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toEqual({
      qaRunId: qaRun.id,
      expectedVersion: 1,
      currentTree: qaRun.testedTree,
      result: {
        outcome: "ERROR",
        code: "DRIVER_CRASHED",
        summary: "The Playwright driver crashed before it returned bounded evidence.",
      },
      finalizedAttachments: [],
    });
    expect(JSON.stringify(completions)).not.toContain("CANARY_DRIVER_FAILURE");
    expect(JSON.stringify(completions)).not.toContain(macOSPath);
    await app.close();
  });

  it("reserves and executes the immutable sparse scope for a correction retest", async () => {
    const config = await readyBrowserQAConfig(project);
    if (config.status !== "READY") throw new Error("Expected the ready Browser QA fixture config");
    const baselineRun: QARun = {
      schemaVersion: 1,
      id: "qa-run-baseline",
      projectId: project.id,
      workItemId: "work-item-qa-retest",
      pipelineRunId: "pipeline-run-qa-retest",
      stageAttemptId: "stage-attempt-qa-baseline",
      agentRunId: "agent-run-qa-baseline",
      driverId: "PLAYWRIGHT",
      testedTree: "a".repeat(40),
      targetOrigin: config.targetOrigin,
      plan: config.plan,
      scope: { type: "FULL" },
      status: "FAILED",
      error: null,
      startedAt: "2026-09-02T09:00:00.000Z",
      completedAt: "2026-09-02T09:01:00.000Z",
      version: 2,
    };
    const correction: QACorrectionRun = {
      schemaVersion: 1,
      id: "correction-1",
      projectId: project.id,
      workItemId: baselineRun.workItemId,
      pipelineRunId: baselineRun.pipelineRunId,
      ordinal: 1,
      sourceQARunId: baselineRun.id,
      baselineQARunId: baselineRun.id,
      sourceEvidenceBundleId: "qa-evidence-baseline",
      sourceTestedTree: baselineRun.testedTree,
      defectIds: ["qa-defect-1"],
      status: "ACTIVE",
      createdAt: "2026-09-02T09:01:00.000Z",
      completedAt: null,
      version: 1,
    };
    const retestPlan: QARetestPlan = {
      schemaVersion: 1,
      id: "retest-plan-1",
      projectId: project.id,
      workItemId: baselineRun.workItemId,
      pipelineRunId: baselineRun.pipelineRunId,
      correctionRunId: correction.id,
      baselineQARunId: baselineRun.id,
      sourceQARunId: baselineRun.id,
      sourceEvidenceBundleId: correction.sourceEvidenceBundleId,
      baselinePlanRevision: baselineRun.plan.revision,
      baselinePlanContentHash: baselineRun.plan.contentHash,
      cells: [
        {
          targetId: baselineRun.plan.targets[0]?.id ?? "missing-target",
          scenarioId: baselineRun.plan.scenarios[0]?.id ?? "missing-scenario",
          reasons: ["FAILED_CHECK", "OPEN_DEFECT"],
        },
      ],
      createdAt: correction.createdAt,
    };
    const stageAttempt: StageAttempt = {
      schemaVersion: 1,
      id: "stage-attempt-qa-retest",
      projectId: project.id,
      workItemId: baselineRun.workItemId,
      pipelineRunId: baselineRun.pipelineRunId,
      correctionRunId: correction.id,
      stage: "QA",
      attempt: 1,
      status: "RUNNING",
      version: 2,
      startedAt: "2026-09-02T10:00:00.000Z",
      finishedAt: null,
      failureCode: null,
      unproductiveSessions: 0,
      packShareBackoffs: 0,
      resultTree: null,
    };
    const pipelineRun: PipelineRun = {
      schemaVersion: 1,
      id: baselineRun.pipelineRunId,
      projectId: project.id,
      workItemId: baselineRun.workItemId,
      workflowTemplateId: "delivery-v1",
      workflowVersion: 1,
      status: "RUNNING",
      currentStageAttemptId: stageAttempt.id,
      version: 4,
      createdAt: baselineRun.startedAt,
      updatedAt: stageAttempt.startedAt ?? baselineRun.startedAt,
      finishedAt: null,
    };
    const testedTree = "c".repeat(40);
    const reservedRun: QARun = {
      ...baselineRun,
      id: "qa-run-retest",
      stageAttemptId: stageAttempt.id,
      agentRunId: "agent-run-qa-retest",
      testedTree,
      scope: {
        type: "RETEST",
        correctionRunId: correction.id,
        retestPlanId: retestPlan.id,
      },
      status: "RUNNING",
      completedAt: null,
      version: 1,
    };
    const targetId = retestPlan.cells[0]?.targetId;
    const scenarioId = retestPlan.cells[0]?.scenarioId;
    const scenario = baselineRun.plan.scenarios[0];
    if (targetId === undefined || scenarioId === undefined || scenario === undefined) {
      throw new Error("Expected a non-empty retest fixture");
    }
    const evidence: QAEvidenceBundle = {
      schemaVersion: 1,
      id: "qa-evidence-retest",
      qaRunId: reservedRun.id,
      projectId: project.id,
      workItemId: reservedRun.workItemId,
      pipelineRunId: reservedRun.pipelineRunId,
      stageAttemptId: stageAttempt.id,
      testedTree,
      verdict: "PASSED",
      environment: {
        osFamily: "MACOS",
        runtimeName: "NODE",
        runtimeVersion: "24.7.0",
        browserName: "CHROMIUM",
        browserVersion: "140.0",
      },
      executions: [
        {
          targetId,
          scenarioId,
          durationMs: 10,
          steps: scenario.steps.map(({ id }) => ({ id, status: "PASSED" as const, durationMs: 1 })),
          assertions: scenario.assertions.map(({ id }) => ({ id, status: "PASSED" as const, details: null })),
        },
      ],
      observations: [],
      attachmentIds: [],
      defectIds: [],
      createdAt: "2026-09-02T10:01:00.000Z",
    };
    let reservation: ReserveQARunCommand | undefined;
    let completion: CompleteQARunCommand | undefined;
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      execute: (command) => {
        if (command.type === "RESERVE_QA_RUN") {
          reservation = command;
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "QA_RUN_RESERVED",
            replayed: false,
            workItemId: reservedRun.workItemId,
            qaRun: reservedRun,
            event: {
              schemaVersion: 1,
              sequence: 1,
              id: "event-retest-reserved",
              type: "QA_RUN_RESERVED",
              aggregateType: "WORK_ITEM",
              aggregateId: reservedRun.workItemId,
              projectId: project.id,
              actor: command.actor,
              occurredAt: reservedRun.startedAt,
              correlationId: command.correlationId,
              data: { qaRun: reservedRun },
            },
          });
        }
        if (command.type === "COMPLETE_QA_RUN") {
          completion = command;
          const completedRun: QARun = {
            ...reservedRun,
            status: "PASSED",
            completedAt: evidence.createdAt,
            version: 2,
          };
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "QA_RUN_COMPLETED",
            replayed: false,
            workItemId: reservedRun.workItemId,
            qaRun: completedRun,
            evidence,
            attachments: [],
            defects: [],
            event: {
              schemaVersion: 1,
              sequence: 2,
              id: "event-retest-completed",
              type: "QA_RUN_COMPLETED",
              aggregateType: "WORK_ITEM",
              aggregateId: reservedRun.workItemId,
              projectId: project.id,
              actor: command.actor,
              occurredAt: evidence.createdAt,
              correlationId: command.correlationId,
              data: { qaRun: completedRun, evidenceBundleId: evidence.id, defectIds: [] },
            },
          });
        }
        throw new Error(`Unexpected command ${command.type}`);
      },
      query: (query: StateQuery): StateQueryResult => {
        if (query.type === "GET_WORKFLOW_SNAPSHOT") {
          return {
            type: "WORKFLOW_SNAPSHOT",
            snapshot: {
              schemaVersion: 1,
              run: pipelineRun,
              stageAttempts: [stageAttempt],
              humanRequests: [],
              decisions: [],
              budgetPolicies: [],
              usageRecords: [],
              recoveryReports: [],
              artifacts: [],
              acceptancePackage: null,
            },
          };
        }
        if (query.type === "GET_QA_STATE") {
          return {
            type: "QA_STATE",
            runs: [baselineRun],
            evidence: [],
            attachments: [],
            defects: [],
            correctionRuns: [correction],
            retestPlans: [retestPlan],
          };
        }
        throw new Error(`Unexpected query ${query.type}`);
      },
      close: () => undefined,
    };
    let receivedCells: readonly QARetestCell[] | undefined;
    const driver: BrowserDriver = {
      id: "PLAYWRIGHT",
      run: (_qaRun, cells) => {
        receivedCells = cells;
        return Promise.resolve({
          result: {
            outcome: "MEASURED",
            environment: evidence.environment,
            executions: evidence.executions,
            observations: [],
            attachments: [],
            defects: [],
          },
          finalizeAttachments: () => Promise.resolve([]),
          confirmAttachments: () => Promise.resolve(),
          dispose: () => Promise.resolve(),
        });
      },
    };
    let configCalls = 0;
    const app = Fastify({ logger: false });
    const runner = createBrowserQAStageRunner({
      state,
      driver,
      resolveConfig: () => {
        configCalls += 1;
        return Promise.resolve(config);
      },
      createCommandId: () => "command-retest",
      createAttachmentId: () => "attachment-unexpected",
      logger: app.log,
    });

    await runner.run({
      dispatch: {
        schemaVersion: 1,
        id: "dispatch-qa-retest",
        projectId: project.id,
        workItemId: reservedRun.workItemId,
        pipelineRunId: reservedRun.pipelineRunId,
        stageAttemptId: stageAttempt.id,
        mode: "START",
        status: "PENDING",
        createdAt: stageAttempt.startedAt ?? baselineRun.startedAt,
        completedAt: null,
      },
      agentRunId: reservedRun.agentRunId,
      testedTree,
    });

    expect(configCalls).toBe(0);
    expect(reservation?.payload).toMatchObject({
      targetOrigin: baselineRun.targetOrigin,
      plan: baselineRun.plan,
      scope: reservedRun.scope,
    });
    expect(receivedCells).toEqual(retestPlan.cells);
    expect(completion?.payload).toMatchObject({ qaRunId: reservedRun.id, currentTree: testedTree });
    await app.close();
  });
});
