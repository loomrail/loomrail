import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateCommand, WorkflowTemplate } from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import { deliveryTemplate } from "@loomrail/workflow-engine";
import { describe, expect, it } from "vitest";
import { seedQueuedAttempt, snapshotOf } from "./state-fixtures.js";
import { readAgentSchedulingSnapshot } from "../src/agent-scheduling.js";
import { gatedAdapter } from "./gated-adapter.js";

describe("coordinator durable assignment", () => {
  it("commits once, restores the exact policy after reopen and refuses provider substitution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail coordinator пробел "));
    let state: LocalState | undefined;
    let ordinal = 0;
    const commandId = () => `command-${String(++ordinal)}`;
    const open = async () =>
      openLocalState({
        databasePath: join(directory, "state.sqlite"),
        now: () => new Date("2026-09-19T00:00:00.000Z"),
        createId: (kind) => `${kind}-${String(++ordinal)}`,
      });
    try {
      state = await open();
      const first = state;
      const commands: StateCommand[] = [];
      const recording: LocalState = {
        ...first,
        execute: (command) => {
          commands.push(command);
          return first.execute(command);
        },
      };
      const plan = deliveryTemplate.stages.find(({ stage }) => stage === "PLAN");
      if (!plan) throw new Error("PLAN missing");
      const template: WorkflowTemplate = {
        ...deliveryTemplate,
        id: "coordinator-persistence-test",
        stages: [{ ...plan, ordinal: 0 }],
      };
      const seeded = seedQueuedAttempt(recording, commandId, directory, "project-web", template, {
        mode: "CODE_BLIND",
        ownerOutcome: "Keep the owner's progress accurate.",
      });
      const start = commands.find(({ type }) => type === "START_PIPELINE");
      if (!start) throw new Error("START_PIPELINE missing");
      expect(() =>
        first.execute({
          ...start,
          commandId: commandId(),
          actor: { type: "SYSTEM", id: "local-daemon" },
        }),
      ).toThrow(expect.objectContaining({ code: "WORKFLOW_CONTROL_NOT_ALLOWED" }));
      expect(first.execute(start).replayed).toBe(true);
      const assignment = first.query({
        type: "GET_SQUAD_ASSIGNMENT",
        pipelineRunId: seeded.dispatch.pipelineRunId,
      });
      first.close();
      state = await open();
      expect(
        state.query({ type: "GET_SQUAD_ASSIGNMENT", pipelineRunId: seeded.dispatch.pipelineRunId }),
      ).toEqual(assignment);
      expect(snapshotOf(state, seeded.workItemId).orchestration).toEqual({
        mode: "CODE_BLIND",
        ownerOutcome: "Keep the owner's progress accurate.",
      });
      const args: unknown[][] = [];
      const scheduling = readAgentSchedulingSnapshot({
        state,
        resolveAdapter: (...values) => {
          args.push(values);
          return gatedAdapter(128_000);
        },
      });
      expect(args[0]?.[3]).toBe("CODEX");
      expect(scheduling.candidates[0]?.workspace).toEqual({ type: "NONE" });
      const claim = {
        schemaVersion: 1 as const,
        commandId: commandId(),
        correlationId: "coordinator-claim",
        actor: { type: "SYSTEM" as const, id: "local-daemon" },
        type: "START_AGENT_RUN" as const,
        payload: {
          dispatchId: seeded.dispatch.id,
          provider: "CODEX" as const,
          modelMapping: null,
          limits: { global: 3, project: 3, provider: 3 },
        },
      };
      expect(() =>
        state?.execute({ ...claim, payload: { ...claim.payload, provider: "CLAUDE_CODE" } }),
      ).toThrow(
        expect.objectContaining({
          code: "PERSISTENCE_FAILURE",
          cause: expect.objectContaining({ code: "PROFILE_STAGE_MISMATCH" }) as unknown,
        }),
      );
      const started = state.execute(claim);
      expect(started).toMatchObject({
        type: "AGENT_RUN_STARTED",
        run: {
          policySnapshot: {
            execution: { kind: "CODE_BLIND_MANAGER" },
            modelId: "gpt-6-astra",
            workspace: { access: "NONE" },
            effectiveCapabilities: ["ARTIFACT_WRITE"],
          },
        },
      });
      expect(state.execute(claim).replayed).toBe(true);
      const capturedRuns = state.query({ type: "LIST_AGENT_RUNS" });
      state.close();
      state = await open();
      expect(state.query({ type: "LIST_AGENT_RUNS" })).toEqual(capturedRuns);
      expect(state.execute(claim).replayed).toBe(true);
      expect(state.query({ type: "LIST_AGENT_RUNS" })).toMatchObject({
        runs: [
          expect.objectContaining({
            profile: { id: "builtin.code-blind-coordinator", revision: 1, role: "LEAD_PM" },
          }),
        ],
      });
    } finally {
      state?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
