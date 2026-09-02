import type { BrowserDriver } from "@loomrail/browser-qa";
import {
  stateCommandResultSchema,
  type CompleteQARunCommand,
  type Project,
  type QARun,
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
});
