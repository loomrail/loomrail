import { reportingRuntimeSchema, type ReportingRuntime } from "@loomrail/contracts";

const operatingSystem = (value: string): ReportingRuntime["operatingSystem"] => {
  switch (value) {
    case "darwin":
      return "MACOS";
    case "win32":
      return "WINDOWS";
    case "linux":
      return "LINUX";
    default:
      return "OTHER";
  }
};

const architecture = (value: string): ReportingRuntime["architecture"] => {
  switch (value) {
    case "x64":
      return "X64";
    case "arm64":
      return "ARM64";
    default:
      return "OTHER";
  }
};

export const describeReportingRuntime = (input: {
  productVersion: string;
  platform?: string;
  architecture?: string;
  nodeVersion?: string;
}): ReportingRuntime => {
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  return reportingRuntimeSchema.parse({
    productVersion: input.productVersion,
    operatingSystem: operatingSystem(input.platform ?? process.platform),
    architecture: architecture(input.architecture ?? process.arch),
    nodeMajor,
  });
};
