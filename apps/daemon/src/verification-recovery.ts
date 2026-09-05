import { randomUUID } from "node:crypto";

import type { StateCommand } from "@loomrail/contracts";
import { removeVerificationProcessRecord } from "@loomrail/project-readiness";

export const VERIFICATION_RECONCILE_BATCH_SIZE = 1_000;

type ReconcileCommand = Extract<StateCommand, { type: "RECONCILE_WORKFLOWS" }>;

export const reconcileVerificationProcessProofs = async (input: {
  runIds: readonly string[];
  registryDirectory: string;
  execute: (command: ReconcileCommand) => void;
  createId?: () => string;
  removeRecord?: (registryDirectory: string, runId: string) => Promise<void>;
}): Promise<void> => {
  const createId = input.createId ?? randomUUID;
  const removeRecord = input.removeRecord ?? removeVerificationProcessRecord;
  const batches =
    input.runIds.length === 0
      ? [[]]
      : Array.from(
          { length: Math.ceil(input.runIds.length / VERIFICATION_RECONCILE_BATCH_SIZE) },
          (_, index) =>
            input.runIds.slice(
              index * VERIFICATION_RECONCILE_BATCH_SIZE,
              (index + 1) * VERIFICATION_RECONCILE_BATCH_SIZE,
            ),
        );

  for (const verificationProcessAuthorityReleasedRunIds of batches) {
    input.execute({
      schemaVersion: 1,
      commandId: `reconcile-${createId()}`,
      correlationId: `startup-${createId()}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: { verificationProcessAuthorityReleasedRunIds },
    });
    await Promise.all(
      verificationProcessAuthorityReleasedRunIds.map((runId) => removeRecord(input.registryDirectory, runId)),
    );
  }
};
