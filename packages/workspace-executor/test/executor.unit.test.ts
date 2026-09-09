import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  VerificationPlan,
  WorkspaceToolCallRecord,
  WorkspaceToolTerminalOutcome,
} from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceToolExecutor, type WorkspaceToolAudit } from "../src/index.js";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);
const now = "2026-09-07T08:00:00.000Z";

const createAudit = () => {
  const calls = new Map<string, WorkspaceToolCallRecord>();
  let ordinal = 0;
  const audit: WorkspaceToolAudit = {
    reserve: (input) => {
      const existing = calls.get(input.providerCallKey);
      if (existing !== undefined) return { call: existing, replayed: true };
      const call: WorkspaceToolCallRecord = {
        schemaVersion: 1,
        id: `workspace-call-${(ordinal += 1).toString()}`,
        projectId: "project-1",
        workItemId: "work-item-1",
        stageAttemptId: "attempt-1",
        agentRunId: "agent-run-1",
        providerSessionId: "session-1",
        ...input,
        status: "STARTED",
        failureCode: null,
        outputDigest: null,
        outputBytes: null,
        exitCode: null,
        startedAt: now,
        finishedAt: null,
      };
      calls.set(input.providerCallKey, call);
      return { call, replayed: false };
    },
    finish: (callId, outcome: WorkspaceToolTerminalOutcome) => {
      const current = [...calls.values()].find(({ id }) => id === callId);
      if (current === undefined) throw new Error("missing call");
      const call: WorkspaceToolCallRecord = {
        ...current,
        status: outcome.status,
        failureCode: outcome.status === "SUCCEEDED" ? null : outcome.failureCode,
        outputDigest: outcome.outputDigest,
        outputBytes: outcome.outputBytes,
        exitCode: outcome.exitCode,
        finishedAt: now,
      };
      calls.set(call.providerCallKey, call);
      return { call, replayed: false };
    },
  };
  return { audit, calls };
};

