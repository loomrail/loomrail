import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentRunActivityPageSchema,
  insightsResponseSchema,
  launchEvidencePackageResponseSchema,
  launchReleaseProjectResponseSchema,
  projectsResponseSchema,
  providerSessionsResponseSchema,
  type ProviderActivityEntry,
} from "@loomrail/contracts";
import type { ProviderAdapter, ProviderInvocation } from "@loomrail/provider-core";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";

import { passingBrowserQADriver } from "./browser-qa-fixture.js";
import {
  authenticate,
  bootstrapToken,
  createReadyWorkItem,
  fetchWorkflowSnapshot,
  mutationHeaders,
} from "./daemon-fixtures.js";
import { createProviderTestDouble } from "./provider-double.js";

/**
 * Task 11: the proof that the activity feed (Tasks 9-10) stays inside its boundary.
 *
 * A synthetic marker, never a real secret (task-11 non-negotiables) -- distinctive enough that any
 * accidental substring match elsewhere in a rendered export would be implausible.
 */
const CANARY = "lmr-canary-7f3a9c";

/**
 * Wraps a `ProviderAdapter` so every session it starts also reports `entries` through `onActivity`
 * before doing whatever the wrapped adapter does -- the same seam a real provider CLI's stdout
 * handler uses (`ProviderSessionListener.onActivity`, exercised end to end through
 * `session-loop.ts`'s recorder, never written directly with `RECORD_AGENT_RUN_ACTIVITY`).
 *
 * A composing wrapper rather than a new option on `createProviderTestDouble` (`provider-double.ts`):
 * that double treats "any options object at all" as a request for its generic turn-based session
 * loop (`sessionBehavior = options !== undefined`), which would silently drop the scripted
 * DISCOVERY/IMPLEMENT/REVIEW/QA/ACCEPTANCE outcomes this file's full-pipeline canary depends on.
 * Composing over the finished adapter changes neither its capabilities nor its outcomes.
 */
type ReportedEntry = Pick<ProviderActivityEntry, "kind" | "label" | "detail" | "status">;

const reportingActivity = (
  adapter: ProviderAdapter,
  entriesFor: (invocation: ProviderInvocation) => readonly ReportedEntry[],
): ProviderAdapter => ({
  ...adapter,
  start: (invocation, listener) => {
    entriesFor(invocation).forEach((entry, index) => {
      listener.onActivity?.({
        actionKey: `leak-canary-${invocation.session.id}-${index.toString()}`,
        terminal: true,
        truncated: false,
        ...entry,
      });
    });
    return adapter.start(invocation, listener);
  },
});

