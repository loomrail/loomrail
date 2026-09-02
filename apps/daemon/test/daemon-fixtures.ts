import { randomBytes } from "node:crypto";

import {
  projectsResponseSchema,
  sessionExchangeResponseSchema,
  stateCommandResultSchema,
  workflowSnapshotSchema,
  type WorkflowSnapshot,
} from "@loomrail/contracts";

import type { RunningDaemon } from "../src/server.js";
import { assertRepositoryOutsideThisCheckout } from "./repo-fixtures.js";

// The session-bootstrap and WorkItem plumbing every daemon integration suite needs.
//
// A plain module rather than exports from `server.integration.test.ts`, because that file is itself
// matched by the `integration` project's glob: importing it re-ran its whole suite a second time in
// the importing file's module instance, which is why `provider-selection.integration.test.ts` used
// to keep duplicates of these instead of importing them.

export const bootstrapToken = (): string => randomBytes(32).toString("base64url");

export type AuthenticatedSession = {
  cookie: string;
  csrfToken: string;
  setCookie: string;
};

export const authenticate = async (daemon: RunningDaemon, token: string): Promise<AuthenticatedSession> => {
  const exchange = await fetch(`${daemon.baseUrl}/api/session/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: daemon.baseUrl },
    body: JSON.stringify({ bootstrapToken: token }),
  });
  const setCookie = exchange.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie || !setCookie) throw new Error("Session exchange did not return a cookie");
  const session = sessionExchangeResponseSchema.parse(await exchange.json());
  return { cookie, csrfToken: session.csrfToken, setCookie };
};

export const mutationHeaders = (
  daemon: RunningDaemon,
  session: AuthenticatedSession,
): Record<string, string> => ({
  "content-type": "application/json",
  cookie: session.cookie,
  origin: daemon.baseUrl,
  "x-loomrail-csrf": session.csrfToken,
});

// A mutation handler now answers with the snapshot as of immediately after its own command, before
// the background worker has necessarily run (spec D4/D6): a test that wants the state a stage
// reaches once the worker drains it has to re-fetch, not read the mutation's own response body.
// Pair with `daemon.whenIdle()` -- called first -- so the read lands after the drain settles.
export const fetchWorkflowSnapshot = async (
  daemon: RunningDaemon,
  cookie: string,
  workItemId: string,
): Promise<WorkflowSnapshot> => {
  const response = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/workflow`, {
    headers: { cookie },
  });
  return workflowSnapshotSchema.parse(await response.json());
};

/**
 * Registers the bundled fixture, creates a WorkItem under it and moves it to READY -- none of which
 * ever touches the ProviderAdapter, so this is safe to run live against a daemon whose adapter is
 * gated shut for the rest of the test.
 *
 * The one seam every test that runs a pipeline goes through, and deliberately so. Registration goes
 * through the daemon's own endpoint, which materialises the fixture as a real repository outside
 * this checkout, so a run that reaches IMPLEMENT cuts its worktree from that copy -- and the
 * assertion below is what keeps that true, loudly, rather than letting a future change land as
 * branches in the developer's own repository. A second call against the same daemon is answered 409
 * (the Project is already registered) and deliberately ignored: every caller wants the same one
 * Project.
 */
export const createReadyWorkItem = async (
  daemon: RunningDaemon,
  session: AuthenticatedSession,
  title: string,
): Promise<string> => {
  const headers = mutationHeaders(daemon, session);
  await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ schemaVersion: 1, commandId: `register-${title}`, fixtureId: "web-app-a" }),
  });
  const listed = await fetch(`${daemon.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } });
  const projects = projectsResponseSchema.parse(await listed.json());
  // Every Project this daemon could dispatch against, not only the one below: a workspace is cut
  // from whatever repository a WorkItem's Project names.
  for (const project of projects.projects) {
    await assertRepositoryOutsideThisCheckout(project.repositoryPath);
  }
  const createResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schemaVersion: 1,
      commandId: `create-${title}`,
      projectId: "project-fixture-web-app-a",
      type: "TASK",
      title,
      acceptanceCriteria: ["The owner can verify the delivered outcome after the pipeline completes."],
    }),
  });
  const created = stateCommandResultSchema.parse(await createResponse.json());
  if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
  await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/move`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schemaVersion: 1,
      commandId: `ready-${title}`,
      expectedVersion: 1,
      targetState: "READY",
    }),
  });
  return created.workItem.id;
};
