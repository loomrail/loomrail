import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, normalize } from "node:path";

import { repositoryScanSchema, type RepositoryScan, type RepositoryScanWarning } from "@loomrail/contracts";
import { inspectRepository } from "@loomrail/workspace";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const TARGET_PATH = ".loomrail/constitution.md";

const rootReadableFiles: Readonly<Record<string, RepositoryScan["files"][number]["kind"]>> = {
  "AGENTS.md": "AGENT_INSTRUCTIONS",
  "CLAUDE.md": "AGENT_INSTRUCTIONS",
  "package.json": "PACKAGE_MANIFEST",
  "pnpm-workspace.yaml": "WORKSPACE_MANIFEST",
  "tsconfig.json": "TOOL_CONFIG",
  "tsconfig.base.json": "TOOL_CONFIG",
  "vitest.config.ts": "TOOL_CONFIG",
  "vitest.config.js": "TOOL_CONFIG",
  "vite.config.ts": "TOOL_CONFIG",
  "vite.config.js": "TOOL_CONFIG",
  "eslint.config.ts": "TOOL_CONFIG",
  "eslint.config.js": "TOOL_CONFIG",
  "eslint.config.mjs": "TOOL_CONFIG",
  ".eslintrc.json": "TOOL_CONFIG",
  ".prettierrc": "TOOL_CONFIG",
  ".prettierrc.json": "TOOL_CONFIG",
};

const packageManagerMarkers: Readonly<Record<string, RepositoryScan["packageManager"]>> = {
  "pnpm-lock.yaml": "PNPM",
  "package-lock.json": "NPM",
  "yarn.lock": "YARN",
  "bun.lock": "BUN",
  "bun.lockb": "BUN",
};

type Candidate = {
  absolutePath: string;
  kind: RepositoryScan["files"][number]["kind"];
  path: string;
  readContents: boolean;
};

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const samePath = (left: string, right: string): boolean => {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const warning = (
  code: RepositoryScanWarning["code"],
  path: string | null,
  message: string,
): RepositoryScanWarning => ({ code, path, message });

const safeDirectoryEntries = async (
  root: string,
  relativeDirectory: string,
): Promise<readonly import("node:fs").Dirent[]> => {
  try {
    let current = root;
    for (const segment of relativeDirectory.split("/").filter(Boolean)) {
      current = join(current, segment);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return [];
    }
    return await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }
};

const architectureCandidates = async (root: string): Promise<readonly Candidate[]> => {
  const candidates: Candidate[] = [];
  for (const directory of ["docs/architecture", "docs/adr", "docs/decisions"] as const) {
    const absoluteDirectory = join(root, directory);
    const firstLevel = await safeDirectoryEntries(root, directory);
    for (const entry of firstLevel) {
      if (entry.isSymbolicLink()) {
        candidates.push({
          absolutePath: join(absoluteDirectory, entry.name),
          kind: "ARCHITECTURE_DOCUMENT",
          path: `${directory}/${entry.name}`,
          readContents: true,
        });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        candidates.push({
          absolutePath: join(absoluteDirectory, entry.name),
          kind: "ARCHITECTURE_DOCUMENT",
          path: `${directory}/${entry.name}`,
          readContents: true,
        });
      } else if (entry.isDirectory()) {
        const secondLevel = await safeDirectoryEntries(root, `${directory}/${entry.name}`);
        for (const nested of secondLevel) {
          if ((nested.isFile() || nested.isSymbolicLink()) && nested.name.toLowerCase().endsWith(".md")) {
            candidates.push({
              absolutePath: join(absoluteDirectory, entry.name, nested.name),
              kind: "ARCHITECTURE_DOCUMENT",
              path: `${directory}/${entry.name}/${nested.name}`,
              readContents: true,
            });
          }
        }
      }
    }
  }
  return candidates;
};

const ciCandidates = async (root: string): Promise<readonly Candidate[]> => {
  const directory = join(root, ".github", "workflows");
  return (await safeDirectoryEntries(root, ".github/workflows"))
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.(?:yml|yaml)$/i.test(entry.name))
    .map((entry) => ({
      absolutePath: join(directory, entry.name),
      kind: "CI_WORKFLOW" as const,
      path: `.github/workflows/${entry.name}`,
      readContents: true,
    }));
};

const rootCandidates = async (root: string): Promise<readonly Candidate[]> => {
  const candidates: Candidate[] = [];
  for (const entry of await safeDirectoryEntries(root, "")) {
    if (!(entry.isFile() || entry.isSymbolicLink())) continue;
    const explicitKind = rootReadableFiles[entry.name];
    const readme = /^README(?:\..+)?$/i.test(entry.name);
    const marker = packageManagerMarkers[entry.name];
    if (explicitKind) {
      candidates.push({
        absolutePath: join(root, entry.name),
        kind: explicitKind,
        path: entry.name,
        readContents: true,
      });
    } else if (readme) {
      candidates.push({
        absolutePath: join(root, entry.name),
        kind: "README",
        path: entry.name,
        readContents: true,
      });
    } else if (marker) {
      candidates.push({
        absolutePath: join(root, entry.name),
        kind: "PACKAGE_MANAGER_MARKER",
        path: entry.name,
        readContents: false,
      });
    }
  }
  return candidates;
};

