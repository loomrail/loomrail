import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import type {
  VerificationPlan,
  VerificationRecipe,
  WorkspaceToolCallRecord,
  WorkspaceToolFailureCode,
  WorkspaceToolTerminalOutcome,
} from "@loomrail/contracts";
import {
  executeVerificationRecipe,
  prepareVerificationProcessIntent,
  removeVerificationProcessRecord,
} from "@loomrail/project-readiness";
import {
  WORKSPACE_TOOL_MAX_CALLS,
  WORKSPACE_TOOL_MAX_DIRECTORY_ENTRIES,
  WORKSPACE_TOOL_MAX_EDIT_FRAGMENT_BYTES,
  WORKSPACE_TOOL_MAX_READ_BYTES,
  WORKSPACE_TOOL_MAX_WRITE_BYTES,
  workspaceToolRequestSchema,
  type WorkspaceToolExecutor,
  type WorkspaceToolFailure,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
  type WorkspaceToolSuccess,
} from "@loomrail/provider-core";

const MAX_VISIBLE_FILE_BYTES = 1_048_576;
const MAX_TOOL_RESULT_BYTES = 65_536;
const portableSegmentForbiddenPattern = /[<>:"\\|?*]/u;
const windowsReservedNamePattern = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const secretFilePattern =
  /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|credentials?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/iu;
const secretDirectoryNames = new Set([".git", ".loomrail", ".ssh", ".gnupg", ".aws", ".azure"]);

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
};

type Platform = "darwin" | "linux" | "win32";
type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type WorkspaceToolAudit = {
  reserve: (input: {
    providerCallKey: string;
    operation: WorkspaceToolCallRecord["operation"];
    target: string;
    policyDigest: string;
    inputDigest: string;
  }) => { call: WorkspaceToolCallRecord; replayed: boolean };
  finish: (
    callId: string,
    outcome: WorkspaceToolTerminalOutcome,
  ) => {
    call: WorkspaceToolCallRecord;
    replayed: boolean;
  };
};

export type WorkspaceExecutorErrorCode = "AUDIT_UNAVAILABLE" | "PROCESS_AUTHORITY_UNCERTAIN";

export class WorkspaceExecutorError extends Error {
  readonly code: WorkspaceExecutorErrorCode;

  constructor(code: WorkspaceExecutorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceExecutorError";
    this.code = code;
  }
}

export type CreateWorkspaceToolExecutorInput = {
  workspacePath: string;
  access: "READ_ONLY" | "READ_WRITE";
  networkAccess: boolean;
  providerSessionId: string;
  verificationPlan: VerificationPlan | null;
  readCurrentVerificationPlan: () => VerificationPlan | null;
  audit: WorkspaceToolAudit;
  artifactsDirectory: string;
  processRegistryDirectory: string;
  platform?: Platform;
  systemEnvironment?: EnvironmentSource;
  createArtifactId?: () => string;
};

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const supportedPlatform = (platform: NodeJS.Platform): Platform => {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new WorkspaceExecutorError("AUDIT_UNAVAILABLE", "Workspace tools are unavailable on this platform");
};

