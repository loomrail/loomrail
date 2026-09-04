import { z } from "zod";
import { describe, expect, it } from "vitest";

import { decodeProviderStageResult, providerStageResultSchemaFor } from "../src/index.js";

const checkpoint = {
  type: "COMPLETED" as const,
  summary: "The stage completed.",
  completed: ["One bounded change"],
  remaining: [],
  deadEnds: [],
  openQuestions: [],
};

const acceptanceCriterion = {
  criterion: "The retry policy is verified.",
  implementation: "The bounded retry policy was implemented.",
  reviewCheck: "Policy reviewed",
  qaCheck: "Retry scenario passed",
  ownerVerification: "Inspect the recorded retry evidence.",
  knownRisk: null,
};

const expectEveryObjectFieldRequired = (candidate: unknown): void => {
  if (Array.isArray(candidate)) {
    for (const entry of candidate) expectEveryObjectFieldRequired(entry);
    return;
  }
  if (typeof candidate !== "object" || candidate === null) return;

  const schema = candidate as Record<string, unknown>;
  const properties = schema["properties"];
  if (schema["type"] === "object" && typeof properties === "object" && properties !== null) {
    expect(schema["additionalProperties"]).toBe(false);
    expect([...(schema["required"] as string[])].sort()).toEqual(
      Object.keys(properties as Record<string, unknown>).sort(),
    );
  }
  for (const value of Object.values(schema)) expectEveryObjectFieldRequired(value);
};