const targetCandidate = async (root: string): Promise<{ candidate: Candidate | null; blocked: boolean }> => {
  try {
    const directory = await lstat(join(root, ".loomrail"));
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      return { candidate: null, blocked: true };
    }
  } catch {
    return { candidate: null, blocked: false };
  }
  try {
    await lstat(join(root, TARGET_PATH));
    return {
      candidate: {
        absolutePath: join(root, TARGET_PATH),
        kind: "CONSTITUTION",
        path: TARGET_PATH,
        readContents: true,
      },
      blocked: false,
    };
  } catch {
    return { candidate: null, blocked: false };
  }
};

const verificationArgv = (
  packageManager: RepositoryScan["packageManager"],
  name: string,
): readonly string[] => {
  switch (packageManager) {
    case "PNPM":
      return ["pnpm", name];
    case "YARN":
      return ["yarn", name];
    case "BUN":
      return ["bun", "run", name];
    case "NPM":
    case "UNKNOWN":
      return ["npm", "run", name];
  }
};

const manifestFacts = (
  content: string | null,
  packageManager: RepositoryScan["packageManager"],
): {
  commands: RepositoryScan["verificationCommands"];
  hasWorkspaces: boolean;
  warnings: readonly RepositoryScanWarning[];
} => {
  if (content === null) return { commands: [], hasWorkspaces: false, warnings: [] };
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("not an object");
    const record = parsed as Record<string, unknown>;
    const scripts = record["scripts"];
    const warnings: RepositoryScanWarning[] = [];
    const commands =
      typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
        ? Object.entries(scripts)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .flatMap(([name]) => {
              if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(name)) {
                warnings.push(
                  warning(
                    "SCRIPT_NAME_UNSAFE",
                    "package.json",
                    "A package script name was skipped because it cannot be represented safely.",
                  ),
                );
                return [];
              }
              return [
                {
                  name,
                  argv: [...verificationArgv(packageManager, name)],
                  sourcePath: "package.json" as const,
                },
              ];
            })
            .slice(0, 64)
        : [];
    return {
      commands,
      hasWorkspaces: Array.isArray(record["workspaces"]) || typeof record["workspaces"] === "object",
      warnings,
    };
  } catch {
    return {
      commands: [],
      hasWorkspaces: false,
      warnings: [
        warning(
          "MANIFEST_INVALID",
          "package.json",
          "package.json is not a JSON object, so Loomrail did not derive commands from it.",
        ),
      ],
    };
  }
};

export class RepositoryScanError extends Error {
  readonly code = "REPOSITORY_UNAVAILABLE";

  constructor() {
    super("The Project repository is not available at its registered top-level path");
    this.name = "RepositoryScanError";
  }
}