describe("provider-neutral workspace executor", () => {
  const roots: string[] = [];

  const setup = async (
    access: "READ_ONLY" | "READ_WRITE" = "READ_WRITE",
    platform?: "win32",
    systemEnvironment?: Readonly<Record<string, string>>,
  ) => {
    const root = await mkdtemp(join(tmpdir(), "loomrail workspace tools "));
    roots.push(root);
    const workspace = join(root, "working tree with spaces-ёж");
    const artifacts = join(root, "artifacts");
    const processes = join(root, "process proofs");
    await mkdir(workspace);
    const { audit, calls } = createAudit();
    const executor = await createWorkspaceToolExecutor({
      workspacePath: workspace,
      access,
      networkAccess: true,
      providerSessionId: "session-1",
      verificationPlan: null,
      readCurrentVerificationPlan: () => null,
      audit,
      artifactsDirectory: artifacts,
      processRegistryDirectory: processes,
      ...(platform === undefined ? {} : { platform }),
      ...(systemEnvironment === undefined ? {} : { systemEnvironment }),
    });
    return { root, workspace, artifacts, processes, executor, calls, audit };
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reads and changes Unicode paths with CAS while auditing every operation", async () => {
    const { workspace, executor, calls } = await setup();
    const signal = new AbortController().signal;
    await writeFile(join(workspace, "résumé файл.txt"), "first\n");
    const read = await executor.execute(
      { callId: "read-1", operation: "READ_FILE", path: "résumé файл.txt", offsetBytes: 0, limitBytes: 1024 },
      signal,
    );
    expect(read).toMatchObject({ status: "SUCCEEDED", output: { type: "FILE", content: "first\n" } });
    const original = sha256("first\n");
    await expect(
      executor.execute(
        {
          callId: "write-1",
          operation: "WRITE_FILE",
          path: "nested dir/новый.txt",
          expectedSha256: null,
          content: "second\n",
        },
        signal,
      ),
    ).resolves.toMatchObject({ status: "SUCCEEDED", output: { type: "FILE_CHANGED" } });
    await expect(
      executor.execute(
        {
          callId: "write-conflict",
          operation: "WRITE_FILE",
          path: "résumé файл.txt",
          expectedSha256: "0".repeat(64),
          content: "lost update\n",
        },
        signal,
      ),
    ).resolves.toMatchObject({ status: "FAILED", code: "CONTENT_CONFLICT" });
    await expect(
      executor.execute(
        { callId: "delete-1", operation: "DELETE_FILE", path: "résumé файл.txt", expectedSha256: original },
        signal,
      ),
    ).resolves.toMatchObject({ status: "SUCCEEDED", output: { type: "FILE_DELETED" } });
    expect(await readFile(join(workspace, "nested dir", "новый.txt"), "utf8")).toBe("second\n");
    expect([...calls.values()]).toHaveLength(4);
    expect(
      [...calls.values()].every(({ status, finishedAt }) => status !== "STARTED" && finishedAt !== null),
    ).toBe(true);
  });

  it("edits one exact fragment in a large Unicode file with CAS without replacing the whole file", async () => {
    const { workspace, executor, calls } = await setup();
    const signal = new AbortController().signal;
    const prefix = "model Account {\n" + "  field String\n".repeat(5_000);
    const original = `${prefix}  projectId String\n}\n`;
    const path = "schema с пробелами.prisma";
    await writeFile(join(workspace, path), original);

    const result = await executor.execute(
      {
        callId: "edit-1",
        operation: "EDIT_FILE",
        path,
        expectedSha256: sha256(original),
        oldText: "  projectId String\n",
        newText: "  projectId String?\n  scope MessageScope @default(PROJECT)\n",
      },
      signal,
    );

    const expected = `${prefix}  projectId String?\n  scope MessageScope @default(PROJECT)\n}\n`;
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      operation: "EDIT_FILE",
      output: { type: "FILE_CHANGED", sha256: sha256(expected), bytes: Buffer.byteLength(expected) },
    });
    expect(await readFile(join(workspace, path), "utf8")).toBe(expected);
    expect([...calls.values()].at(-1)).toMatchObject({ operation: "EDIT_FILE", status: "SUCCEEDED" });
    await expect(
      executor.execute(
        {
          callId: "edit-1",
          operation: "EDIT_FILE",
          path,
          expectedSha256: sha256(original),
          oldText: "  projectId String\n",
          newText: "  projectId String?\n  scope MessageScope @default(PROJECT)\n",
        },
        signal,
      ),
    ).resolves.toMatchObject({ status: "FAILED", code: "REPLAYED_WITHOUT_OUTPUT" });
    expect(await readFile(join(workspace, path), "utf8")).toBe(expected);
  });

  it("applies exact-fragment edits under the simulated Windows portable-path policy", async () => {
    const { workspace, executor } = await setup("READ_WRITE", "win32");
    const path = "nested folder/данные file.txt";
    await mkdir(join(workspace, "nested folder"));
    await writeFile(join(workspace, path), "до\n");

    await expect(
      executor.execute(
        {
          callId: "edit-windows",
          operation: "EDIT_FILE",
          path,
          expectedSha256: sha256("до\n"),
          oldText: "до",
          newText: "после",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "SUCCEEDED", operation: "EDIT_FILE" });
    expect(await readFile(join(workspace, path), "utf8")).toBe("после\n");
  });

  it("refuses ambiguous, stale, secret, symlink and read-only exact-fragment edits", async () => {
    const { root, workspace, executor } = await setup();
    const signal = new AbortController().signal;
    await writeFile(join(workspace, "ambiguous.txt"), "same\nsame\n");
    await writeFile(join(workspace, ".env"), "TOKEN=secret\n");
    await writeFile(join(root, "outside.txt"), "outside\n");
    await symlink(join(root, "outside.txt"), join(workspace, "escape.txt"));

    await expect(
      executor.execute(
        {
          callId: "edit-ambiguous",
          operation: "EDIT_FILE",
          path: "ambiguous.txt",
          expectedSha256: sha256("same\nsame\n"),
          oldText: "same",
          newText: "changed",
        },
        signal,
      ),
    ).resolves.toMatchObject({ status: "FAILED", code: "CONTENT_CONFLICT" });
    await expect(
      executor.execute(
        {
          callId: "edit-absent",
          operation: "EDIT_FILE",
          path: "ambiguous.txt",
          expectedSha256: sha256("same\nsame\n"),
          oldText: "missing",
          newText: "changed",
        },
        signal,
      ),
    ).resolves.toMatchObject({ status: "FAILED", code: "CONTENT_CONFLICT" });
    await expect(
      executor.execute(
        {
          callId: "edit-nul",
          operation: "EDIT_FILE",
          path: "ambiguous.txt",
          expectedSha256: sha256("same\nsame\n"),
          oldText: "same\nsame",
          newText: "changed\u0000value",
        },
        signal,
      ),
    ).resolves.toMatchObject({ status: "DENIED", code: "CONTENT_INVALID" });
    await expect(
      executor.execute(
        {
          callId: "edit-stale",
          operation: "EDIT_FILE",
          path: "ambiguous.txt",
          expectedSha256: "0".repeat(64),
          oldText: "same\nsame",
          newText: "changed",
        },
        signal,
      ),
    ).resolves.toMatchObject({ status: "FAILED", code: "CONTENT_CONFLICT" });
    for (const [callId, path] of [
      ["edit-secret", ".env"],
      ["edit-symlink", "escape.txt"],
      ["edit-traversal", "../outside.txt"],
    ] as const) {
      const result = await executor.execute(
        {
          callId,
          operation: "EDIT_FILE",
          path,
          expectedSha256: sha256("outside\n"),
          oldText: "outside",
          newText: "changed",
        },
        signal,
      );
      expect(result.status).not.toBe("SUCCEEDED");
    }

    const readOnly = await setup("READ_ONLY");
    await writeFile(join(readOnly.workspace, "file.txt"), "before\n");
    await expect(
      readOnly.executor.execute(
        {
          callId: "edit-readonly",
          operation: "EDIT_FILE",
          path: "file.txt",
          expectedSha256: sha256("before\n"),
          oldText: "before",
          newText: "after",
        },
        signal,
      ),
    ).resolves.toMatchObject({ status: "DENIED", code: "WORKSPACE_ACCESS_DENIED" });
  });

  it("denies traversal, credential paths, symlinks and read-only mutation on portable paths", async () => {
    const { root, workspace, executor, calls } = await setup("READ_ONLY", "win32");
    const signal = new AbortController().signal;
    await writeFile(join(root, "outside.txt"), "outside");
    await symlink(join(root, "outside.txt"), join(workspace, "escape.txt"));
    await writeFile(join(workspace, ".env"), "OPENAI_API_KEY=not-for-models\n");
    const requests = [
      { callId: "traversal", operation: "READ_FILE", path: "../outside.txt", offsetBytes: 0, limitBytes: 10 },
      { callId: "absolute", operation: "READ_FILE", path: "C:\\outside.txt", offsetBytes: 0, limitBytes: 10 },
      { callId: "secret", operation: "READ_FILE", path: ".env", offsetBytes: 0, limitBytes: 10 },
      { callId: "symlink", operation: "READ_FILE", path: "escape.txt", offsetBytes: 0, limitBytes: 10 },
      {
        callId: "readonly",
        operation: "WRITE_FILE",
        path: "allowed.txt",
        expectedSha256: null,
        content: "no",
      },
    ] as const;
    const results = [];
    for (const request of requests) results.push(await executor.execute(request, signal));
    expect(results.map((result) => (result.status === "SUCCEEDED" ? "SUCCEEDED" : result.code))).toEqual([
      "PATH_INVALID",
      "PATH_INVALID",
      "PATH_FORBIDDEN",
      "SYMLINK_FORBIDDEN",
      "WORKSPACE_ACCESS_DENIED",
    ]);
    const auditJson = JSON.stringify([...calls.values()]);
    expect(auditJson).not.toContain(".env");
    expect(auditJson).toContain("[protected path]");

    const cancelled = new AbortController();
    cancelled.abort(new Error("cancel before reservation"));
    const callsBeforeCancellation = calls.size;
    await expect(
      executor.execute(
        { callId: "cancelled", operation: "READ_FILE", path: "allowed.txt", offsetBytes: 0, limitBytes: 10 },
        cancelled.signal,
      ),
    ).resolves.toMatchObject({ status: "FAILED", code: "CANCELLED" });
    expect(calls.size).toBe(callsBeforeCancellation);
  });

  it("redacts environment credentials from readable source files", async () => {
    const apiKey = "fixture-secret-that-must-not-leak";
    const { workspace, executor, calls } = await setup("READ_ONLY", undefined, { OPENAI_API_KEY: apiKey });
    await writeFile(join(workspace, "example.txt"), `fixture = ${apiKey}\n`);

    const result = await executor.execute(
      {
        callId: "read-redacted",
        operation: "READ_FILE",
        path: "example.txt",
        offsetBytes: 0,
        limitBytes: 1024,
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      output: { type: "FILE", content: "fixture = [REDACTED]\n" },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);

    await expect(
      executor.execute(
        {
          callId: "read-secret-shaped-target",
          operation: "READ_FILE",
          path: `${apiKey}.txt`,
          offsetBytes: 0,
          limitBytes: 1024,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "FAILED", code: "TARGET_NOT_FOUND" });
    expect(JSON.stringify([...calls.values()])).not.toContain(apiKey);
    expect([...calls.values()].at(-1)?.target).toBe("[REDACTED].txt");
  });

  it("runs only a still-current approved recipe and returns bounded output", async () => {
    const fixture = await setup();
    const manifest = `${JSON.stringify({
      packageManager: "npm@1.0.0",
      scripts: { test: "node verify.cjs" },
    })}\n`;
    await writeFile(join(fixture.workspace, "package.json"), manifest);
    await writeFile(join(fixture.workspace, "verify.cjs"), 'process.stdout.write("approved output\\n");\n');
    await execFileAsync("git", ["init"], { cwd: fixture.workspace });
    await execFileAsync("git", ["config", "user.email", "loomrail@example.invalid"], {
      cwd: fixture.workspace,
    });
    await execFileAsync("git", ["config", "user.name", "Loomrail Test"], { cwd: fixture.workspace });
    await execFileAsync("git", ["add", "package.json", "verify.cjs"], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: fixture.workspace });
    const recipe: VerificationPlan["recipes"][number] = {
      schemaVersion: 1,
      id: "package-test",
      kind: "UNIT",
      label: "Tests",
      required: true,
      executable: "npm",
      argv: ["run", "test"],
      cwd: ".",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: sha256(manifest),
        scriptName: "test",
        scriptBodyPreview: "node verify.cjs",
      },
    };
    const plan: VerificationPlan = {
      schemaVersion: 1,
      id: "plan-1",
      projectId: "project-1",
      revision: 1,
      status: "ACTIVE",
      recipes: [recipe],
      sourceProposalHash: "a".repeat(64),
      contentHash: "b".repeat(64),
      createdAt: now,
    };
    let current: VerificationPlan | null = plan;
    const executor = await createWorkspaceToolExecutor({
      workspacePath: fixture.workspace,
      access: "READ_WRITE",
      networkAccess: true,
      providerSessionId: "session-recipe",
      verificationPlan: plan,
      readCurrentVerificationPlan: () => current,
      audit: fixture.audit,
      artifactsDirectory: fixture.artifacts,
      processRegistryDirectory: fixture.processes,
    });
    const recipeResult = await executor.execute(
      { callId: "recipe-1", operation: "RUN_RECIPE", recipeId: recipe.id },
      new AbortController().signal,
    );
    expect(recipeResult).toMatchObject({ status: "SUCCEEDED", operation: "RUN_RECIPE" });
    if (recipeResult.status !== "SUCCEEDED" || recipeResult.output.type !== "RECIPE") {
      throw new Error("Expected an approved recipe result");
    }
    expect(recipeResult.output.outcome).toBe("PASSED");
    expect(recipeResult.output.output).toContain("approved output");
    current = { ...plan, revision: 2 };
    await expect(
      executor.execute(
        { callId: "recipe-2", operation: "RUN_RECIPE", recipeId: recipe.id },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "DENIED", code: "RECIPE_AUTHORITY_CHANGED" });

    current = plan;
    const networkDeniedExecutor = await createWorkspaceToolExecutor({
      workspacePath: fixture.workspace,
      access: "READ_WRITE",
      networkAccess: false,
      providerSessionId: "session-network-denied",
      verificationPlan: plan,
      readCurrentVerificationPlan: () => current,
      audit: fixture.audit,
      artifactsDirectory: fixture.artifacts,
      processRegistryDirectory: fixture.processes,
    });
    await expect(
      networkDeniedExecutor.execute(
        { callId: "recipe-network-denied", operation: "RUN_RECIPE", recipeId: recipe.id },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: "DENIED",
      code: "NETWORK_POLICY_UNAVAILABLE",
      approvalRequired: true,
    });
  }, 45_000);
});
