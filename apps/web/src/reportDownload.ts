import { anonymousReportSchema, type AnonymousReport } from "@loomrail/contracts";

export const serializeAnonymousReport = (report: AnonymousReport): string =>
  `${JSON.stringify(anonymousReportSchema.parse(report), null, 2)}\n`;

export const downloadAnonymousReport = (report: AnonymousReport): void => {
  const filename =
    report.kind === "AGGREGATE" ? "loomrail-aggregate-report.json" : "loomrail-crash-report.json";
  const href = URL.createObjectURL(
    new Blob([serializeAnonymousReport(report)], { type: "application/json;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = href;
  anchor.click();
  URL.revokeObjectURL(href);
};
