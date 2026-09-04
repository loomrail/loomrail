import { createHash } from "node:crypto";

import {
  verificationPlanSchema,
  type VerificationPlan,
  type VerificationPlanProposal,
} from "@loomrail/contracts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

const withoutContentHash = (value: Omit<VerificationPlan, "contentHash"> | VerificationPlan): unknown =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== "contentHash"));

const withoutProposalHash = (
  value: Omit<VerificationPlanProposal, "proposalHash"> | VerificationPlanProposal,
): unknown => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "proposalHash"));

export const verificationPlanProposalHash = (
  value: Omit<VerificationPlanProposal, "proposalHash"> | VerificationPlanProposal,
): string =>
  createHash("sha256")
    .update(canonicalJson(withoutProposalHash(value)))
    .digest("hex");

export const verificationPlanContentHash = (
  value: Omit<VerificationPlan, "contentHash"> | VerificationPlan,
): string =>
  createHash("sha256")
    .update(canonicalJson(withoutContentHash(value)))
    .digest("hex");

export const verificationPlanFileContent = (plan: VerificationPlan): string => {
  const parsed = verificationPlanSchema.parse(plan);
  if (verificationPlanContentHash(parsed) !== parsed.contentHash) {
    throw new Error("Verification plan content hash mismatch");
  }
  return `${canonicalJson(parsed)}\n`;
};

export const parseMarkerBoundVerificationPlan = (content: string): VerificationPlan | null => {
  try {
    const parsed = verificationPlanSchema.parse(JSON.parse(content));
    if (verificationPlanContentHash(parsed) !== parsed.contentHash) return null;
    if (verificationPlanFileContent(parsed) !== content) return null;
    return parsed;
  } catch {
    return null;
  }
};