describe("provider stage result contract", () => {
  it("turns a Review completion into its typed evidence outcome", () => {
    const decoded = decodeProviderStageResult("REVIEW", {
      result: {
        ...checkpoint,
        artifact: {
          kind: "REVIEW_REPORT",
          title: "Independent review",
          summary: "No blocking findings remain.",
          checks: ["Acceptance criteria traced"],
          verdict: "PASSED",
          findings: [],
        },
      },
    });

    expect(decoded).toMatchObject({
      checkpoint: { summary: "The stage completed." },
      outcome: {
        type: "COMPLETED",
        artifacts: [{ kind: "REVIEW_REPORT" }],
        reviewReport: { verdict: "PASSED", findings: [] },
      },
    });
  });

  it("rejects a QA report offered as Review evidence", () => {
    expect(
      decodeProviderStageResult("REVIEW", {
        result: {
          ...checkpoint,
          artifact: {
            kind: "QA_REPORT",
            title: "Wrong report",
            summary: "This belongs to QA.",
            checks: ["A check"],
          },
        },
      }),
    ).toBeNull();
  });

  it("does not allow ordinary completion to bypass Acceptance", () => {
    expect(decodeProviderStageResult("ACCEPTANCE", checkpoint)).toBeNull();
    expect(
      decodeProviderStageResult("ACCEPTANCE", {
        result: {
          type: "READY_FOR_ACCEPTANCE",
          releaseNote: "The bounded change is ready for owner review.",
          verifyInstructions: ["Run the repository test."],
          criteria: [acceptanceCriterion],
        },
      }),
    ).toEqual({
      checkpoint: null,
      outcome: {
        type: "READY_FOR_ACCEPTANCE",
        releaseNote: "The bounded change is ready for owner review.",
        verifyInstructions: ["Run the repository test."],
        criteria: [acceptanceCriterion],
      },
    });
  });

  it("reads a historical bare checkpoint only where typed evidence is not required", () => {
    const historical = { ...checkpoint };
    Reflect.deleteProperty(historical, "type");
    expect(decodeProviderStageResult("DISCOVERY", historical)).toMatchObject({
      outcome: { type: "COMPLETED" },
    });
    expect(decodeProviderStageResult("REVIEW", historical)).toBeNull();
    expect(decodeProviderStageResult("QA", historical)).toBeNull();
    expect(decodeProviderStageResult("ACCEPTANCE", historical)).toBeNull();
  });

  it("allows a blocking owner question without inventing a checkpoint", () => {
    const decoded = decodeProviderStageResult("PLAN", {
      result: {
        type: "NEEDS_HUMAN",
        request: {
          kind: "CONFIRMATION",
          blocking: true,
          title: "Confirm the compatibility target",
          context: "Two incompatible targets are documented.",
          recommendation: "Keep the currently tested target.",
          options: [
            {
              id: "keep-target",
              label: "Keep the tested target",
              consequence: "Continue against the target already covered by tests.",
              recommended: true,
            },
          ],
          allowOther: true,
        },
      },
    });
    expect(decoded).toMatchObject({ checkpoint: null, outcome: { type: "NEEDS_HUMAN" } });
  });

  it("keeps schemas strict and stage-specific when converted for a CLI", () => {
    expect(() =>
      providerStageResultSchemaFor("QA").parse({
        transcript: "must not cross the boundary",
        result: {
          ...checkpoint,
          artifact: {
            kind: "QA_REPORT",
            title: "QA",
            summary: "Checks passed.",
            checks: ["Test passed"],
          },
        },
      }),
    ).toThrow();
  });

  it("emits a Structured Outputs-compatible object root with a nested anyOf", () => {
    for (const stage of ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"] as const) {
      const jsonSchema = z.toJSONSchema(providerStageResultSchemaFor(stage)) as Record<string, unknown>;
      expect(jsonSchema["type"], stage).toBe("object");
      expect(jsonSchema["required"], stage).toEqual(["result"]);
      expect(jsonSchema["additionalProperties"], stage).toBe(false);
      expect(jsonSchema, stage).not.toHaveProperty("anyOf");
      expect(jsonSchema, stage).not.toHaveProperty("oneOf");

      const properties = jsonSchema["properties"] as Record<string, Record<string, unknown>>;
      expect(properties["result"]?.["anyOf"], stage).toBeInstanceOf(Array);
      expect(JSON.stringify(jsonSchema), stage).not.toContain('"oneOf"');
      expectEveryObjectFieldRequired(jsonSchema);
    }
  });

  it("expresses Review verdict and finding cardinality in the provider JSON Schema", () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(providerStageResultSchemaFor("REVIEW")));

    expect(jsonSchema).toContain('"const":"PASSED"');
    expect(jsonSchema).toContain('"maxItems":0');
    expect(jsonSchema).toContain('"const":"CHANGES_REQUESTED"');
    expect(jsonSchema).toContain('"minItems":1');
  });

  it("keeps Review findings scoped to work that exists before downstream gates", () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(providerStageResultSchemaFor("REVIEW")));

    expect(jsonSchema).toContain("Do not require evidence produced by later workflow stages");
    expect(jsonSchema).toContain("Browser QA");
    expect(jsonSchema).toContain("owner acceptance");
  });

  it("tells every provider stage not to invent approval or handoff gates", () => {
    for (const stage of ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"] as const) {
      const jsonSchema = JSON.stringify(z.toJSONSchema(providerStageResultSchemaFor(stage)));

      expect(jsonSchema, stage).toContain("Never ask for permission to proceed");
      expect(jsonSchema, stage).toContain("stage handoff");
      expect(jsonSchema, stage).toContain("confirmation of an existing Decision");
      expect(jsonSchema, stage).toContain("Loomrail owns stage transitions and the acceptance gate");
      expect(jsonSchema, stage).toContain("Never use this result for a progress update");
      expect(jsonSchema, stage).toContain("If no owner input is needed, this result is invalid");
      expect(jsonSchema, stage).toContain("Do not return until the current stage is complete");
    }
  });

  it("puts the normal stage result before the exceptional human-request branch", () => {
    const normalResultType = {
      DISCOVERY: "COMPLETED",
      PLAN: "COMPLETED",
      IMPLEMENT: "COMPLETED",
      REVIEW: "COMPLETED",
      QA: "COMPLETED",
      ACCEPTANCE: "READY_FOR_ACCEPTANCE",
    } as const;

    for (const stage of ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"] as const) {
      const jsonSchema = z.toJSONSchema(providerStageResultSchemaFor(stage)) as Record<string, unknown>;
      const properties = jsonSchema["properties"] as Record<string, Record<string, unknown>>;
      const branches = properties["result"]?.["anyOf"] as Record<string, unknown>[];
      const resultTypes = branches.map((branch) => {
        const branchProperties = branch["properties"] as Record<string, Record<string, unknown>>;
        return branchProperties["type"]?.["const"];
      });

      expect(resultTypes, stage).toEqual([normalResultType[stage], "NEEDS_HUMAN"]);
    }
  });

  it("removes the human-request branch when a resumed attempt has already used its owner gate", () => {
    const schema = providerStageResultSchemaFor("DISCOVERY", { humanRequests: "DISALLOWED" });

    expect(
      schema.safeParse({
        result: {
          type: "NEEDS_HUMAN",
          request: {
            kind: "SINGLE_CHOICE",
            blocking: true,
            title: "Ask again",
            context: "The same resumed attempt asks for another owner answer.",
            recommendation: "Repeat the existing choice.",
            options: [
              {
                id: "repeat",
                label: "Repeat",
                consequence: "The duplicate gate remains open.",
                recommended: true,
              },
            ],
            allowOther: false,
          },
        },
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ result: checkpoint }).success).toBe(true);
  });

  it("rejects a second owner question at decode time even if a provider ignores its schema", () => {
    expect(
      decodeProviderStageResult(
        "DISCOVERY",
        {
          result: {
            type: "NEEDS_HUMAN",
            request: {
              kind: "FREE_TEXT",
              blocking: true,
              title: "Ask twice",
              context: "The output ignored the schema used for this resumed attempt.",
              recommendation: "Do not advance on an invalid result.",
              options: [],
              allowOther: true,
            },
          },
        },
        { humanRequests: "DISALLOWED" },
      ),
    ).toBeNull();
  });

  it("keeps the owner-only Acceptance result available after an earlier owner gate", () => {
    expect(
      decodeProviderStageResult(
        "ACCEPTANCE",
        {
          result: {
            type: "READY_FOR_ACCEPTANCE",
            releaseNote: "The delivery is ready for its separate owner acceptance gate.",
            verifyInstructions: ["Inspect the recorded evidence."],
            criteria: [acceptanceCriterion],
          },
        },
        { humanRequests: "DISALLOWED" },
      ),
    ).toMatchObject({ outcome: { type: "READY_FOR_ACCEPTANCE" } });
  });
});