const samePath = (left: string, right: string, platform: Platform): boolean => {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const inside = (root: string, candidate: string, platform: Platform): boolean => {
  if (samePath(root, candidate, platform)) return true;
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

const pathSegments = (value: string, allowRoot: boolean): string[] | null => {
  if (value === ".") return allowRoot ? [] : null;
  if (
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[/\\]/u.test(value) ||
    value.includes("\\") ||
    Buffer.byteLength(value, "utf8") > 240
  ) {
    return null;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !portableSegmentForbiddenPattern.test(segment) &&
      !hasControlCharacters(segment) &&
      !/[ .]$/u.test(segment) &&
      !windowsReservedNamePattern.test(segment),
  )
    ? segments
    : null;
};

const isSecretSegment = (segment: string): boolean =>
  secretDirectoryNames.has(segment.toLowerCase()) || secretFilePattern.test(segment);

const secretPath = (segments: readonly string[]): boolean => segments.some(isSecretSegment);

const failure = (
  operation: WorkspaceToolRequest["operation"],
  status: WorkspaceToolFailure["status"],
  code: WorkspaceToolFailureCode,
  message: string,
  approvalRequired = false,
): WorkspaceToolFailure => ({ status, operation, code, message, approvalRequired });

const failureOutcome = (result: WorkspaceToolFailure): WorkspaceToolTerminalOutcome => ({
  status: result.status,
  failureCode: result.code,
  outputDigest: null,
  outputBytes: null,
  exitCode: null,
});

const successOutcome = (result: WorkspaceToolSuccess): WorkspaceToolTerminalOutcome => {
  if (result.output.type === "FILE") {
    return {
      status: "SUCCEEDED",
      outputDigest: result.output.sha256,
      outputBytes: result.output.returnedBytes,
      exitCode: null,
    };
  }
  if (result.output.type === "FILE_CHANGED") {
    return {
      status: "SUCCEEDED",
      outputDigest: result.output.sha256,
      outputBytes: result.output.bytes,
      exitCode: null,
    };
  }
  if (result.output.type === "FILE_DELETED") {
    return {
      status: "SUCCEEDED",
      outputDigest: result.output.previousSha256,
      outputBytes: null,
      exitCode: null,
    };
  }
  if (result.output.type === "RECIPE") {
    return {
      status: "SUCCEEDED",
      outputDigest: sha256(result.output.output),
      outputBytes: Buffer.byteLength(result.output.output, "utf8"),
      exitCode: result.output.exitCode,
    };
  }
  return {
    status: "SUCCEEDED",
    outputDigest: sha256(JSON.stringify(result.output.entries)),
    outputBytes: Buffer.byteLength(JSON.stringify(result.output.entries), "utf8"),
    exitCode: null,
  };
};

const secretRedactions = (source: EnvironmentSource, paths: readonly string[]): readonly string[] => [
  ...paths,
  ...Object.entries(source)
    .filter(
      ([name, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|PASSCODE|COOKIE|AUTH|PRIVATE_KEY|API_KEY)/iu.test(name) &&
        typeof value === "string" &&
        value.length >= 6,
    )
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string"),
];

const redact = (value: string, redactions: readonly string[]): string => {
  let result = value.replace(/\r\n?/gu, "\n");
  for (const secret of [...new Set(redactions.filter((candidate) => candidate.length >= 3))].sort(
    (left, right) => right.length - left.length,
  )) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
};

const canonicalRoot = async (workspacePath: string): Promise<string> => {
  const requested = resolve(workspacePath);
  const metadata = await lstat(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new WorkspaceExecutorError("AUDIT_UNAVAILABLE", "The workspace root is not a regular directory");
  }
  return realpath(requested);
};

type ResolvedToolPath = { absolute: string; exists: boolean };

const resolveToolPath = async (input: {
  root: string;
  segments: readonly string[];
  platform: Platform;
  createParents?: boolean;
}): Promise<ResolvedToolPath | WorkspaceToolFailure> => {
  let cursor = input.root;
  for (const [index, segment] of input.segments.entries()) {
    const next = join(cursor, segment);
    const final = index === input.segments.length - 1;
    let metadata;
    try {
      metadata = await lstat(next);
    } catch (error: unknown) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
        return failure("READ_FILE", "FAILED", "INTERNAL_ERROR", "The workspace path could not be inspected");
      }
      if (input.createParents === true && !final) {
        try {
          await mkdir(next, { mode: 0o700 });
          metadata = await lstat(next);
        } catch {
          return failure("WRITE_FILE", "FAILED", "INTERNAL_ERROR", "A parent directory could not be created");
        }
      } else {
        if (!final) {
          return failure("READ_FILE", "FAILED", "TARGET_NOT_FOUND", "A workspace path component is missing");
        }
        if (!inside(input.root, next, input.platform)) {
          return failure(
            "READ_FILE",
            "DENIED",
            "PATH_OUTSIDE_WORKSPACE",
            "The requested path is outside the workspace",
          );
        }
        return { absolute: next, exists: false };
      }
    }
    if (metadata.isSymbolicLink()) {
      return failure("READ_FILE", "DENIED", "SYMLINK_FORBIDDEN", "Symbolic links are not available to tools");
    }
    if (!final && !metadata.isDirectory()) {
      return failure(
        "READ_FILE",
        "DENIED",
        "TARGET_TYPE_FORBIDDEN",
        "A workspace path component is not a directory",
      );
    }
    const canonical = await realpath(next).catch(() => null);
    if (canonical === null || !inside(input.root, canonical, input.platform)) {
      return failure(
        "READ_FILE",
        "DENIED",
        "PATH_OUTSIDE_WORKSPACE",
        "The requested path is outside the workspace",
      );
    }
    cursor = canonical;
  }
  return { absolute: cursor, exists: true };
};

const normalizeFailureOperation = (
  candidate: ResolvedToolPath | WorkspaceToolFailure,
  operation: WorkspaceToolRequest["operation"],
): ResolvedToolPath | WorkspaceToolFailure =>
  "status" in candidate ? { ...candidate, operation } : candidate;

const recipeStillCurrent = (
  captured: VerificationPlan,
  current: VerificationPlan | null,
  recipeId: string,
): VerificationRecipe | null => {
  if (
    current?.status !== "ACTIVE" ||
    current.id !== captured.id ||
    current.revision !== captured.revision ||
    current.contentHash !== captured.contentHash
  ) {
    return null;
  }
  return captured.recipes.find((candidate) => candidate.id === recipeId) ?? null;
};

export const createWorkspaceToolExecutor = async (
  input: CreateWorkspaceToolExecutorInput,
): Promise<WorkspaceToolExecutor> => {
  const platform = input.platform ?? supportedPlatform(process.platform);
  const root = await canonicalRoot(input.workspacePath);
  const environment = input.systemEnvironment ?? process.env;
  const redactions = secretRedactions(environment, [
    root,
    input.artifactsDirectory,
    input.processRegistryDirectory,
  ]);
  const capturedPlan = input.verificationPlan?.status === "ACTIVE" ? input.verificationPlan : null;
  const auditTargetFor = (request: WorkspaceToolRequest): string => {
    if (request.operation === "RUN_RECIPE") {
      return capturedPlan?.recipes.some(({ id }) => id === request.recipeId) === true
        ? request.recipeId
        : "[unapproved recipe]";
    }
    const segments = pathSegments(request.path, request.operation === "LIST_DIRECTORY");
    if (segments === null) return "[invalid path]";
    if (secretPath(segments)) return "[protected path]";
    const sanitized = redact(segments.length === 0 ? "." : segments.join("/"), redactions);
    return sanitized.length <= 240 ? sanitized : "[redacted path]";
  };
  const policyDigest = sha256(
    JSON.stringify({
      schemaVersion: 1,
      root: sha256(platform === "win32" ? root.toLowerCase() : root),
      access: input.access,
      networkAccess: input.networkAccess,
      plan:
        capturedPlan === null
          ? null
          : { id: capturedPlan.id, revision: capturedPlan.revision, contentHash: capturedPlan.contentHash },
      limits: {
        maxCalls: WORKSPACE_TOOL_MAX_CALLS,
        maxReadBytes: WORKSPACE_TOOL_MAX_READ_BYTES,
        maxWriteBytes: WORKSPACE_TOOL_MAX_WRITE_BYTES,
        maxEditFragmentBytes: WORKSPACE_TOOL_MAX_EDIT_FRAGMENT_BYTES,
        maxDirectoryEntries: WORKSPACE_TOOL_MAX_DIRECTORY_ENTRIES,
      },
    }),
  );
  let calls = 0;

  const describePolicy = () => ({
    access: input.access,
    recipes:
      capturedPlan?.recipes
        .map(({ id, label }) => ({ id, label }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) ?? [],
    limits: {
      maxCalls: WORKSPACE_TOOL_MAX_CALLS,
      maxReadBytes: WORKSPACE_TOOL_MAX_READ_BYTES,
      maxWriteBytes: WORKSPACE_TOOL_MAX_WRITE_BYTES,
      maxEditFragmentBytes: WORKSPACE_TOOL_MAX_EDIT_FRAGMENT_BYTES,
      maxDirectoryEntries: WORKSPACE_TOOL_MAX_DIRECTORY_ENTRIES,
    },
  });

  const perform = async (
    request: WorkspaceToolRequest,
    signal: AbortSignal,
    durableCallId: string,
  ): Promise<WorkspaceToolResult> => {
    signal.throwIfAborted();
    if (request.operation !== "RUN_RECIPE") {
      const segments = pathSegments(request.path, request.operation === "LIST_DIRECTORY");
      if (segments === null) {
        return failure(request.operation, "DENIED", "PATH_INVALID", "The tool path is not portable");
      }
      if (secretPath(segments)) {
        return failure(
          request.operation,
          "DENIED",
          "PATH_FORBIDDEN",
          "Credential and repository-control paths are not available to tools",
        );
      }
      if (request.operation === "LIST_DIRECTORY") {
        const located = normalizeFailureOperation(
          await resolveToolPath({ root, segments, platform }),
          request.operation,
        );
        if ("status" in located) return located;
        if (!located.exists) {
          return failure(request.operation, "FAILED", "TARGET_NOT_FOUND", "The directory does not exist");
        }
        const metadata = await lstat(located.absolute);
        if (!metadata.isDirectory()) {
          return failure(
            request.operation,
            "DENIED",
            "TARGET_TYPE_FORBIDDEN",
            "The requested target is not a directory",
          );
        }
        const entries = await readdir(located.absolute, { withFileTypes: true });
        if (entries.length > WORKSPACE_TOOL_MAX_DIRECTORY_ENTRIES) {
          return failure(
            request.operation,
            "FAILED",
            "SIZE_LIMIT_REACHED",
            "The directory exceeds the entry limit",
          );
        }
        let omittedSecretEntries = 0;
        const visible: { name: string; type: "FILE" | "DIRECTORY" }[] = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (isSecretSegment(entry.name)) {
            omittedSecretEntries += 1;
            continue;
          }
          if (entry.isSymbolicLink()) continue;
          if (entry.isFile()) visible.push({ name: entry.name, type: "FILE" });
          else if (entry.isDirectory()) visible.push({ name: entry.name, type: "DIRECTORY" });
        }
        if (Buffer.byteLength(JSON.stringify(visible), "utf8") > MAX_TOOL_RESULT_BYTES) {
          return failure(
            request.operation,
            "FAILED",
            "SIZE_LIMIT_REACHED",
            "The directory listing exceeds the tool result limit",
          );
        }
        return {
          status: "SUCCEEDED",
          operation: request.operation,
          output: { type: "DIRECTORY", entries: visible, omittedSecretEntries },
        };
      }

      if (request.operation === "READ_FILE") {
        const located = normalizeFailureOperation(
          await resolveToolPath({ root, segments, platform }),
          request.operation,
        );
        if ("status" in located) return located;
        if (!located.exists) {
          return failure(request.operation, "FAILED", "TARGET_NOT_FOUND", "The file does not exist");
        }
        const metadata = await lstat(located.absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          return failure(
            request.operation,
            "DENIED",
            "TARGET_TYPE_FORBIDDEN",
            "The requested target is not a regular file",
          );
        }
        if (metadata.size > MAX_VISIBLE_FILE_BYTES) {
          return failure(
            request.operation,
            "FAILED",
            "SIZE_LIMIT_REACHED",
            "The file exceeds the read limit",
          );
        }
        const bytes = await readFile(located.absolute);
        const sha = sha256(bytes);
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return failure(
            request.operation,
            "DENIED",
            "CONTENT_INVALID",
            "Only UTF-8 text files are readable",
          );
        }
        let start = Math.min(request.offsetBytes, bytes.byteLength);
        while (start < bytes.byteLength && (bytes[start] ?? 0) >= 0x80 && (bytes[start] ?? 0) < 0xc0) {
          start += 1;
        }
        let end = Math.min(bytes.byteLength, start + request.limitBytes);
        while (
          end < bytes.byteLength &&
          end > start &&
          (bytes[end] ?? 0) >= 0x80 &&
          (bytes[end] ?? 0) < 0xc0
        ) {
          end -= 1;
        }
        const chunk = bytes.subarray(start, end);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(chunk);
        } catch {
          return failure(
            request.operation,
            "DENIED",
            "CONTENT_INVALID",
            "Only UTF-8 text files are readable",
          );
        }
        return {
          status: "SUCCEEDED",
          operation: request.operation,
          output: {
            type: "FILE",
            content: redact(content, redactions),
            sha256: sha,
            offsetBytes: start,
            returnedBytes: chunk.byteLength,
            totalBytes: bytes.byteLength,
            truncated: end < bytes.byteLength,
          },
        };
      }

      if (input.access !== "READ_WRITE") {
        return failure(
          request.operation,
          "DENIED",
          "WORKSPACE_ACCESS_DENIED",
          "The active AgentRun is read-only",
          true,
        );
      }
      const located = normalizeFailureOperation(
        await resolveToolPath({
          root,
          segments,
          platform,
          ...(request.operation === "WRITE_FILE" ? { createParents: true } : {}),
        }),
        request.operation,
      );
      if ("status" in located) return located;

      if (request.operation === "DELETE_FILE") {
        if (!located.exists) {
          return failure(request.operation, "FAILED", "TARGET_NOT_FOUND", "The file does not exist");
        }
        const metadata = await lstat(located.absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          return failure(
            request.operation,
            "DENIED",
            "TARGET_TYPE_FORBIDDEN",
            "Only a regular file can be deleted",
          );
        }
        const current = await readFile(located.absolute);
        const currentSha = sha256(current);
        if (currentSha !== request.expectedSha256) {
          return failure(
            request.operation,
            "FAILED",
            "CONTENT_CONFLICT",
            "The file changed after it was read",
          );
        }
        signal.throwIfAborted();
        await unlink(located.absolute);
        return {
          status: "SUCCEEDED",
          operation: request.operation,
          output: { type: "FILE_DELETED", previousSha256: currentSha },
        };
      }

      if (request.operation === "EDIT_FILE") {
        if (!located.exists) {
          return failure(request.operation, "FAILED", "TARGET_NOT_FOUND", "The file does not exist");
        }
        const metadata = await lstat(located.absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          return failure(
            request.operation,
            "DENIED",
            "TARGET_TYPE_FORBIDDEN",
            "Only a regular file can be edited",
          );
        }
        if (metadata.size > WORKSPACE_TOOL_MAX_WRITE_BYTES) {
          return failure(
            request.operation,
            "FAILED",
            "SIZE_LIMIT_REACHED",
            "The file exceeds the editable size limit",
          );
        }
        const current = await readFile(located.absolute);
        const currentSha = sha256(current);
        if (currentSha !== request.expectedSha256) {
          return failure(
            request.operation,
            "FAILED",
            "CONTENT_CONFLICT",
            "The file changed after it was read",
          );
        }
        let source: string;
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(current);
        } catch {
          return failure(
            request.operation,
            "DENIED",
            "CONTENT_INVALID",
            "Only UTF-8 text files are editable",
          );
        }
        if (request.oldText.includes("\u0000") || request.newText.includes("\u0000")) {
          return failure(request.operation, "DENIED", "CONTENT_INVALID", "Edit fragments cannot contain NUL");
        }
        const match = source.indexOf(request.oldText);
        if (match < 0 || source.includes(request.oldText, match + 1)) {
          return failure(
            request.operation,
            "FAILED",
            "CONTENT_CONFLICT",
            "The exact old fragment must occur once",
          );
        }
        const edited = `${source.slice(0, match)}${request.newText}${source.slice(match + request.oldText.length)}`;
        const content = Buffer.from(edited, "utf8");
        if (content.byteLength > WORKSPACE_TOOL_MAX_WRITE_BYTES) {
          return failure(
            request.operation,
            "FAILED",
            "SIZE_LIMIT_REACHED",
            "The edited file exceeds the write limit",
          );
        }
        signal.throwIfAborted();
        const temporary = join(
          dirname(located.absolute),
          `.${basename(located.absolute)}.loomrail-${randomUUID()}`,
        );
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(content);
          await handle.sync();
          await handle.close();
          const finalCheck = await lstat(located.absolute).catch(() => null);
          if (finalCheck?.isSymbolicLink() === true || (finalCheck !== null && !finalCheck.isFile())) {
            await rm(temporary, { force: true });
            return failure(
              request.operation,
              "DENIED",
              "TARGET_TYPE_FORBIDDEN",
              "The destination changed to a forbidden target",
            );
          }
          const finalSha = finalCheck === null ? null : sha256(await readFile(located.absolute));
          if (finalSha !== currentSha) {
            await rm(temporary, { force: true });
            return failure(
              request.operation,
              "FAILED",
              "CONTENT_CONFLICT",
              "The file changed before the atomic edit",
            );
          }
          signal.throwIfAborted();
          await rename(temporary, located.absolute);
        } catch (error: unknown) {
          await handle.close().catch(() => undefined);
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        return {
          status: "SUCCEEDED",
          operation: request.operation,
          output: { type: "FILE_CHANGED", sha256: sha256(content), bytes: content.byteLength },
        };
      }

      const content = Buffer.from(request.content, "utf8");
      if (request.content.includes("\u0000")) {
        return failure(request.operation, "DENIED", "CONTENT_INVALID", "File content cannot contain NUL");
      }
      if (located.exists) {
        const metadata = await lstat(located.absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          return failure(
            request.operation,
            "DENIED",
            "TARGET_TYPE_FORBIDDEN",
            "Only a regular file can be replaced",
          );
        }
        const currentSha = sha256(await readFile(located.absolute));
        if (request.expectedSha256 === null || currentSha !== request.expectedSha256) {
          return failure(
            request.operation,
            "FAILED",
            "CONTENT_CONFLICT",
            "The file existence or digest does not match the requested change",
          );
        }
      } else if (request.expectedSha256 !== null) {
        return failure(request.operation, "FAILED", "CONTENT_CONFLICT", "The expected file does not exist");
      }
      signal.throwIfAborted();
      const temporary = join(
        dirname(located.absolute),
        `.${basename(located.absolute)}.loomrail-${randomUUID()}`,
      );
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        const finalCheck = await lstat(located.absolute).catch(() => null);
        if (finalCheck?.isSymbolicLink() === true || (finalCheck !== null && !finalCheck.isFile())) {
          await rm(temporary, { force: true });
          return failure(
            request.operation,
            "DENIED",
            "TARGET_TYPE_FORBIDDEN",
            "The destination changed to a forbidden target",
          );
        }
        signal.throwIfAborted();
        await rename(temporary, located.absolute);
      } catch (error: unknown) {
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      return {
        status: "SUCCEEDED",
        operation: request.operation,
        output: { type: "FILE_CHANGED", sha256: sha256(content), bytes: content.byteLength },
      };
    }

    if (capturedPlan === null) {
      return failure(
        request.operation,
        "DENIED",
        "RECIPE_NOT_APPROVED",
        "No active owner-approved Verification Plan is available",
        true,
      );
    }
    const recipe = recipeStillCurrent(capturedPlan, input.readCurrentVerificationPlan(), request.recipeId);
    if (recipe === null) {
      const known = capturedPlan.recipes.some(({ id }) => id === request.recipeId);
      return failure(
        request.operation,
        "DENIED",
        known ? "RECIPE_AUTHORITY_CHANGED" : "RECIPE_NOT_APPROVED",
        known
          ? "The owner-approved Verification Plan changed before execution"
          : "The requested recipe is not owner-approved",
        true,
      );
    }
    if (recipe.networkPolicy === "DENIED_UNAVAILABLE" || !input.networkAccess) {
      return failure(
        request.operation,
        "DENIED",
        "NETWORK_POLICY_UNAVAILABLE",
        "The recipe network policy cannot be enforced for this AgentRun",
        true,
      );
    }
    const artifactId = input.createArtifactId?.() ?? `workspace-tool-${randomUUID()}`;
    await prepareVerificationProcessIntent(input.processRegistryDirectory, durableCallId);
    let execution;
    try {
      execution = await executeVerificationRecipe({
        recipe,
        worktreePath: root,
        artifactDirectory: input.artifactsDirectory,
        artifactId,
        platform,
        systemEnvironment: environment,
        signal,
        processGuard: { runId: durableCallId, registryDirectory: input.processRegistryDirectory },
      });
    } finally {
      // A termination failure deliberately keeps the proof for startup; all other outcomes are
      // safe to remove after the caller records the terminal audit below.
    }
    const rawOutput =
      execution.artifactPath === null
        ? ""
        : await readFile(execution.artifactPath, "utf8").finally(() =>
            rm(execution.artifactPath ?? "", { force: true }).catch(() => undefined),
          );
    const redactedOutput = redact(rawOutput, redactions);
    const outputBytes = Buffer.from(redactedOutput, "utf8");
    let outputEnd = Math.min(outputBytes.byteLength, MAX_TOOL_RESULT_BYTES);
    while (
      outputEnd < outputBytes.byteLength &&
      outputEnd > 0 &&
      (outputBytes[outputEnd] ?? 0) >= 0x80 &&
      (outputBytes[outputEnd] ?? 0) < 0xc0
    ) {
      outputEnd -= 1;
    }
    const boundedOutput =
      outputBytes.byteLength <= MAX_TOOL_RESULT_BYTES
        ? redactedOutput
        : new TextDecoder("utf-8", { fatal: true }).decode(outputBytes.subarray(0, outputEnd));
    const observation = execution.observation;
    if (observation.status === "PASSED" || observation.status === "FAILED") {
      await removeVerificationProcessRecord(input.processRegistryDirectory, durableCallId);
      return {
        status: "SUCCEEDED",
        operation: request.operation,
        output: {
          type: "RECIPE",
          recipeId: request.recipeId,
          outcome: observation.status,
          exitCode: observation.exitCode,
          output: boundedOutput,
          truncated: observation.output.truncated || outputBytes.byteLength > MAX_TOOL_RESULT_BYTES,
          durationMs: observation.durationMs,
        },
      };
    }
    if (observation.status === "INTERRUPTED") {
      await removeVerificationProcessRecord(input.processRegistryDirectory, durableCallId);
      return failure(request.operation, "FAILED", "CANCELLED", "The approved recipe was cancelled");
    }
    if (observation.errorCode === "PROCESS_TERMINATION_FAILED") {
      throw new WorkspaceExecutorError(
        "PROCESS_AUTHORITY_UNCERTAIN",
        "The approved recipe process tree could not be proven stopped",
      );
    }
    await removeVerificationProcessRecord(input.processRegistryDirectory, durableCallId);
    const code: WorkspaceToolFailureCode =
      observation.errorCode === "TIMED_OUT"
        ? "DEADLINE_EXCEEDED"
        : observation.errorCode === "OUTPUT_LIMIT_REACHED"
          ? "OUTPUT_LIMIT_REACHED"
          : observation.errorCode === "POLICY_UNAVAILABLE"
            ? "NETWORK_POLICY_UNAVAILABLE"
            : observation.errorCode === "RECIPE_NOT_APPROVED"
              ? "RECIPE_AUTHORITY_CHANGED"
              : "PROCESS_FAILED";
    return failure(request.operation, "FAILED", code, "The approved recipe could not complete safely");
  };

  return {
    describePolicy,
    execute: async (candidate, signal) => {
      const request = workspaceToolRequestSchema.parse(candidate);
      const cancelled = (): boolean => signal.aborted;
      if (cancelled()) {
        return failure(request.operation, "FAILED", "CANCELLED", "The workspace operation was cancelled");
      }
      calls += 1;
      const providerCallKey = sha256(`${input.providerSessionId}\0${request.callId}`);
      const inputDigest = sha256(JSON.stringify({ ...request, callId: undefined }));
      let reserved: ReturnType<WorkspaceToolAudit["reserve"]>;
      try {
        reserved = input.audit.reserve({
          providerCallKey,
          operation: request.operation,
          target: auditTargetFor(request),
          policyDigest,
          inputDigest,
        });
      } catch (error: unknown) {
        throw new WorkspaceExecutorError("AUDIT_UNAVAILABLE", "The workspace tool audit could not start", {
          cause: error,
        });
      }
      if (reserved.replayed) {
        return failure(
          request.operation,
          reserved.call.status === "UNKNOWN_OUTCOME" ? "UNKNOWN_OUTCOME" : "FAILED",
          reserved.call.status === "UNKNOWN_OUTCOME" ? "DAEMON_RESTART" : "REPLAYED_WITHOUT_OUTPUT",
          "This side effect was already recorded and will not be executed again",
        );
      }
      let result: WorkspaceToolResult;
      try {
        result =
          calls > WORKSPACE_TOOL_MAX_CALLS
            ? failure(request.operation, "FAILED", "SIZE_LIMIT_REACHED", "The tool-call limit was reached")
            : await perform(request, signal, reserved.call.id);
      } catch (error: unknown) {
        if (error instanceof WorkspaceExecutorError && error.code === "PROCESS_AUTHORITY_UNCERTAIN") {
          throw error;
        }
        result = failure(
          request.operation,
          "FAILED",
          cancelled() ? "CANCELLED" : "INTERNAL_ERROR",
          cancelled() ? "The workspace operation was cancelled" : "The workspace operation failed safely",
        );
      }
      try {
        input.audit.finish(
          reserved.call.id,
          result.status === "SUCCEEDED" ? successOutcome(result) : failureOutcome(result),
        );
      } catch (error: unknown) {
        throw new WorkspaceExecutorError("AUDIT_UNAVAILABLE", "The workspace tool audit could not finish", {
          cause: error,
        });
      }
      return result;
    },
  };
};
