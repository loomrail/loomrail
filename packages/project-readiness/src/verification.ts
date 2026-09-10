import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import {
  MAX_VERIFICATION_RECIPES,
  verificationRecipeCwdSchema,
  verificationPlanProposalSchema,
  type VerificationExecutable,
  type VerificationPlanProposal,
  type VerificationPlanTarget,
  type VerificationProposalWarning,
  type VerificationRecipe,
  type VerificationRecipeKind,
  type VerificationScriptName,
} from "@loomrail/contracts";

import { parseMarkerBoundVerificationPlan, verificationPlanProposalHash } from "./plan-file.js";

const MANIFEST_PATH = "package.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SCRIPT_BODY_CHARACTERS = 1_024;
const MAX_SCRIPT_ENTRIES = 64;
const TARGET_DIRECTORY = ".loomrail";
const TARGET_PATH = ".loomrail/verification-plan.json";
const MAX_TARGET_BYTES = 512 * 1024;
const DEFAULT_RECIPE_TIMEOUT_SECONDS = 300;
const DEFAULT_E2E_TIMEOUT_SECONDS = 900;
const MAX_WORKSPACE_APP_ENTRIES = 32;

const supportedScripts: readonly {
  name: VerificationScriptName;
  id: string;
  kind: VerificationRecipeKind;
  label: string;
}[] = [
  { name: "lint", id: "package-lint", kind: "LINT", label: "Lint" },
  { name: "build", id: "package-build", kind: "BUILD", label: "Build" },
  { name: "test", id: "package-test", kind: "UNIT", label: "Tests" },
  { name: "test:unit", id: "package-test-unit", kind: "UNIT", label: "Unit tests" },
  {
    name: "test:integration",
    id: "package-test-integration",
    kind: "INTEGRATION",
    label: "Integration tests",
  },
  { name: "test:e2e", id: "package-test-e2e", kind: "E2E", label: "End-to-end tests" },
  { name: "audit", id: "package-audit", kind: "AUDIT", label: "Dependency audit" },
  { name: "start", id: "package-start", kind: "SERVE", label: "Start service" },
  { name: "dev", id: "package-dev", kind: "SERVE", label: "Development service" },
  { name: "preview", id: "package-preview", kind: "SERVE", label: "Preview service" },
];

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const samePath = (left: string, right: string): boolean => {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const warning = (
  code: VerificationProposalWarning["code"],
  message: string,
  path: VerificationProposalWarning["path"] = MANIFEST_PATH,
): VerificationProposalWarning => ({ code, path, message });

const proposal = (
  projectId: string,
  target: VerificationPlanTarget,
  recipes: readonly VerificationRecipe[],
  warnings: readonly VerificationProposalWarning[],
): VerificationPlanProposal => {
  const payload = {
    schemaVersion: 1 as const,
    projectId,
    target,
    recipes: [...recipes],
    warnings: [...warnings],
  };
  return verificationPlanProposalSchema.parse({
    ...payload,
    proposalHash: verificationPlanProposalHash(payload),
  });
};

const inspectTarget = async (
  canonicalRoot: string,
): Promise<{
  target: VerificationPlanTarget;
  warnings: readonly VerificationProposalWarning[];
}> => {
  const directoryPath = join(canonicalRoot, TARGET_DIRECTORY);
  try {
    const directory = await lstat(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      return {
        target: { state: "BLOCKED", digest: null },
        warnings: [
          warning(
            "PLAN_TARGET_BLOCKED",
            "The .loomrail target is not a regular Project directory.",
            TARGET_PATH,
          ),
        ],
      };
    }
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { target: { state: "ABSENT", digest: null }, warnings: [] };
    return {
      target: { state: "BLOCKED", digest: null },
      warnings: [warning("PLAN_TARGET_BLOCKED", "The .loomrail target could not be inspected.", TARGET_PATH)],
    };
  }

  const targetPath = join(canonicalRoot, TARGET_PATH);
  try {
    const metadata = await lstat(targetPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_TARGET_BYTES) {
      return {
        target: { state: "BLOCKED", digest: null },
        warnings: [
          warning(
            "PLAN_TARGET_BLOCKED",
            "The existing verification plan is not a bounded regular Loomrail file.",
            TARGET_PATH,
          ),
        ],
      };
    }
    const handle = await open(targetPath, "r");
    try {
      const opened = await handle.stat();
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new Error("Target changed during inspection");
      }
      const bytes = await handle.readFile();
      if (
        bytes.byteLength > MAX_TARGET_BYTES ||
        parseMarkerBoundVerificationPlan(bytes.toString("utf8")) === null
      ) {
        return {
          target: { state: "BLOCKED", digest: null },
          warnings: [
            warning(
              "PLAN_TARGET_BLOCKED",
              "The existing verification plan is not marker-bound Loomrail content.",
              TARGET_PATH,
            ),
          ],
        };
      }
      return { target: { state: "PRESENT", digest: sha256(bytes) }, warnings: [] };
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { target: { state: "ABSENT", digest: null }, warnings: [] };
    return {
      target: { state: "BLOCKED", digest: null },
      warnings: [
        warning("PLAN_TARGET_BLOCKED", "The verification plan could not be read safely.", TARGET_PATH),
      ],
    };
  }
};

type ManifestRead =
  | { state: "PRESENT"; bytes: Buffer; text: string }
  | { state: "ABSENT" | "INVALID" | "OVERSIZED" | "SYMLINK" };

const errorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;

const readManifest = async (canonicalRoot: string): Promise<ManifestRead> => {
  const path = join(canonicalRoot, MANIFEST_PATH);
  let before: import("node:fs").Stats;
  try {
    before = await lstat(path);
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? { state: "ABSENT" } : { state: "INVALID" };
  }
  if (before.isSymbolicLink()) return { state: "SYMLINK" };
  if (!before.isFile()) return { state: "INVALID" };
  if (before.size > MAX_MANIFEST_BYTES) return { state: "OVERSIZED" };

  const canonicalManifest = await realpath(path).catch(() => null);
  if (canonicalManifest === null || !samePath(canonicalManifest, path)) return { state: "SYMLINK" };

  const handle = await open(path, "r").catch(() => null);
  if (handle === null) return { state: "INVALID" };
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_MANIFEST_BYTES) {
      return { state: opened.size > MAX_MANIFEST_BYTES ? "OVERSIZED" : "INVALID" };
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino) return { state: "INVALID" };
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_MANIFEST_BYTES) return { state: "OVERSIZED" };
    const after = await lstat(path).catch(() => null);
    if (after === null || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      return { state: "INVALID" };
    }
    return { state: "PRESENT", bytes, text: bytes.toString("utf8") };
  } finally {
    await handle.close();
  }
};

