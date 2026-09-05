import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerificationPlanSettingsResponse } from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { VerificationPlanSettingsView } from "./VerificationPlanSettingsPanel";

const proposal: VerificationPlanSettingsResponse["proposal"] = {
  schemaVersion: 1,
  projectId: "project-web",
  target: { state: "ABSENT", digest: null },
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
        scriptBodyPreview: "vitest run --coverage",
      },
    },
  ],
  warnings: [],
  proposalHash: "b".repeat(64),
};

const settings: VerificationPlanSettingsResponse = {
  schemaVersion: 1,
  projectId: proposal.projectId,
  projectVersion: 4,
  proposal,
  plan: null,
  publication: null,
};

const renderView = (snapshot: VerificationPlanSettingsResponse = settings): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <VerificationPlanSettingsView
        adopting={false}
        disabling={false}
        onAdopt={vi.fn()}
        onDisable={vi.fn()}
        onRetry={vi.fn()}
        retrying={false}
        settings={snapshot}
      />
    </I18nProvider>,
  );

describe("VerificationPlanSettingsView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("shows exact argv boundaries and all execution policy before owner adoption", () => {
    const html = renderView();

    expect(html).toContain("Project checks");
    expect(html).toContain("Required");
    expect(html).toContain("pnpm");
    expect(html).toContain("run");
    expect(html).toContain("test");
    expect(html).toContain("vitest run --coverage");
    expect(html).toContain("Project root");
    expect(html).toContain("5 min");
    expect(html).toContain("64 KiB");
    expect(html).toContain("Host network");
    expect(html).toContain("Minimal runtime path");
    expect(html).toContain("Runs as your local user");
    expect(html).toContain("not a security sandbox");
    expect(html).toContain("Approve Plan · required checks: 1");
    expect(html).not.toContain('tabindex="-1"');
  });

  it("refuses approval when the target is blocked and explains the owner-visible reason", () => {
    const html = renderView({
      ...settings,
      proposal: {
        ...proposal,
        target: { state: "BLOCKED", digest: null },
        warnings: [
          {
            code: "PLAN_TARGET_BLOCKED",
            path: ".loomrail/verification-plan.json",
            message: "An unknown owner file is present.",
          },
        ],
      },
    });

    expect(html).toContain("An unknown owner file is present.");
    expect(html).toContain("Resolve the existing .loomrail target before approval.");
    expect(html).toContain("disabled");
  });

  it("shows a durable applied revision without offering a duplicate approval", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "verification-plan-1",
      projectId: proposal.projectId,
      revision: 1,
      status: "ACTIVE" as const,
      recipes: proposal.recipes,
      sourceProposalHash: proposal.proposalHash,
      contentHash: "c".repeat(64),
      createdAt: "2026-09-05T10:00:00.000Z",
    };
    const html = renderView({
      ...settings,
      plan,
      publication: {
        schemaVersion: 1,
        id: "verification-publication-1",
        projectId: proposal.projectId,
        planId: plan.id,
        targetPath: ".loomrail/verification-plan.json",
        expectedTargetDigest: null,
        contentHash: plan.contentHash,
        status: "APPLIED",
        attempts: 1,
        lastErrorCode: null,
        version: 2,
        createdAt: plan.createdAt,
        updatedAt: "2026-09-05T10:00:01.000Z",
        appliedAt: "2026-09-05T10:00:01.000Z",
      },
    });

    expect(html).toContain("Active revision 1");
    expect(html).toContain("Published to .loomrail/verification-plan.json");
    expect(html).toContain("Disable Plan");
    expect(html).not.toContain("Approve Plan · required checks: 1");
  });

  it("makes a disabled immutable revision explicit and offers a reviewed re-enable action", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "verification-plan-2",
      projectId: proposal.projectId,
      revision: 2,
      status: "DISABLED" as const,
      recipes: proposal.recipes,
      sourceProposalHash: proposal.proposalHash,
      contentHash: "d".repeat(64),
      createdAt: "2026-09-05T10:05:00.000Z",
    };
    const html = renderView({
      ...settings,
      projectVersion: 5,
      plan,
      publication: {
        schemaVersion: 1,
        id: "verification-publication-2",
        projectId: proposal.projectId,
        planId: plan.id,
        targetPath: ".loomrail/verification-plan.json",
        expectedTargetDigest: "c".repeat(64),
        contentHash: plan.contentHash,
        status: "APPLIED",
        attempts: 1,
        lastErrorCode: null,
        version: 2,
        createdAt: plan.createdAt,
        updatedAt: "2026-09-05T10:05:01.000Z",
        appliedAt: "2026-09-05T10:05:01.000Z",
      },
    });

    expect(html).toContain("Disabled revision 2");
    expect(html).toContain("Enable Plan · required checks: 1");
    expect(html).not.toContain("Disable Plan");
  });

  it("keeps Disable available when the current manifest proposes a replacement", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "verification-plan-1",
      projectId: proposal.projectId,
      revision: 1,
      status: "ACTIVE" as const,
      recipes: proposal.recipes,
      sourceProposalHash: proposal.proposalHash,
      contentHash: "c".repeat(64),
      createdAt: "2026-09-05T10:00:00.000Z",
    };
    const html = renderView({
      ...settings,
      proposal: {
        ...proposal,
        recipes: [{ ...proposal.recipes[0]!, label: "Changed test command" }],
        proposalHash: "d".repeat(64),
      },
      plan,
      publication: {
        schemaVersion: 1,
        id: "verification-publication-1",
        projectId: proposal.projectId,
        planId: plan.id,
        targetPath: ".loomrail/verification-plan.json",
        expectedTargetDigest: null,
        contentHash: plan.contentHash,
        status: "APPLIED",
        attempts: 1,
        lastErrorCode: null,
        version: 2,
        createdAt: plan.createdAt,
        updatedAt: "2026-09-05T10:00:01.000Z",
        appliedAt: "2026-09-05T10:00:01.000Z",
      },
    });

    expect(html).toContain("Approve replacement · required checks: 1");
    expect(html).toContain("Disable Plan");
  });

  it("keeps a failed publication explicit and exposes a native retry button", () => {
    const activeHtml = renderView({
      ...settings,
      plan: {
        schemaVersion: 1,
        id: "verification-plan-1",
        projectId: proposal.projectId,
        revision: 1,
        status: "ACTIVE",
        recipes: proposal.recipes,
        sourceProposalHash: proposal.proposalHash,
        contentHash: "c".repeat(64),
        createdAt: "2026-09-05T10:00:00.000Z",
      },
      publication: {
        schemaVersion: 1,
        id: "verification-publication-1",
        projectId: proposal.projectId,
        planId: "verification-plan-1",
        targetPath: ".loomrail/verification-plan.json",
        expectedTargetDigest: null,
        contentHash: "c".repeat(64),
        status: "FAILED",
        attempts: 1,
        lastErrorCode: "WRITE_FAILED",
        version: 2,
        createdAt: "2026-09-05T10:00:00.000Z",
        updatedAt: "2026-09-05T10:00:01.000Z",
        appliedAt: null,
      },
    });

    expect(activeHtml).toContain("Plan file was not published");
    expect(activeHtml).toContain("WRITE_FAILED");
    expect(activeHtml).toContain("Retry publication");
    expect(activeHtml).toMatch(/<button[^>]*type="button"/);
  });
});