export const scanProjectRepository = async (repositoryPath: string): Promise<RepositoryScan> => {
  // Canonicalise first and only then ask git: spawning git with a missing directory as `cwd` fails
  // with ENOENT, which `runGit` can only report as "git is not installed" -- the wrong diagnosis
  // for a Project whose repository was moved or deleted.
  const canonicalRoot = await realpath(repositoryPath).catch(() => null);
  if (canonicalRoot === null) throw new RepositoryScanError();
  const repository = await inspectRepository(canonicalRoot);
  if (repository === null || !samePath(canonicalRoot, repository.topLevel)) {
    throw new RepositoryScanError();
  }

  const target = await targetCandidate(canonicalRoot);
  const allCandidates = [
    ...(await rootCandidates(canonicalRoot)),
    ...(target.candidate === null ? [] : [target.candidate]),
    ...(await ciCandidates(canonicalRoot)),
    ...(await architectureCandidates(canonicalRoot)),
  ].sort((left, right) => left.path.localeCompare(right.path));

  const warnings: RepositoryScanWarning[] = [];
  if (target.blocked) {
    warnings.push(
      warning(
        "SYMLINK_SKIPPED",
        TARGET_PATH,
        "The .loomrail target is not a regular directory inside the repository.",
      ),
    );
  }
  const candidates = allCandidates.slice(0, MAX_FILES);
  if (allCandidates.length > MAX_FILES) {
    warnings.push(
      warning(
        "CANDIDATE_LIMIT_REACHED",
        null,
        `Only the first ${MAX_FILES.toString()} allowlisted files were considered.`,
      ),
    );
  }

  const files: RepositoryScan["files"] = [];
  const contents = new Map<string, string>();
  let totalBytes = 0;
  let totalLimitReached = false;
  let targetConstitution: RepositoryScan["targetConstitution"] = target.blocked
    ? { state: "BLOCKED", digest: null }
    : { state: "ABSENT", digest: null };

  for (const candidate of candidates) {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(candidate.absolutePath);
    } catch {
      warnings.push(
        warning("FILE_UNREADABLE", candidate.path, "An allowlisted file could not be inspected."),
      );
      if (candidate.path === TARGET_PATH) targetConstitution = { state: "BLOCKED", digest: null };
      continue;
    }
    if (metadata.isSymbolicLink()) {
      warnings.push(
        warning("SYMLINK_SKIPPED", candidate.path, "A symbolic link was not followed by the scanner."),
      );
      if (candidate.path === TARGET_PATH || candidate.path.startsWith(".loomrail/")) {
        targetConstitution = { state: "BLOCKED", digest: null };
      }
      continue;
    }
    if (!metadata.isFile()) {
      if (candidate.path === TARGET_PATH) targetConstitution = { state: "BLOCKED", digest: null };
      continue;
    }
    if (!candidate.readContents) {
      files.push({ path: candidate.path, kind: candidate.kind, bytes: metadata.size, digest: null });
      continue;
    }
    if (metadata.size > MAX_FILE_BYTES) {
      warnings.push(
        warning(
          "FILE_TOO_LARGE",
          candidate.path,
          `The file exceeds the ${MAX_FILE_BYTES.toString()} byte per-file scan limit.`,
        ),
      );
      if (candidate.path === TARGET_PATH) targetConstitution = { state: "BLOCKED", digest: null };
      continue;
    }
    if (totalBytes + metadata.size > MAX_TOTAL_BYTES) {
      if (!totalLimitReached) {
        warnings.push(
          warning(
            "TOTAL_BYTES_LIMIT_REACHED",
            null,
            `The scan stopped reading content at ${MAX_TOTAL_BYTES.toString()} total bytes.`,
          ),
        );
        totalLimitReached = true;
      }
      if (candidate.path === TARGET_PATH) targetConstitution = { state: "BLOCKED", digest: null };
      continue;
    }
    try {
      const content = await readFile(candidate.absolutePath);
      const contentDigest = digest(content);
      totalBytes += content.byteLength;
      files.push({
        path: candidate.path,
        kind: candidate.kind,
        bytes: content.byteLength,
        digest: contentDigest,
      });
      if (candidate.path === "package.json") contents.set(candidate.path, content.toString("utf8"));
      if (candidate.path === TARGET_PATH) {
        targetConstitution = { state: "PRESENT", digest: contentDigest };
      }
    } catch {
      warnings.push(warning("FILE_UNREADABLE", candidate.path, "An allowlisted file could not be read."));
      if (candidate.path === TARGET_PATH) targetConstitution = { state: "BLOCKED", digest: null };
    }
  }

  const markerManagers = files
    .map((file) => packageManagerMarkers[basename(file.path)])
    .filter((value): value is RepositoryScan["packageManager"] => value !== undefined);
  const packageManager = markerManagers.includes("PNPM")
    ? "PNPM"
    : markerManagers.includes("YARN")
      ? "YARN"
      : markerManagers.includes("BUN")
        ? "BUN"
        : markerManagers.includes("NPM")
          ? "NPM"
          : "UNKNOWN";
  const facts = manifestFacts(contents.get("package.json") ?? null, packageManager);
  warnings.push(...facts.warnings);
  const filePaths = new Set(files.map((file) => file.path));
  const languages: RepositoryScan["languages"] = filePaths.has("tsconfig.json") ? ["TYPESCRIPT"] : [];
  if (filePaths.has("package.json") && languages.length === 0) languages.push("JAVASCRIPT");

  const sourceDigest = digest(
    files
      .map((file) => `${file.path}\0${file.kind}\0${file.bytes.toString()}\0${file.digest ?? "presence"}`)
      .join("\n"),
  );

  return repositoryScanSchema.parse({
    schemaVersion: 1,
    sourceDigest,
    targetConstitution,
    files,
    warnings,
    packageManager,
    languages,
    workspace: filePaths.has("pnpm-workspace.yaml") || facts.hasWorkspaces,
    verificationCommands: facts.commands,
    instructionPaths: files.filter((file) => file.kind === "AGENT_INSTRUCTIONS").map((file) => file.path),
    architecturePaths: files.filter((file) => file.kind === "ARCHITECTURE_DOCUMENT").map((file) => file.path),
    ciPaths: files.filter((file) => file.kind === "CI_WORKFLOW").map((file) => file.path),
    configPaths: files.filter((file) => file.kind === "TOOL_CONFIG").map((file) => file.path),
  });
};