const packageManagerFor = (manifest: Record<string, unknown>): VerificationExecutable => {
  const declared = manifest["packageManager"];
  if (typeof declared === "string") {
    const match = /^(pnpm|npm|yarn|bun)@/u.exec(declared);
    if (match?.[1] === "pnpm" || match?.[1] === "npm" || match?.[1] === "yarn" || match?.[1] === "bun") {
      return match[1];
    }
  }
  return "npm";
};

const recipeFor = (
  definition: (typeof supportedScripts)[number],
  body: string,
  executable: VerificationExecutable,
  manifestContentHash: string,
  cwd = ".",
): VerificationRecipe => ({
  schemaVersion: 1,
  id: cwd === "." ? definition.id : `workspace-${sha256(cwd).slice(0, 16)}-${definition.id}`,
  kind: definition.kind,
  label: cwd === "." ? definition.label : `${definition.label} · ${cwd}`,
  required: definition.kind !== "SERVE",
  executable,
  argv: ["run", definition.name],
  cwd,
  timeoutSeconds: definition.kind === "E2E" ? DEFAULT_E2E_TIMEOUT_SECONDS : DEFAULT_RECIPE_TIMEOUT_SECONDS,
  outputLimitBytes: 262_144,
  environmentProfile: "VERIFICATION_BASELINE",
  networkPolicy: "INHERIT_HOST",
  provenance: {
    source: "PACKAGE_JSON_SCRIPT",
    manifestPath: MANIFEST_PATH,
    manifestContentHash,
    scriptName: definition.name,
    scriptBodyPreview: body,
  },
});

