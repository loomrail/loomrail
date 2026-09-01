import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertMcpRevisionExecutable,
  McpGatewayError,
  resolveMcpProfileCandidate,
} from "../src/preflight.js";

describe("MCP profile preflight", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail MCP preflight "));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const candidate = (executable: string, args: string[] = []) => ({
    profileId: null,
    name: "Локальные документы",
    executable,
    args,
    declaredTools: ["search_docs", "read_doc"],
  });

  it("canonicalizes executable and script symlinks before consent", async () => {
    const runtimeDirectory = join(directory, "runtime with spaces");
    const executable = join(runtimeDirectory, "node");
    const executableLink = join(directory, "node-link");
    const scriptDirectory = join(directory, "папка со скриптом");
    const script = join(scriptDirectory, "server.mjs");
    const scriptLink = join(directory, "server link.mjs");
    await Promise.all([mkdir(runtimeDirectory), mkdir(scriptDirectory)]);
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
    await symlink(executable, executableLink);
    await writeFile(script, "", "utf8");
    await symlink(script, scriptLink);

    const resolved = await resolveMcpProfileCandidate(candidate(executableLink, [scriptLink, "--safe"]));
    const canonicalExecutable = await realpath(executable);
    const canonicalScript = await realpath(script);

    expect(resolved).toEqual({
      ...candidate(canonicalExecutable, [canonicalScript, "--safe"]),
      declaredTools: ["read_doc", "search_docs"],
    });
  });

  it("rejects directories and non-executable files", async () => {
    const executable = join(directory, "not executable");
    await writeFile(executable, "", "utf8");

    await expect(resolveMcpProfileCandidate(candidate(directory))).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_FILE",
    } satisfies Partial<McpGatewayError>);
    await expect(resolveMcpProfileCandidate(candidate(executable))).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_ALLOWED",
    } satisfies Partial<McpGatewayError>);
  });

  it("detects path drift when the consented executable path is replaced with a symlink", async () => {
    const first = join(directory, "first-server");
    const second = join(directory, "second-server");
    await Promise.all([writeFile(first, "#!/bin/sh\n", "utf8"), writeFile(second, "#!/bin/sh\n", "utf8")]);
    await Promise.all([chmod(first, 0o755), chmod(second, 0o755)]);
    const resolved = await resolveMcpProfileCandidate(candidate(first));
    await rm(first);
    await symlink(second, first);

    await expect(
      assertMcpRevisionExecutable({
        schemaVersion: 1,
        id: "revision-one",
        projectId: "project-one",
        revision: 1,
        ...resolved,
        profileId: "profile-one",
        canonicalDigest: "0".repeat(64),
        createdAt: "2026-08-31T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONSENT_MISMATCH" });
  });
});
