import { describe, expect, it } from "vitest";

import {
  deliveryTemplate,
  nextWorkflowStage,
  validateWorkflowTemplate,
  WorkflowTemplateError,
} from "../src/index.js";

const minimalContextPack = {
  schemaVersion: 1,
  sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
};

describe("workflow template validation", () => {
  it("orders and advances the bounded delivery template", () => {
    expect(nextWorkflowStage(deliveryTemplate, "DISCOVERY")).toBe("PLAN");
    expect(nextWorkflowStage(deliveryTemplate, "PLAN")).toBe("IMPLEMENT");
    expect(nextWorkflowStage(deliveryTemplate, "IMPLEMENT")).toBe("REVIEW");
    expect(nextWorkflowStage(deliveryTemplate, "REVIEW")).toBe("QA");
    expect(nextWorkflowStage(deliveryTemplate, "QA")).toBe("ACCEPTANCE");
    expect(nextWorkflowStage(deliveryTemplate, "ACCEPTANCE")).toBeNull();
  });

  it("rejects duplicate and non-contiguous stages", () => {
    expect(() =>
      validateWorkflowTemplate({
        schemaVersion: 1,
        id: "invalid-template",
        version: 1,
        name: "Invalid",
        stages: [
          { stage: "PLAN", ordinal: 0, contextPack: minimalContextPack },
          { stage: "PLAN", ordinal: 2, contextPack: minimalContextPack },
        ],
      }),
    ).toThrow(WorkflowTemplateError);
  });
});