const workspaceServiceRecipes = async (input: {
  canonicalRoot: string;
  executable: VerificationExecutable;
  availableSlots: number;
}): Promise<{
  recipes: VerificationRecipe[];
  warnings: VerificationProposalWarning[];
}> => {
  if (input.availableSlots <= 0) return { recipes: [], warnings: [] };
  const appsPath = join(input.canonicalRoot, "apps");
  let entries: import("node:fs").Dirent<string>[];
  try {
    const metadata = await lstat(appsPath);
    const canonicalApps = await realpath(appsPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || !samePath(canonicalApps, appsPath)) {
      return {
        recipes: [],
        warnings: [
          warning("SCRIPT_UNSAFE", "The conventional apps directory is not a regular directory.", null),
        ],
      };
    }
    entries = await readdir(canonicalApps, { withFileTypes: true });
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT"
      ? { recipes: [], warnings: [] }
      : {
          recipes: [],
          warnings: [
            warning("SCRIPT_UNSAFE", "The conventional apps directory could not be read safely.", null),
          ],
        };
  }
  if (entries.length > MAX_WORKSPACE_APP_ENTRIES) {
    return {
      recipes: [],
      warnings: [
        warning(
          "SCRIPT_LIMIT_REACHED",
          `The apps directory has more than ${MAX_WORKSPACE_APP_ENTRIES.toString()} entries; no workspace service was proposed.`,
          null,
        ),
      ],
    };
  }

  const recipes: VerificationRecipe[] = [];
  const warnings: VerificationProposalWarning[] = [];
  const serviceDefinitions = supportedScripts.filter(({ kind }) => kind === "SERVE");
  const sortedEntries = [...entries].sort(({ name: left }, { name: right }) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const entry of sortedEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const cwd = `apps/${entry.name}`;
    if (!verificationRecipeCwdSchema.safeParse(cwd).success) {
      warnings.push(warning("SCRIPT_UNSAFE", "An app directory name is not portable.", null));
      continue;
    }
    const appPath = join(input.canonicalRoot, cwd);
    const metadata = await lstat(appPath).catch(() => null);
    const canonicalApp = await realpath(appPath).catch(() => null);
    if (
      metadata === null ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      canonicalApp === null ||
      !samePath(canonicalApp, appPath)
    ) {
      warnings.push(warning("SCRIPT_UNSAFE", "An app workspace could not be inspected safely.", null));
      continue;
    }
    const manifest = await readManifest(canonicalApp);
    if (manifest.state !== "PRESENT") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.text);
    } catch {
      warnings.push(warning("MANIFEST_INVALID", "An app package.json is not valid JSON.", null));
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed["scripts"])) continue;
    const scripts = parsed["scripts"];
    if (Object.keys(scripts).length > MAX_SCRIPT_ENTRIES) {
      warnings.push(
        warning("SCRIPT_LIMIT_REACHED", "An app package.json exceeds the script-entry limit.", null),
      );
      continue;
    }
    const manifestContentHash = sha256(manifest.bytes);
    for (const definition of serviceDefinitions) {
      const body = scripts[definition.name];
      if (typeof body !== "string") continue;
      if (
        typeof scripts[`pre${definition.name}`] === "string" ||
        typeof scripts[`post${definition.name}`] === "string" ||
        body.trim().length === 0 ||
        body.includes("\u0000") ||
        body.length > MAX_SCRIPT_BODY_CHARACTERS
      ) {
        warnings.push(
          warning(
            "SCRIPT_UNSAFE",
            `The ${definition.name} script in an app workspace cannot be represented safely.`,
            null,
          ),
        );
        continue;
      }
      if (recipes.length >= input.availableSlots) {
        warnings.push(
          warning("SCRIPT_LIMIT_REACHED", "Additional app service recipes exceeded the Plan cap.", null),
        );
        return { recipes, warnings };
      }
      recipes.push(recipeFor(definition, body, input.executable, manifestContentHash, cwd));
    }
  }
  return { recipes, warnings };
};

