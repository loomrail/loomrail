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
      "Nothing was started or written. Resolve the Mock setup checks below, then run `loomrail try` again.",
    ];
  }
  return [
    "Loomrail guided demo: READY",
    "Starting the local daemon and creating Loomrail-owned state and operational log files.",
    "The guided route uses Mock: it starts no live provider process and consumes no provider quota.",
  ];
};
