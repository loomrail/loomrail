import {
  contextPackSpecSchema,
  workflowTemplateSchema,
  type ContextPackSpec,
  type WorkflowStage,
  type WorkflowTemplate,
} from "@loomrail/contracts";

export class WorkflowTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowTemplateError";
  }
}

export class ContextPackSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextPackSpecError";
  }
}

export const validateContextPackSpec = (input: unknown): ContextPackSpec => {
  const spec = contextPackSpecSchema.parse(input);
  const ordered = [...spec.sections].sort((left, right) => left.ordinal - right.ordinal);

  if (new Set(ordered.map(({ id }) => id)).size !== ordered.length) {
    throw new ContextPackSpecError("A context pack spec cannot declare the same section twice");
  }
  if (!ordered.every(({ ordinal }, index) => ordinal === index)) {
    throw new ContextPackSpecError("Context pack ordinals must be contiguous and start at zero");
  }
  if (!ordered.some(({ required }) => required)) {
    throw new ContextPackSpecError("A context pack spec must declare at least one required section");
  }
  return { ...spec, sections: ordered };
};

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
  const stagesWithValidatedContextPacks = ordered.map((stage) => ({
    ...stage,
    contextPack: validateContextPackSpec(stage.contextPack),
  }));
  return { ...template, stages: stagesWithValidatedContextPacks };
};

const coreSections = [
  { id: "WORK_ITEM_BRIEF", ordinal: 0, required: true },
  { id: "WORKFLOW_POSITION", ordinal: 1, required: true },
  { id: "DECISIONS", ordinal: 2, required: true },
  { id: "LATEST_CHECKPOINT", ordinal: 3, required: true },
] as const;

// DISCOVERY and PLAN run before any evidence artifact exists, so their context packs have no
// EVIDENCE section at all.
const contextPackWithoutEvidence: ContextPackSpec = {
  schemaVersion: 1,
  sections: [...coreSections, { id: "ACTIVITY", ordinal: 4, required: false }],
};

// IMPLEMENT, REVIEW, and QA may have accumulated evidence from an earlier pass through the
// workflow (or none yet), so EVIDENCE is present but optional.
const contextPackWithOptionalEvidence: ContextPackSpec = {
  schemaVersion: 1,
  sections: [
    ...coreSections,
    { id: "EVIDENCE", ordinal: 4, required: false },
    { id: "ACTIVITY", ordinal: 5, required: false },
  ],
};

const contextPackForReview: ContextPackSpec = {
  schemaVersion: 1,
  sections: [
    ...coreSections,
    { id: "REVIEW_INPUT", ordinal: 4, required: true },
    { id: "EVIDENCE", ordinal: 5, required: false },
    { id: "ACTIVITY", ordinal: 6, required: false },
  ],
};

// ACCEPTANCE has nothing to accept without evidence, so EVIDENCE is required.
const contextPackWithRequiredEvidence: ContextPackSpec = {
  schemaVersion: 1,
  sections: [
    ...coreSections,
    { id: "EVIDENCE", ordinal: 4, required: true },
    { id: "ACTIVITY", ordinal: 5, required: false },
  ],
};

export const mockDeliveryTemplate = validateWorkflowTemplate({
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 4,
  name: "Mock delivery",
  stages: [
    { stage: "DISCOVERY", ordinal: 0, contextPack: contextPackWithoutEvidence },
    { stage: "PLAN", ordinal: 1, contextPack: contextPackWithoutEvidence },
    { stage: "IMPLEMENT", ordinal: 2, contextPack: contextPackWithOptionalEvidence },
    { stage: "REVIEW", ordinal: 3, contextPack: contextPackForReview },
    { stage: "QA", ordinal: 4, contextPack: contextPackWithOptionalEvidence },
    { stage: "ACCEPTANCE", ordinal: 5, contextPack: contextPackWithRequiredEvidence },
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