export const scanVerificationPlanProposal = async (input: {
  projectId: string;
  repositoryPath: string;
}): Promise<VerificationPlanProposal> => {
  const canonicalRoot = await realpath(input.repositoryPath).catch(() => null);
  if (canonicalRoot === null) {
    throw new ProjectVerificationScanError("REPOSITORY_UNAVAILABLE", "The Project repository is unavailable");
  }

  const target = await inspectTarget(canonicalRoot);

  const manifest = await readManifest(canonicalRoot);
  if (manifest.state !== "PRESENT") {
    const details: Record<Exclude<ManifestRead["state"], "PRESENT">, VerificationProposalWarning> = {
      ABSENT: warning("MANIFEST_ABSENT", "No root package.json was found."),
      INVALID: warning("MANIFEST_INVALID", "package.json is not a stable bounded regular file."),
      OVERSIZED: warning("MANIFEST_TOO_LARGE", "package.json exceeds the 256 KiB scan limit."),
      SYMLINK: warning("MANIFEST_SYMLINK", "A symlinked package.json was not read."),
    };
    return proposal(input.projectId, target.target, [], [...target.warnings, details[manifest.state]]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.text);
  } catch {
    return proposal(
      input.projectId,
      target.target,
      [],
      [...target.warnings, warning("MANIFEST_INVALID", "package.json is not valid JSON.")],
    );
  }
  if (!isRecord(parsed)) {
    return proposal(
      input.projectId,
      target.target,
      [],
      [...target.warnings, warning("MANIFEST_INVALID", "package.json is not a JSON object.")],
    );
  }

  const scripts = parsed["scripts"];
  const scriptRecord = isRecord(scripts) ? scripts : {};
  if (Object.keys(scriptRecord).length > MAX_SCRIPT_ENTRIES) {
    return proposal(
      input.projectId,
      target.target,
      [],
      [
        ...target.warnings,
        warning(
          "SCRIPT_LIMIT_REACHED",
          `package.json has more than ${MAX_SCRIPT_ENTRIES.toString()} script entries; no command was proposed.`,
        ),
      ],
    );
  }
  const manifestContentHash = sha256(manifest.bytes);
  const executable = packageManagerFor(parsed);
  const recipes: VerificationRecipe[] = [];
  const warnings: VerificationProposalWarning[] = [...target.warnings];
  for (const definition of supportedScripts) {
    const body = scriptRecord[definition.name];
    if (typeof body !== "string") continue;
    const beforeHook = scriptRecord[`pre${definition.name}`];
    const afterHook = scriptRecord[`post${definition.name}`];
    if (typeof beforeHook === "string" || typeof afterHook === "string") {
      warnings.push(
        warning(
          "SCRIPT_UNSAFE",
          `The ${definition.name} script has an implicit pre/post lifecycle hook that is not safe to hide from the owner preview.`,
        ),
      );
      continue;
    }
    if (body.trim().length === 0 || body.includes("\u0000") || body.length > MAX_SCRIPT_BODY_CHARACTERS) {
      warnings.push(
        warning(
          "SCRIPT_UNSAFE",
          `The ${definition.name} script cannot be represented in the bounded owner preview.`,
        ),
      );
      continue;
    }
    recipes.push(recipeFor(definition, body, executable, manifestContentHash));
  }
  const workspaceServices = await workspaceServiceRecipes({
    canonicalRoot,
    executable,
    availableSlots: MAX_VERIFICATION_RECIPES - recipes.length,
  });
  recipes.push(...workspaceServices.recipes);
  warnings.push(...workspaceServices.warnings);
  if (recipes.length === 0) {
    warnings.push(
      warning("NO_SUPPORTED_SCRIPTS", "No supported package script is available for owner adoption."),
    );
  }
  return proposal(input.projectId, target.target, recipes, warnings);
};

/** Revalidates the exact manifest-backed authority immediately before a recipe can spawn. */
export const verificationRecipeAuthorityIsCurrent = async (input: {
  canonicalCwd: string;
  canonicalWorktree: string;
  recipe: VerificationRecipe;
}): Promise<boolean> => {
  const { recipe } = input;
  const expectedCwd = await realpath(join(input.canonicalWorktree, recipe.cwd)).catch(() => null);
  const relativeCwd = relative(input.canonicalWorktree, input.canonicalCwd);
  if (
    expectedCwd === null ||
    !samePath(expectedCwd, input.canonicalCwd) ||
    relativeCwd === ".." ||
    relativeCwd.startsWith(`..${sep}`) ||
    isAbsolute(relativeCwd)
  ) {
    return false;
  }
  const manifest = await readManifest(input.canonicalCwd);
  if (manifest.state !== "PRESENT" || sha256(manifest.bytes) !== recipe.provenance.manifestContentHash) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.text);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const scripts = parsed["scripts"];
  if (!isRecord(scripts)) return false;
  const scriptName = recipe.provenance.scriptName;
  if (
    scripts[scriptName] !== recipe.provenance.scriptBodyPreview ||
    typeof scripts[`pre${scriptName}`] === "string" ||
    typeof scripts[`post${scriptName}`] === "string"
  ) {
    return false;
  }
  if (recipe.executable === "node") {
    const prohibitedNodeFlags = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import"]);
    return (
      !prohibitedNodeFlags.has(recipe.argv[0] ?? "") &&
      recipe.provenance.scriptBodyPreview === ["node", ...recipe.argv].join(" ")
    );
  }
  let executableManifest = parsed;
  if (recipe.cwd !== ".") {
    const rootManifest = await readManifest(input.canonicalWorktree);
    if (rootManifest.state !== "PRESENT") return false;
    let rootParsed: unknown;
    try {
      rootParsed = JSON.parse(rootManifest.text);
    } catch {
      return false;
    }
    if (!isRecord(rootParsed)) return false;
    executableManifest = rootParsed;
  }
  return (
    packageManagerFor(executableManifest) === recipe.executable &&
    recipe.argv.length === 2 &&
    recipe.argv[0] === "run" &&
    recipe.argv[1] === scriptName
  );
};

export type ProjectVerificationScanErrorCode = "REPOSITORY_UNAVAILABLE";

export class ProjectVerificationScanError extends Error {
  readonly code: ProjectVerificationScanErrorCode;

  constructor(code: ProjectVerificationScanErrorCode, message: string) {
    super(message);
    this.name = "ProjectVerificationScanError";
    this.code = code;
  }
}
