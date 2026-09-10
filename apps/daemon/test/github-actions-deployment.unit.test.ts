import { describe, expect, it } from "vitest";

import {
  githubActionsObservationFromOutput,
  githubCliEnvironment,
  hasWorkflowDispatchTrigger,
  parseGithubActionsDispatchOutput,
  parseGithubRemote,
  sameCanonicalPath,
} from "../src/github-actions-deployment.js";

describe("GitHub Actions deployment adapter parsing", () => {
  it("normalizes Windows paths and keeps its CLI environment credential-free", () => {
    expect(
      sameCanonicalPath("C:\\Users\\Owner\\Recurkit проект", "c:/users/owner/recurkit проект", "win32"),
    ).toBe(true);
    expect(sameCanonicalPath("/Volumes/Fixture/Recurkit", "/volumes/fixture/recurkit", "darwin")).toBe(false);
    expect(
      githubCliEnvironment(
        {
          Path: "C:\\Windows\\System32",
          USERPROFILE: "C:\\Users\\Owner",
          GH_TOKEN: "secret-gh-token",
          GITHUB_TOKEN: "secret-github-token",
        },
        "win32",
      ),
    ).toEqual({
      NO_COLOR: "1",
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "",
      Path: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\Owner",
    });
  });

  it("recognizes only an explicit top-level workflow_dispatch trigger", () => {
    expect(hasWorkflowDispatchTrigger("name: Deploy\non:\n  workflow_dispatch:\n")).toBe(true);
    expect(hasWorkflowDispatchTrigger("name: Deploy\n'on': workflow_dispatch\n")).toBe(true);
    expect(
      hasWorkflowDispatchTrigger("# on: workflow_dispatch\non:\n  push:\n    workflow_dispatch:\n"),
    ).toBe(false);
    expect(hasWorkflowDispatchTrigger("name: workflow_dispatch\non: push\n")).toBe(false);
    expect(hasWorkflowDispatchTrigger("on:\n\tworkflow_dispatch:\n")).toBe(false);
  });

  it("accepts only credential-free github.com remotes", () => {
    expect(parseGithubRemote("git@github.com:recurkit/recurkit.git\n")).toBe("recurkit/recurkit");
    expect(parseGithubRemote("https://github.com/recurkit/recurkit.git")).toBe("recurkit/recurkit");
    expect(parseGithubRemote("ssh://git@github.com/recurkit/recurkit.git")).toBe("recurkit/recurkit");
    expect(parseGithubRemote("https://token@github.com/recurkit/recurkit.git")).toBeNull();
    expect(parseGithubRemote("git@example.test:recurkit/recurkit.git")).toBeNull();
    expect(parseGithubRemote("https://github.com/recurkit/recurkit/extra")).toBeNull();
  });

  it("accepts exactly one run URL for the expected repository", () => {
    expect(
      parseGithubActionsDispatchOutput(
        "https://github.com/recurkit/recurkit/actions/runs/12345\n",
        "recurkit/recurkit",
      ),
    ).toEqual({
      type: "DISPATCHED",
      runId: 12345,
      runUrl: "https://github.com/recurkit/recurkit/actions/runs/12345",
    });
    expect(
      parseGithubActionsDispatchOutput(
        "https://github.com/other/repo/actions/runs/12345",
        "recurkit/recurkit",
      ),
    ).toEqual({ type: "UNKNOWN" });
    expect(
      parseGithubActionsDispatchOutput(
        "https://github.com/recurkit/recurkit/actions/runs/1\nhttps://github.com/recurkit/recurkit/actions/runs/2",
        "recurkit/recurkit",
      ),
    ).toEqual({ type: "UNKNOWN" });
    expect(
      parseGithubActionsDispatchOutput(
        "token=secret-value\nhttps://github.com/recurkit/recurkit/actions/runs/not-a-number",
        "recurkit/recurkit",
      ),
    ).toEqual({ type: "UNKNOWN" });
  });

  it("maps only validated exact-run JSON to closed observations", () => {
    const identity = {
      repositorySlug: "recurkit/recurkit",
      commitSha: "a".repeat(40),
      runId: 12345,
    };
    expect(
      githubActionsObservationFromOutput(
        JSON.stringify({
          databaseId: 12345,
          status: "completed",
          conclusion: "success",
          headSha: "a".repeat(40),
          event: "workflow_dispatch",
          url: "https://github.com/recurkit/recurkit/actions/runs/12345",
        }),
        identity,
      ),
    ).toEqual({ type: "SUCCEEDED" });
    expect(
      githubActionsObservationFromOutput(
        JSON.stringify({
          databaseId: 12345,
          status: "in_progress",
          conclusion: "",
          headSha: "a".repeat(40),
          event: "workflow_dispatch",
          url: "https://github.com/recurkit/recurkit/actions/runs/12345",
        }),
        identity,
      ),
    ).toEqual({ type: "RUNNING" });
    expect(
      githubActionsObservationFromOutput(
        JSON.stringify({
          databaseId: 12345,
          status: "completed",
          conclusion: "cancelled",
          headSha: "a".repeat(40),
          event: "workflow_dispatch",
          url: "https://github.com/recurkit/recurkit/actions/runs/12345",
        }),
        identity,
      ),
    ).toEqual({ type: "FAILED", failureCode: "REMOTE_CANCELLED" });
    expect(
      githubActionsObservationFromOutput(
        JSON.stringify({
          databaseId: 12345,
          status: "completed",
          conclusion: "success",
          headSha: "b".repeat(40),
          event: "push",
          url: "https://github.com/other/repo/actions/runs/12345",
        }),
        identity,
      ),
    ).toEqual({ type: "UNKNOWN" });
    expect(githubActionsObservationFromOutput("{not-json", identity)).toEqual({ type: "UNKNOWN" });
  });
});
