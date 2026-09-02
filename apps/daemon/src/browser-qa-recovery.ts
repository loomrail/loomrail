import {
  recoverBrowserQAArtifacts,
  type BrowserQAArtifactRecovery,
  type BrowserQARecoveryMarker,
} from "@loomrail/browser-qa";
import type { QAAttachmentRef } from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";
import type { FastifyBaseLogger } from "fastify";

const sameAttachment = (expected: QAAttachmentRef, actual: QAAttachmentRef): boolean =>
  expected.id === actual.id &&
  expected.qaRunId === actual.qaRunId &&
  expected.kind === actual.kind &&
  expected.contentHash === actual.contentHash &&
  expected.byteSize === actual.byteSize &&
  expected.targetId === actual.targetId &&
  expected.scenarioId === actual.scenarioId &&
  expected.capturedAt === actual.capturedAt &&
  expected.storageKey === actual.storageKey;

const markerWasCommitted = (state: LocalState, marker: BrowserQARecoveryMarker): boolean => {
  const runResult = state.query({ type: "GET_QA_RUN", qaRunId: marker.qaRunId });
  if (runResult.type !== "QA_RUN" || runResult.qaRun === null || runResult.qaRun.status === "RUNNING") {
    return false;
  }
  const qaState = state.query({ type: "GET_QA_STATE", pipelineRunId: runResult.qaRun.pipelineRunId });
  if (qaState.type !== "QA_STATE") return false;
  const persisted = qaState.attachments.filter(({ qaRunId }) => qaRunId === marker.qaRunId);
  if (persisted.length !== marker.attachments.length) return false;
  return marker.attachments.every(({ ref }) =>
    persisted.some((attachment) => sameAttachment(ref, attachment)),
  );
};

export const reconcileBrowserQAArtifacts = async (input: {
  state: LocalState;
  artifactsDirectory: string;
  logger: FastifyBaseLogger;
}): Promise<void> => {
  let recoveries: BrowserQAArtifactRecovery[];
  try {
    recoveries = await recoverBrowserQAArtifacts({
      artifactsDirectory: input.artifactsDirectory,
      isCommitted: (marker) => markerWasCommitted(input.state, marker),
    });
  } catch (error: unknown) {
    input.logger.error(
      { error: error instanceof Error ? error.name : "unknown" },
      "Browser QA attachment recovery could not inspect its local artifact directory",
    );
    return;
  }
  for (const recovery of recoveries) {
    const details = {
      qaRunId: recovery.qaRunId,
      runStorageSegment: recovery.runStorageSegment,
      action: recovery.action,
    };
    if (recovery.action === "CONFIRMED") {
      input.logger.info(details, "Confirmed Browser QA attachments after restart");
    } else if (recovery.action === "LEFT_PENDING") {
      input.logger.error(details, "Browser QA attachment recovery remains pending");
    } else {
      input.logger.warn(details, "Quarantined Browser QA attachments that are not valid evidence");
    }
  }
};
