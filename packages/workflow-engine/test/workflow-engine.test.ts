import { describe, expect, it } from "vitest";

import {
  mockDeliveryTemplate,
  nextWorkflowStage,
  validateWorkflowTemplate,
  WorkflowTemplateError,
} from "../src/index.js";

describe("workflow template validation", () => {
  it("orders and advances the bounded mock template", () => {
    expect(nextWorkflowStage(mockDeliveryTemplate, "DISCOVERY")).toBe("PLAN");
    expect(nextWorkflowStage(mockDeliveryTemplate, "PLAN")).toBe("IMPLEMENT");
    expect(nextWorkflowStage(mockDeliveryTemplate, "IMPLEMENT")).toBe("REVIEW");
    expect(nextWorkflowStage(mockDeliveryTemplate, "REVIEW")).toBe("QA");
    expect(nextWorkflowStage(mockDeliveryTemplate, "QA")).toBe("ACCEPTANCE");
    expect(nextWorkflowStage(mockDeliveryTemplate, "ACCEPTANCE")).toBeNull();
  });

  it("rejects duplicate and non-contiguous stages", () => {
    expect(() =>
      validateWorkflowTemplate({
        schemaVersion: 1,
        id: "invalid-template",
        version: 1,
        name: "Invalid",
        stages: [
          { stage: "PLAN", ordinal: 0 },
          { stage: "PLAN", ordinal: 2 },
        ],
      }),
    ).toThrow(WorkflowTemplateError);
  });
});
