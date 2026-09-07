import type { SetupReadinessReport } from "./setup.js";

export const guidedBootstrapUrl = (bootstrapUrl: string): string => {
  const url = new URL(bootstrapUrl);
  url.pathname = "/try";
  return url.toString();
};

export const formatGuidedLaunchReadiness = (report: SetupReadinessReport): readonly string[] => {
  if (report.status === "BLOCKED") {
    return [
      "Loomrail guided demo: BLOCKED",
      "Nothing was started or written. Install, update, or sign in to a supported local agent CLI, then run `loomrail try` again.",
    ];
  }
  return [
    "Loomrail guided demo: READY",
    "Starting the local daemon and creating Loomrail-owned state and operational log files.",
    "The guided route uses the selected local CLI with hard time, turn, tool and output limits; token usage is reconciled after the session.",
  ];
};