describe("agent run activity leak canaries", () => {
  let daemon: RunningDaemon | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  // What this proves (task-11-brief): a secret appearing in a command the provider ran must not
  // reach the acceptance package export, the insights payload or the daemon's structured logs --
  // regardless of whether redaction is configured, because these surfaces must never read the
  // activity feed's text at all. The other test below is what proves redaction itself.
  //
  // Mutation evidence (recorded in task-11-report.md): a temporary stray
  // `deps.logger.info({ label: entry.label }, "activity drained")` inside
  // `drainActivityQueueUnsafely` (session-loop.ts) turns the log assertion red; reverting turns it
  // green again.
  it("keeps activity-reported text out of the acceptance package export, the insights payload and structured logs", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail activity leak изоляция "));
    directories.push(temporaryDirectory);
    const browserQAArtifactsDirectory = join(temporaryDirectory, "browser-qa-artifacts");
    const token = bootstrapToken();
    const logLines: string[] = [];
    daemon = await startDaemon({
      bootstrapToken: token,
      loggerStream: {
        write: (line) => {
          logLines.push(line);
        },
      },
      providerAdapter: reportingActivity(createProviderTestDouble(), () => [
        {
          kind: "TOOL_CALL",
          label: `curl https://example.test -H "Authorization: Bearer ${CANARY}"`,
          detail: null,
          status: null,
        },
      ]),
      browserQADriver: passingBrowserQADriver({ artifactsDirectory: browserQAArtifactsDirectory }),
      browserQAArtifactsDirectory,
    });
    const session = await authenticate(daemon, token);
    const headers = mutationHeaders(daemon, session);
    const workItemId = await createReadyWorkItem(daemon, session, "activity-leak-isolation");

    const startResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "start-leak-canary-pipeline",
        expectedVersion: 2,
        maxEstimatedTokens: 100,
        modelTierOverride: "STANDARD",
        agentRunMaxEstimatedTokensOverride: 80,
      }),
    });
    expect(startResponse.status).toBe(200);
    await daemon.whenIdle();
    const waiting = await fetchWorkflowSnapshot(daemon, session.cookie, workItemId);
    const discoveryRequest = waiting.humanRequests[0];
    if (!discoveryRequest) throw new Error("Expected the DISCOVERY human request");

    const answerResponse = await fetch(
      `${daemon.baseUrl}/api/v1/human-requests/${discoveryRequest.id}/answer`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "answer-leak-canary-discovery",
          expectedVersion: 1,
          answer: { type: "OPTION", optionIds: ["focused-pass"] },
        }),
      },
    );
    expect(answerResponse.status).toBe(200);
    await daemon.whenIdle();
    const hardPaused = await fetchWorkflowSnapshot(daemon, session.cookie, workItemId);
    if (!hardPaused.run) throw new Error("Expected a workflow run at IMPLEMENT's budget wall");

    const overrideResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/budget-override`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "override-leak-canary-budget",
          expectedVersion: hardPaused.run.version,
          maxEstimatedTokens: 200,
          modelTierOverride: "FAST",
          agentRunMaxEstimatedTokensOverride: 150,
        }),
      },
    );
    expect(overrideResponse.status).toBe(200);
    await daemon.whenIdle();
    const awaitingAcceptance = await fetchWorkflowSnapshot(daemon, session.cookie, workItemId);
    const acceptancePackage = awaitingAcceptance.acceptancePackage;
    if (!acceptancePackage) throw new Error("Expected a pending AcceptancePackage");

    // Sanity: the fixture is not vacuous. This provider's own diagnostic view is exactly where the
    // text is SUPPOSED to be visible -- it is every other surface that must not carry it. The feed
    // is WorkItem-scoped (spec 128), so every stage attempt's session is checked against the same
    // one merged page rather than a page fetched per AgentRun.
    let sawCanaryInActivity = false;
    for (const attempt of awaitingAcceptance.stageAttempts) {
      const sessionsResponse = await fetch(`${daemon.baseUrl}/api/v1/stage-attempts/${attempt.id}/sessions`, {
        headers: { cookie: session.cookie },
      });
      const sessions = providerSessionsResponseSchema.parse(await sessionsResponse.json());
      for (const providerSession of sessions.sessions) {
        if (providerSession.agentRunId === null) continue;
        const activityResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity`, {
          headers: { cookie: session.cookie },
        });
        const page = agentRunActivityPageSchema.parse(await activityResponse.json());
        if (JSON.stringify(page).includes(CANARY)) sawCanaryInActivity = true;
      }
    }
    expect(sawCanaryInActivity).toBe(true);

    const exportResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${workItemId}/acceptance/${acceptancePackage.id}/export`,
      { headers: { cookie: session.cookie } },
    );
    expect(exportResponse.status).toBe(200);
    const exportMarkdown = await exportResponse.text();
    expect(exportMarkdown).toContain("# Loomrail Release Summary");
    // Structural, not just tested here: `RenderReleaseSummaryInput` (packages/domain/src/acceptance.ts)
    // has no field carrying AgentRunActivity data, and the "Audit trail" section it renders prints
    // only each Event's `type`/`actor`/`correlationId` -- never a payload -- so there is no channel
    // for provider-reported text to travel through. This assertion guards the boundary staying shut.
    expect(exportMarkdown).not.toContain(CANARY);

    // Structural, not just tested here: `buildReportingSnapshot` (packages/domain/src/reporting.ts)
    // builds `InsightsResponse` only from `ReportingFacts`/`ReportingRuntime`, both closed Zod
    // `.strict()` schemas of counts, percentages and enums (packages/contracts/src/reporting.ts) --
    // a free-text field cannot even parse, let alone carry a provider's activity text. Already
    // covered generically by server.integration.test.ts's own regex scan on this same payload
    // (`not.toMatch(/projectId|repositoryPath|generatedAt|message|stack/)`); this reuses the same
    // real pipeline run rather than duplicating that scan.
    const insightsResponse = await fetch(`${daemon.baseUrl}/api/v1/insights`, {
      headers: { cookie: session.cookie },
    });
    expect(insightsResponse.status).toBe(200);
    const insights = insightsResponseSchema.parse(await insightsResponse.json());
    expect(JSON.stringify(insights)).not.toContain(CANARY);

    // Structural, like the acceptance-package check above, and reachable from this same daemon
    // without a separate fixture: `createReadyWorkItem` already registered "web-app-a" as a real
    // repository, so a LaunchRelease needs only three more fetches against the daemon already
    // running. `renderLaunchEvidencePackage` (packages/domain/src/launch-release.ts) takes only a
    // `LaunchRelease` -- no reference to AgentRunActivity anywhere in that type or its renderer, and
    // `CREATE_LAUNCH_RELEASE` writes no Event carrying activity text either -- so this guards the
    // same promised boundary staying shut, not a known leak (task-11-report.md has the fuller note).
    const projectsResponse = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projects = projectsResponseSchema.parse(await projectsResponse.json());
    const project = projects.projects.find(({ id }) => id === "project-fixture-web-app-a");
    if (!project) throw new Error("Expected the fixture Project to be registered");

    const environmentResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${project.id}/launch-release/environments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "leak-canary-environment",
          expectedProjectVersion: project.version,
          environmentId: null,
          expectedEnvironmentVersion: null,
          configuration: {
            kind: "PREVIEW",
            name: "Leak canary preview",
            presetId: "WEB_APP_V1",
            presetRevision: 1,
            publicBaseUrl: "https://preview.example.test",
            healthPath: "/api/health",
            requiredEnvironmentVariables: [],
          },
        }),
      },
    );
    expect(environmentResponse.status).toBe(200);
    const savedEnvironment = launchReleaseProjectResponseSchema.parse(await environmentResponse.json());
    const environment = savedEnvironment.environments[0];
    if (!environment) throw new Error("Expected a saved launch Environment");

    const releaseResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${project.id}/launch-release/releases`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "leak-canary-release",
          expectedProjectVersion: savedEnvironment.projectVersion,
          environmentId: environment.id,
          expectedEnvironmentVersion: environment.version,
          expectedEnvironmentContentHash: environment.contentHash,
          workItemIds: [],
        }),
      },
    );
    expect(releaseResponse.status).toBe(200);
    const released = launchReleaseProjectResponseSchema.parse(await releaseResponse.json());
    if (!released.latestRelease) throw new Error("Expected a created LaunchRelease");

    const evidenceResponse = await fetch(
      `${daemon.baseUrl}/api/v1/launch-releases/${released.latestRelease.id}/evidence-package`,
      { headers: { cookie: session.cookie } },
    );
    expect(evidenceResponse.status).toBe(200);
    const evidence = launchEvidencePackageResponseSchema.parse(await evidenceResponse.json());
    expect(evidence.markdown).toContain("Loomrail Launch Evidence Package");
    expect(evidence.markdown).not.toContain(CANARY);

    // Sanity, matching `sawCanaryInActivity` above: the canary really is present somewhere the owner
    // can see it, and the log check below is not passing over an empty string.
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("")).not.toContain(CANARY);
  }, 30_000);

  // What this proves (task-11-brief, SD-003): a secret named in `secretRedactions`' own environment
  // convention is redacted before it reaches storage; an absolute path outside the worktree becomes
  // the opaque marker rather than a personal path; and a path INSIDE the worktree -- spaces and
  // Cyrillic, task-11-brief step 2b -- survives as a plain relative one. All three visible through
  // the merged, owner-facing HTTP feed (`/api/v1/work-items/:workItemId/activity`), not only the raw
  // buffer query `session-activity.integration.test.ts` already pins (whose own inside-worktree
  // coverage is ASCII-only, `src/a.ts`, and so could never have caught a normalisation defect that
  // only shows up on non-ASCII bytes).
  //
  // The redaction value is supplied the same way production supplies it (`secretRedactions`,
  // apps/daemon/src/server.ts): an environment variable whose NAME looks like a credential. No
  // daemon-level test seam invents a parallel "just pass redactValues" path.
  //
  // Mutation evidence (recorded in task-11-report.md): temporarily short-circuiting
  // `sanitizeSupervisedOutput` out of `cleanActivityText`; temporarily removing the outside-workspace
  // check from `relativeToWorkspace`'s real-worktree branch; and temporarily NFD-normalising that
  // same branch's return value (all in apps/daemon/src/session-loop.ts) -- each turns its own
  // assertion red; reverting turns all three green.
  it("redacts a configured secret and opaques an absolute path before either reaches the merged activity feed", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail activity leak редакция "));
    directories.push(temporaryDirectory);
    const browserQAArtifactsDirectory = join(temporaryDirectory, "browser-qa-artifacts");
    const outsidePath = join(temporaryDirectory, "пример проект", "файл тест.ts");
    const token = bootstrapToken();
    const secretEnvName = "LOOMRAIL_TEST_LEAK_CANARY_API_KEY";
    const previousEnvValue = process.env[secretEnvName];
    process.env[secretEnvName] = CANARY;
    try {
      daemon = await startDaemon({
        bootstrapToken: token,
        logger: false,
        providerAdapter: reportingActivity(createProviderTestDouble(), (invocation) => {
          if (!invocation.workspace) throw new Error("Expected DISCOVERY to run inside a real worktree");
          return [
            {
              kind: "TOOL_CALL",
              label: `export API_KEY=${CANARY}`,
              detail: null,
              status: null,
            },
            {
              kind: "FILE_CHANGE",
              label: outsidePath,
              detail: null,
              status: null,
            },
            {
              kind: "FILE_CHANGE",
              // The inside-the-worktree branch of the same normalisation, with the same
              // spaces-and-Cyrillic shape the brief's own step 2b asks for (macOS and Windows are
              // blocking platforms, and this is exactly where a posix-only join or separator
              // assumption breaks): unlike `outsidePath` above, this must survive as a plain
              // relative path, not become the opaque marker.
              label: join(invocation.workspace.path, "пример проект", "файл тест.ts"),
              detail: null,
              status: null,
            },
          ];
        }),
        browserQADriver: passingBrowserQADriver({ artifactsDirectory: browserQAArtifactsDirectory }),
        browserQAArtifactsDirectory,
      });
      const session = await authenticate(daemon, token);
      const headers = mutationHeaders(daemon, session);
      const workItemId = await createReadyWorkItem(daemon, session, "activity-leak-redaction");

      const startResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "start-leak-canary-redaction-pipeline",
          expectedVersion: 2,
          maxEstimatedTokens: 100,
          modelTierOverride: "STANDARD",
          agentRunMaxEstimatedTokensOverride: 80,
        }),
      });
      expect(startResponse.status).toBe(200);
      await daemon.whenIdle();

      // DISCOVERY's own session already reported and is done (it ends in NEEDS_HUMAN), so its
      // ProviderSession -- and the AgentRun it belongs to -- already exist and hold the write.
      const waiting = await fetchWorkflowSnapshot(daemon, session.cookie, workItemId);
      const discoveryAttempt = waiting.stageAttempts.find((attempt) => attempt.stage === "DISCOVERY");
      if (!discoveryAttempt) throw new Error("Expected a DISCOVERY stage attempt");
      const sessionsResponse = await fetch(
        `${daemon.baseUrl}/api/v1/stage-attempts/${discoveryAttempt.id}/sessions`,
        { headers: { cookie: session.cookie } },
      );
      const sessions = providerSessionsResponseSchema.parse(await sessionsResponse.json());
      // Kept as a guard even though the WorkItem-scoped route below no longer needs the id itself:
      // it still confirms DISCOVERY's write is held by a real AgentRun, not merely present in a
      // ProviderSession row with nothing behind it.
      const agentRunId = sessions.sessions[0]?.agentRunId;
      if (!agentRunId) throw new Error("Expected DISCOVERY's ProviderSession to name an AgentRun");

      const activityResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity`, {
        headers: { cookie: session.cookie },
      });
      expect(activityResponse.status).toBe(200);
      const page = agentRunActivityPageSchema.parse(await activityResponse.json());
      const rawPage = JSON.stringify(page);
      expect(rawPage).not.toContain(CANARY);
      expect(rawPage).toContain("[REDACTED]");
      // DISCOVERY is one of `stagesRunningInWorkspace` (packages/domain/src/workspace.ts), so it
      // has a real cut worktree and `outsidePath` -- a path under this test's own temp directory,
      // nowhere near that worktree -- resolves outside it: it must become the opaque marker, never
      // a relative escape (`../../...`) that still names the owner's real directory structure.
      expect(rawPage).not.toContain(outsidePath);
      expect(rawPage).not.toContain(temporaryDirectory);
      // The other branch of the same normalisation (task-11-brief step 2b): a path INSIDE the
      // worktree, with the same spaces-and-Cyrillic shape, must survive the posix join as a plain
      // relative path -- not get swept into the opaque marker alongside the outside one above, and
      // not corrupted by a host-specific separator the existing ASCII-only coverage (`src/a.ts`,
      // session-activity.integration.test.ts) could never have exercised.
      expect(page.entries.map((entry) => entry.label)).toEqual(
        expect.arrayContaining([
          "export API_KEY=[REDACTED]",
          "[path outside workspace]",
          "пример проект/файл тест.ts",
        ]),
      );
    } finally {
      if (previousEnvValue === undefined) Reflect.deleteProperty(process.env, secretEnvName);
      else process.env[secretEnvName] = previousEnvValue;
    }
  }, 30_000);
});
