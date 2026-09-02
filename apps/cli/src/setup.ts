import { stat } from "node:fs/promises";

import type { DoctorReport } from "./doctor.js";
import { collectDoctorReport } from "./doctor.js";

export type SetupRoute = "MOCK" | "LIVE";

type SetupCheckStatus = "PASS" | "WARN" | "FAIL";

type SetupCheck<Code extends string> = {
  status: SetupCheckStatus;
  code: Code;
};

export type SetupReadinessReport = {
  schemaVersion: 1;
  status: "READY" | "BLOCKED";
  route: SetupRoute;
  checks: {
    system: SetupCheck<
      | "SYSTEM_READY"
      | "SYSTEM_READY_WITH_WARNINGS"
      | "SYSTEM_BLOCKED"
      | "SYSTEM_INSPECTION_UNAVAILABLE"
      | "DATA_BACKUP_REQUIRED"
    >;
    browser: SetupCheck<"BROWSER_READY" | "BROWSER_MISSING" | "BROWSER_UNAVAILABLE">;
    route: SetupCheck<
      | "MOCK_ROUTE_READY"
      | "LIVE_ROUTE_READY"
      | "PROVIDER_OVERRIDE_ACTIVE"
      | "LIVE_PROVIDER_NOT_READY"
      | "ROUTE_INSPECTION_UNAVAILABLE"
    >;
  };
  nextActions: readonly (
    | "RUN_DOCTOR"
    | "BACK_UP_DATA"
    | "INSTALL_CHROMIUM"
    | "CLEAR_PROVIDER_OVERRIDE"
    | "REVIEW_PROVIDER_COMPATIBILITY"
    | "SIGN_IN_PROVIDER"
    | "RUN_START"
    | "INITIALIZE_DEMO_WORKSPACE"
    | "SELECT_MOCK"
    | "SELECT_LIVE_PROVIDER"
  )[];
};

type BrowserInspection = "AVAILABLE" | "MISSING" | "UNAVAILABLE";

type SetupDependencies = {
  collectDoctor?: () => Promise<DoctorReport>;
  inspectBrowser?: () => Promise<BrowserInspection>;
};

const missingPath = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const inspectChromium = async (): Promise<BrowserInspection> => {
  try {
    const { chromium } = await import("playwright");
    const metadata = await stat(chromium.executablePath());
    return metadata.isFile() ? "AVAILABLE" : "UNAVAILABLE";
  } catch (error: unknown) {
    return missingPath(error) ? "MISSING" : "UNAVAILABLE";
  }
};

const systemCheck = (report: DoctorReport | null): SetupReadinessReport["checks"]["system"] => {
  if (report === null) return { status: "FAIL", code: "SYSTEM_INSPECTION_UNAVAILABLE" };
  if (report.checks.stateDatabase.code === "STATE_UPGRADE_REQUIRED") {
    return { status: "FAIL", code: "DATA_BACKUP_REQUIRED" };
  }
  if (report.status === "FAIL") return { status: "FAIL", code: "SYSTEM_BLOCKED" };
  return report.status === "WARN"
    ? { status: "WARN", code: "SYSTEM_READY_WITH_WARNINGS" }
    : { status: "PASS", code: "SYSTEM_READY" };
};

const browserCheck = (inspection: BrowserInspection): SetupReadinessReport["checks"]["browser"] =>
  inspection === "AVAILABLE"
    ? { status: "PASS", code: "BROWSER_READY" }
    : inspection === "MISSING"
      ? { status: "FAIL", code: "BROWSER_MISSING" }
      : { status: "FAIL", code: "BROWSER_UNAVAILABLE" };

const routeCheck = (
  route: SetupRoute,
  report: DoctorReport | null,
): SetupReadinessReport["checks"]["route"] => {
  if (report === null) return { status: "FAIL", code: "ROUTE_INSPECTION_UNAVAILABLE" };
  if (report.checks.providers.environmentOverride !== "NONE") {
    return { status: "FAIL", code: "PROVIDER_OVERRIDE_ACTIVE" };
  }
  if (route === "MOCK") return { status: "PASS", code: "MOCK_ROUTE_READY" };
  const liveReady = report.checks.providers.items.some(({ provider, ready }) => provider !== "MOCK" && ready);
  return liveReady
    ? { status: "PASS", code: "LIVE_ROUTE_READY" }
    : { status: "FAIL", code: "LIVE_PROVIDER_NOT_READY" };
};

