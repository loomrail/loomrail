import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerificationPlan, VerificationRunSnapshotResponse } from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { ProjectVerificationView } from "./ProjectVerificationPanel";

const plan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-1",
  projectId: "project-1",
  revision: 2,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "package-test",
      kind: "UNIT",
      label: "Unit tests",
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
  createdAt: "2026-09-05T10:00:00.000Z",
};

const snapshot = (
  overrides: Partial<VerificationRunSnapshotResponse> = {},
): VerificationRunSnapshotResponse => ({
  schemaVersion: 1,
  plan,
  run: {
    schemaVersion: 1,
    id: "verification-run-1",
    projectId: plan.projectId,
    workItemId: "work-item-1",
    pipelineRunId: "pipeline-run-1",
    workspaceId: "workspace-1",
    planId: plan.id,
    planRevision: plan.revision,
    planContentHash: plan.contentHash,
    implementationTree: "d".repeat(40),
    ordinal: 1,
    retryOfRunId: null,
    platform: "darwin",
    status: "PASSED",
    currentCheckId: null,
    terminalReason: "ALL_REQUIRED_PASSED",
    startedAt: "2026-09-05T10:01:00.000Z",
    completedAt: "2026-09-05T10:01:01.250Z",
    createdAt: "2026-09-05T10:01:00.000Z",
    version: 3,
  },
  checks: [
    {
      schemaVersion: 1,
      id: "verification-check-1",
      projectId: plan.projectId,
      workItemId: "work-item-1",
      runId: "verification-run-1",
      recipeId: "package-test",
      ordinal: 1,
      required: true,
      status: "PASSED",
      startedAt: "2026-09-05T10:01:00.000Z",
      completedAt: "2026-09-05T10:01:01.250Z",
      durationMs: 1_250,
      exitCode: 0,
      signal: null,
      errorCode: null,
      output: {
        schemaVersion: 1,
        artifactId: "verification-output-1",
        sha256: "e".repeat(64),
        capturedBytes: 16,
        stdoutBytes: 16,
        stderrBytes: 0,
        truncated: false,
        available: true,
      },
      version: 3,
    },
  ],
  freshness: "CURRENT",
  staleReasons: [],
  ...overrides,
});

const renderView = (overrides: Partial<Parameters<typeof ProjectVerificationView>[0]> = {}): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <ProjectVerificationView
        actionPending={false}
        availability="READY"
        currentPlan={plan}
        loadError={null}
        loading={false}
        onCancel={vi.fn()}
        onRetryLoad={vi.fn()}
        onRun={vi.fn()}
        onToggleOutput={vi.fn()}
        operationError={null}
        output={{ checkId: null, error: null, pending: false, text: undefined }}
        runs={[]}
        {...overrides}
      />
    </I18nProvider>,
  );

describe("ProjectVerificationView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("shows the exact approved command and one clear first-run action", () => {
    const html = renderView();

    expect(html).toContain("Project verification");
    expect(html).toContain("Unit tests");
    expect(html).toContain("Required · UNIT");
    expect(html).toContain("pnpm");
    expect(html).toContain("run");
    expect(html).toContain("test");
    expect(html).toContain("Not run");
    expect(html).toContain("Run checks");
    expect(html).not.toContain("Cancel run");
  });

  it("shows measured current evidence and escapes output as text", () => {
    const html = renderView({
      output: {
        checkId: "verification-check-1",
        error: null,
        pending: false,
        text: "<script>window.mustNotRun = true</script>",
      },
      runs: [snapshot()],
    });

    expect(html).toContain("Passed");
    expect(html).toContain("Run 1 · Plan r2 · macOS");
    expect(html).toContain("1.3 s · exit 0");
    expect(html).toContain("All required checks passed for the current code and Plan.");
    expect(html).toContain("Run again");
    expect(html).toContain("&lt;script&gt;window.mustNotRun = true&lt;/script&gt;");
    expect(html).not.toContain("<script>window.mustNotRun = true</script>");
  });

  it("makes stale evidence and the reason explicit instead of presenting it as passed", () => {
    const stale = snapshot({ freshness: "STALE", staleReasons: ["TREE_CHANGED"] });
    const html = renderView({ runs: [stale, snapshot()] });

    expect(html).toContain("Stale");
    expect(html).toContain("the worktree changed");
    expect(html).toContain("Earlier runs (1)");
  });

  it("explains a missing owner Plan without rendering a dead action", () => {
    const html = renderView({ availability: "PLAN_REQUIRED", currentPlan: null });

    expect(html).toContain("Approve and publish Project checks in Settings");
    expect(html).not.toContain("Run checks");
  });
});
