import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@loomrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BROWSER_QA_CONFIG_RELATIVE_PATH, resolveProjectBrowserQAConfig } from "../src/browser-qa-config.js";

const config = {
  schemaVersion: 1,
  targetOrigin: "http://127.0.0.1:4173",
  revision: 3,
  targets: [
    {
      id: "desktop-light-en",
      viewport: { width: 1_280, height: 800 },
      locale: "en-US",
      theme: "LIGHT",
    },
  ],
  scenarios: [
    {
      id: "task-cockpit",
      title: "Task Cockpit opens",
      steps: [{ id: "open", title: "Open Task Cockpit", action: { type: "NAVIGATE", path: "/" } }],
      assertions: [
        {
          id: "no-overflow",
          title: "No horizontal overflow",
          rule: { type: "NO_HORIZONTAL_OVERFLOW" },
        },
      ],
    },
  ],
};

describe("project Browser QA configuration", () => {
  let repositoryPath = "";
  let project: Project;

  beforeEach(async () => {
    repositoryPath = await mkdtemp(join(tmpdir(), "loomrail browser qa config "));
    project = {
      schemaVersion: 1,
      id: "project-browser-qa",
      workspaceId: "workspace-local",
      fixtureId: null,
      name: "Browser QA project",
      repositoryPath,
      providerPreference: "AUTO",
      status: "ACTIVE",
      version: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
  });

  afterEach(async () => {
    await rm(repositoryPath, { recursive: true, force: true });
  });

  const writeConfig = async (value: unknown): Promise<void> => {
    const directory = join(repositoryPath, ".loomrail");
    await mkdir(directory, { recursive: true });
    await writeFile(join(repositoryPath, BROWSER_QA_CONFIG_RELATIVE_PATH), JSON.stringify(value));
  };

  it("loads a bounded declarative plan and derives its immutable hash", async () => {
    await writeConfig(config);

    const first = await resolveProjectBrowserQAConfig(project);
    const second = await resolveProjectBrowserQAConfig(project);

    expect(first).toMatchObject({
      status: "READY",
      targetOrigin: config.targetOrigin,
      plan: { revision: config.revision, targets: config.targets, scenarios: config.scenarios },
    });
    expect(first.plan.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.plan.contentHash).toBe(first.plan.contentHash);
  });

  it("returns a typed error instead of inventing a QA pass for missing or invalid config", async () => {
    await expect(resolveProjectBrowserQAConfig(project)).resolves.toMatchObject({
      status: "ERROR",
      error: { outcome: "ERROR", code: "EVIDENCE_INVALID" },
    });

    await writeConfig({ ...config, targetOrigin: "https://example.com" });
    await expect(resolveProjectBrowserQAConfig(project)).resolves.toMatchObject({
      status: "ERROR",
      error: { outcome: "ERROR", code: "EVIDENCE_INVALID" },
    });
  });

  it("refuses a symlinked config even when its target is valid", async () => {
    const outside = join(repositoryPath, "outside.json");
    await writeFile(outside, JSON.stringify(config));
    await mkdir(join(repositoryPath, ".loomrail"), { recursive: true });
    await symlink(outside, join(repositoryPath, BROWSER_QA_CONFIG_RELATIVE_PATH));

    await expect(resolveProjectBrowserQAConfig(project)).resolves.toMatchObject({
      status: "ERROR",
      error: { outcome: "ERROR", code: "EVIDENCE_INVALID" },
    });
  });
});