const remediationActions = (
  checks: SetupReadinessReport["checks"],
  report: DoctorReport | null,
): SetupReadinessReport["nextActions"] => {
  const actions: SetupReadinessReport["nextActions"][number][] = [];
  if (checks.system.code === "SYSTEM_BLOCKED" || checks.system.code === "SYSTEM_INSPECTION_UNAVAILABLE") {
    actions.push("RUN_DOCTOR");
  }
  if (checks.system.code === "DATA_BACKUP_REQUIRED") actions.push("BACK_UP_DATA");
  if (checks.browser.status === "FAIL") actions.push("INSTALL_CHROMIUM");
  if (checks.route.code === "PROVIDER_OVERRIDE_ACTIVE") actions.push("CLEAR_PROVIDER_OVERRIDE");
  if (checks.route.code === "LIVE_PROVIDER_NOT_READY") {
    const verifiedProviderNeedsAuthentication = report?.checks.providers.items.some(
      ({ provider, compatibility, authentication }) =>
        provider !== "MOCK" && compatibility === "VERIFIED" && authentication !== "AUTHENTICATED",
    );
    actions.push(verifiedProviderNeedsAuthentication ? "SIGN_IN_PROVIDER" : "REVIEW_PROVIDER_COMPATIBILITY");
  }
  return actions;
};

export const collectSetupReadiness = async (
  route: SetupRoute,
  dependencies: SetupDependencies = {},
): Promise<SetupReadinessReport> => {
  const [doctor, browserInspection] = await Promise.all([
    (dependencies.collectDoctor ?? collectDoctorReport)().catch(() => null),
    (dependencies.inspectBrowser ?? inspectChromium)().catch(() => "UNAVAILABLE" as const),
  ]);
  const checks: SetupReadinessReport["checks"] = {
    system: systemCheck(doctor),
    browser: browserCheck(browserInspection),
    route: routeCheck(route, doctor),
  };
  const remediation = remediationActions(checks, doctor);
  const status = Object.values(checks).some(({ status: checkStatus }) => checkStatus === "FAIL")
    ? "BLOCKED"
    : "READY";
  return {
    schemaVersion: 1,
    status,
    route,
    checks,
    nextActions:
      status === "BLOCKED"
        ? remediation
        : [
            "RUN_START",
            "INITIALIZE_DEMO_WORKSPACE",
            route === "MOCK" ? "SELECT_MOCK" : "SELECT_LIVE_PROVIDER",
          ],
  };
};

const setupActionText: Readonly<Record<SetupReadinessReport["nextActions"][number], string>> = {
  RUN_DOCTOR: "Run `loomrail doctor` and resolve every FAIL before startup.",
  BACK_UP_DATA:
    "Stop Loomrail, back up the whole data directory, then follow the documented forward-upgrade procedure.",
  INSTALL_CHROMIUM: "Install the Browser QA prerequisite with `npx playwright install chromium`.",
  CLEAR_PROVIDER_OVERRIDE: "Unset LOOMRAIL_PROVIDER before using the guided setup route.",
  REVIEW_PROVIDER_COMPATIBILITY:
    "Review the exact provider version in the Loomrail compatibility matrix, then run setup again.",
  SIGN_IN_PROVIDER: "Install and sign in to a supported live provider CLI, then run setup again.",
  RUN_START: "Run `loomrail start`.",
  INITIALIZE_DEMO_WORKSPACE: "In the Workbench, initialize the bundled demo workspace.",
  SELECT_MOCK: "In Settings, select Mock before starting the workflow.",
  SELECT_LIVE_PROVIDER:
    "In Settings, explicitly select an available live provider before starting the workflow.",
};

export const formatSetupReadiness = (report: SetupReadinessReport): readonly string[] => [
  `Loomrail setup: ${report.status}`,
  `Route: ${report.route}`,
  `[${report.checks.system.status}] System: ${report.checks.system.code}`,
  `[${report.checks.browser.status}] Browser QA: ${report.checks.browser.code}`,
  `[${report.checks.route.status}] Route: ${report.checks.route.code}`,
  "Next actions:",
  ...report.nextActions.map((action, index) => `${(index + 1).toString()}. ${setupActionText[action]}`),
  "Setup changed and persisted nothing; it launched no browser, daemon, agent session, login, or installer.",
];

export const serializeSetupReadiness = (report: SetupReadinessReport): string =>
  JSON.stringify(report, null, 2);

export const setupRoutePrompt = (): readonly string[] => [
  "Choose a setup route:",
  "  1. Mock walkthrough (recommended; no provider process or quota)",
  "  2. Live provider preflight",
];

export const parseSetupRouteChoice = (answer: string): SetupRoute => {
  if (answer.length > 16) throw new Error("Setup choice must be 1, 2, mock, or live");
  const normalized = answer.trim().toLowerCase();
  if (normalized === "" || normalized === "1" || normalized === "mock") return "MOCK";
  if (normalized === "2" || normalized === "live") return "LIVE";
  throw new Error("Setup choice must be 1, 2, mock, or live");
};

export const selectSetupRoute = async (question: (prompt: string) => Promise<string>): Promise<SetupRoute> =>
  parseSetupRouteChoice(await question("Select route [1]: "));
