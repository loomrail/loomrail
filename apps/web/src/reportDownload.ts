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
  // Revoking in the same task as the synthetic click races the download navigation: Firefox and
  // WebKit resolve the `blob:` URL asynchronously and report "file not found" when it is already
  // gone. Deferring the revoke keeps the object alive until the browser has taken the request.
  setTimeout(() => {
    URL.revokeObjectURL(href);
  }, 1_000);
};
