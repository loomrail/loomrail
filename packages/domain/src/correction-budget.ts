import { MAX_AUTOMATIC_CORRECTION_RUNS, MAX_TOTAL_CORRECTION_RUNS } from "@loomrail/contracts";

export type CorrectionBudgetDecision =
  | { action: "START_AUTOMATIC"; position: number }
  | { action: "WAIT_FOR_OWNER"; position: number }
  | { action: "EXHAUSTED" };

export class CorrectionBudgetError extends Error {
  readonly code = "INVALID_USAGE" as const;

  constructor(message: string) {
    super(message);
    this.name = "CorrectionBudgetError";
  }
}

/** Selects a fix-cycle branch from delivery-wide usage, independent of evaluator identity. */
export const decideCorrectionBudget = (input: {
  automaticUsed: number;
  totalUsed: number;
}): CorrectionBudgetDecision => {
  const ownerAuthorizedUsed = input.totalUsed - input.automaticUsed;
  if (
    !Number.isInteger(input.automaticUsed) ||
    !Number.isInteger(input.totalUsed) ||
    input.automaticUsed < 0 ||
    input.totalUsed < input.automaticUsed ||
    input.automaticUsed > MAX_AUTOMATIC_CORRECTION_RUNS ||
    input.totalUsed > MAX_TOTAL_CORRECTION_RUNS ||
    ownerAuthorizedUsed > 1 ||
    (ownerAuthorizedUsed === 1 && input.automaticUsed !== MAX_AUTOMATIC_CORRECTION_RUNS)
  ) {
    throw new CorrectionBudgetError("Correction usage must stay within one delivery's fixed bounds");
  }
  if (
    input.automaticUsed < MAX_AUTOMATIC_CORRECTION_RUNS &&
    input.totalUsed < MAX_AUTOMATIC_CORRECTION_RUNS
  ) {
    return { action: "START_AUTOMATIC", position: input.totalUsed + 1 };
  }
  if (input.totalUsed < MAX_TOTAL_CORRECTION_RUNS) {
    return { action: "WAIT_FOR_OWNER", position: input.totalUsed + 1 };
  }
  return { action: "EXHAUSTED" };
};
