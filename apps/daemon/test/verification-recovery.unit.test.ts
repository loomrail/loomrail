import { describe, expect, it } from "vitest";

import {
  reconcileVerificationProcessProofs,
  VERIFICATION_RECONCILE_BATCH_SIZE,
} from "../src/verification-recovery.js";

describe("verification startup recovery handoff", () => {
  it("commits bounded reconcile batches before removing each batch of process proofs", async () => {
    const runIds = Array.from(
      { length: VERIFICATION_RECONCILE_BATCH_SIZE + 1 },
      (_, index) => `verification-run-${index.toString().padStart(4, "0")}`,
    );
    const batchSizes: number[] = [];
    const events: string[] = [];
    let id = 0;

    await reconcileVerificationProcessProofs({
      runIds,
      registryDirectory: "/synthetic/processes",
      createId: () => (id++).toString(),
      execute: (command) => {
        const size = command.payload.verificationProcessAuthorityReleasedRunIds?.length ?? 0;
        batchSizes.push(size);
        events.push(`commit:${size.toString()}`);
      },
      removeRecord: (_registryDirectory, runId) => {
        events.push(`remove:${runId}`);
        return Promise.resolve();
      },
    });

    expect(batchSizes).toEqual([VERIFICATION_RECONCILE_BATCH_SIZE, 1]);
    expect(events[0]).toBe(`commit:${VERIFICATION_RECONCILE_BATCH_SIZE.toString()}`);
    expect(events[VERIFICATION_RECONCILE_BATCH_SIZE + 1]).toBe("commit:1");
    const lastRunId = runIds.at(-1);
    if (lastRunId === undefined) throw new Error("Expected the final verification Run");
    expect(events.at(-1)).toBe(`remove:${lastRunId}`);
  });

  it("retains every process proof when the SQLite reconcile transaction fails", async () => {
    const removed: string[] = [];

    await expect(
      reconcileVerificationProcessProofs({
        runIds: ["verification-run-one"],
        registryDirectory: "/synthetic/processes",
        createId: () => "fixed",
        execute: () => {
          throw new Error("synthetic SQLite failure");
        },
        removeRecord: (_registryDirectory, runId) => {
          removed.push(runId);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("synthetic SQLite failure");
    expect(removed).toEqual([]);
  });
});
