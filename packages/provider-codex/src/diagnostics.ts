import { spawn } from "node:child_process";

import { createCliProviderDiagnostics, type ProviderDiagnosticProbeOptions } from "@loomrail/provider-core";

const AUTH_MODE_OUTPUT_LIMIT_BYTES = 96;
const AUTH_MODE_DEADLINE_MS = 3_000;

export type CodexAuthenticationMode = "CHATGPT" | "OTHER" | "UNKNOWN";

export const classifyCodexAuthenticationMode = (output: string): CodexAuthenticationMode =>
  output.trim() === "Logged in using ChatGPT" ? "CHATGPT" : "OTHER";

const authenticationModeEnvironment = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv => {
  const keys = [
    "PATH",
    "Path",
    "PATHEXT",
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ] as const;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
};

/** Reads only the closed login-mode line needed by the allowance compatibility row. */
export const probeCodexAuthenticationMode = (
  options: ProviderDiagnosticProbeOptions = {},
): Promise<CodexAuthenticationMode> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command ?? "codex", [...(options.commandArgsPrefix ?? []), "login", "status"], {
        env: authenticationModeEnvironment(options.environment),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve("UNKNOWN");
      return;
    }
    let stdoutOutput = Buffer.alloc(0);
    let stderrOutput = Buffer.alloc(0);
    let outputByteLength = 0;
    let settled = false;
    const finish = (mode: CodexAuthenticationMode): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(mode);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("UNKNOWN");
    }, options.deadlineMs ?? AUTH_MODE_DEADLINE_MS);
    timer.unref();
    child.once("error", () => {
      finish("UNKNOWN");
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      child.kill("SIGKILL");
      finish("UNKNOWN");
      return;
    }
    const collectOutput = (stream: NodeJS.ReadableStream, channel: "stdout" | "stderr"): void => {
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (
          outputByteLength + chunk.byteLength >
          (options.outputLimitBytes ?? AUTH_MODE_OUTPUT_LIMIT_BYTES)
        ) {
          child.kill("SIGKILL");
          finish("UNKNOWN");
          return;
        }
        outputByteLength += chunk.byteLength;
        if (channel === "stdout") stdoutOutput = Buffer.concat([stdoutOutput, chunk]);
        else stderrOutput = Buffer.concat([stderrOutput, chunk]);
      });
    };
    collectOutput(stdout, "stdout");
    collectOutput(stderr, "stderr");
    child.once("close", (code) => {
      const stdoutText = stdoutOutput.toString("utf8").trim();
      const stderrText = stderrOutput.toString("utf8").trim();
      const onlyOutput = stdoutText.length === 0 ? stderrText : stderrText.length === 0 ? stdoutText : null;
      finish(code === 0 && onlyOutput !== null ? classifyCodexAuthenticationMode(onlyOutput) : "UNKNOWN");
    });
  });

// Every row is platform- and architecture-scoped; never replace this with versions alone or a
// semver range. Q14 evidence is recorded in docs/evidence/phase-8/Q14-MACOS-LIVE-PROVIDERS-EVIDENCE.md.
const verifiedTargets = [{ version: "0.153.0-alpha.5", platform: "darwin", architecture: "arm64" }] as const;

// Allowance compatibility is deliberately independent from execution compatibility. The App
// Server rate-limit projection was observed live on this exact target, while its execution path is
// not yet admitted. Neither row inherits support through SemVer, OS or architecture similarity.
const rateLimitReportingTargets = [
  { version: "0.153.1", platform: "darwin", architecture: "arm64" },
] as const;

export const codexRateLimitReportingTargetVerified = (
  version: string | null,
  runtimeTarget: { platform: NodeJS.Platform; architecture: NodeJS.Architecture } = {
    platform: process.platform,
    architecture: process.arch,
  },
): boolean =>
  version !== null &&
  rateLimitReportingTargets.some(
    (target) =>
      target.version === version &&
      target.platform === runtimeTarget.platform &&
      target.architecture === runtimeTarget.architecture,
  );

export const codexProviderDiagnostics = createCliProviderDiagnostics({
  command: "codex",
  versionArguments: ["--version"],
  authenticationArguments: ["login", "status"],
  versionFromOutput: (output) => /^codex-cli ([^\s]+)$/.exec(output.trim())?.[1] ?? null,
  verifiedTargets,
});
