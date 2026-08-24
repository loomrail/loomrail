import { workflowTemplateSchema, type WorkflowStage, type WorkflowTemplate } from "@loomrail/contracts";

export class WorkflowTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowTemplateError";
  }
}

export const validateWorkflowTemplate = (input: unknown): WorkflowTemplate => {
  const template = workflowTemplateSchema.parse(input);
  const ordered = [...template.stages].sort((left, right) => left.ordinal - right.ordinal);
  const uniqueStages = new Set(ordered.map(({ stage }) => stage));
  const ordinalsAreContiguous = ordered.every(({ ordinal }, index) => ordinal === index);

  if (uniqueStages.size !== ordered.length) {
    throw new WorkflowTemplateError("A workflow template cannot contain the same stage twice");
  }
  if (!ordinalsAreContiguous) {
    throw new WorkflowTemplateError("Workflow stage ordinals must be contiguous and start at zero");
  }
  return { ...template, stages: ordered };
};

export const mockDeliveryTemplate = validateWorkflowTemplate({
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 1,
  name: "Mock delivery",
  stages: [
    { stage: "DISCOVERY", ordinal: 0 },
    { stage: "PLAN", ordinal: 1 },
    { stage: "IMPLEMENT", ordinal: 2 },
  ],
});

export const nextWorkflowStage = (
  template: WorkflowTemplate,
  currentStage: WorkflowStage,
): WorkflowStage | null => {
  const validated = validateWorkflowTemplate(template);
  const index = validated.stages.findIndex(({ stage }) => stage === currentStage);
  if (index < 0) throw new WorkflowTemplateError("The active stage is not part of the workflow template");
  return validated.stages[index + 1]?.stage ?? null;
};
