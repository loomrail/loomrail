import { describe, expect, it } from "vitest";

import { verificationPlanProposalSchema, verificationRecipeSchema } from "../src/index.js";

const hash = "a".repeat(64);

const recipe = {
  schemaVersion: 1,
  id: "package-test",
  kind: "UNIT",
  label: "Package tests",
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
    manifestContentHash: hash,
    scriptName: "test",
    scriptBodyPreview: "vitest run",
  },
} as const;

describe("project verification contract", () => {
  it("accepts a bounded no-shell package script proposal", () => {
    const proposal = {
      schemaVersion: 1,
      projectId: "project-1",
      target: { state: "ABSENT", digest: null },
      recipes: [recipe],
      warnings: [],
      proposalHash: "b".repeat(64),
    };

    expect(verificationPlanProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it.each([
    { ...recipe, executable: "./node_modules/.bin/vitest" },
    { ...recipe, executable: "sh", argv: ["-c", "vitest run"] },
    { ...recipe, argv: [] },
    { ...recipe, argv: ["run", "test\u0000--watch"] },
    { ...recipe, cwd: "../outside" },
    { ...recipe, cwd: "/private/project" },
    { ...recipe, timeoutSeconds: 901 },
    { ...recipe, outputLimitBytes: 262_145 },
    { ...recipe, secretEnvironment: { TOKEN: "secret" } },
  ])("rejects an authority-expanding recipe", (candidate) => {
    expect(verificationRecipeSchema.safeParse(candidate).success).toBe(false);
  });

  it("requires a unique id and at least one required recipe", () => {
    const proposal = {
      schemaVersion: 1,
      projectId: "project-1",
      target: { state: "ABSENT", digest: null },
      recipes: [{ ...recipe, required: false }],
      warnings: [],
      proposalHash: "b".repeat(64),
    };

    expect(verificationPlanProposalSchema.safeParse(proposal).success).toBe(false);
    expect(
      verificationPlanProposalSchema.safeParse({
        ...proposal,
        recipes: [recipe, recipe],
      }).success,
    ).toBe(false);
  });

  it("allows an inert warning-only proposal when no safe recipe was discovered", () => {
    const proposal = {
      schemaVersion: 1,
      projectId: "project-1",
      target: { state: "BLOCKED", digest: null },
      recipes: [],
      warnings: [
        {
          code: "MANIFEST_SYMLINK",
          path: "package.json",
          message: "The manifest is not a regular file.",
        },
      ],
      proposalHash: "b".repeat(64),
    };

    expect(verificationPlanProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it("rejects an ambiguous target state before owner adoption", () => {
    expect(
      verificationPlanProposalSchema.safeParse({
        schemaVersion: 1,
        projectId: "project-1",
        target: { state: "PRESENT", digest: null },
        recipes: [recipe],
        warnings: [],
        proposalHash: "b".repeat(64),
      }).success,
    ).toBe(false);
  });
});
