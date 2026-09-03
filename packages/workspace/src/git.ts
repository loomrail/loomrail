import { spawn } from "node:child_process";

export type GitResult = {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number;
};

export type GitOptions = {
  cwd: string;
  // Passed straight to `child_process.spawn` -- this REPLACES the child's environment rather than
  // merging with `process.env`. A caller that needs one extra variable (e.g. GIT_INDEX_FILE) and
  // passes only that loses PATH, and `spawn` resolves "git" through PATH, so git will not run at
  // all. Spread `process.env` yourself: `{ ...process.env, GIT_INDEX_FILE: path }`.
  env?: Readonly<Record<string, string>>;
  // The process is always drained to completion, but bytes beyond these capture limits are
  // counted and discarded before they can accumulate in daemon memory.
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type GitOutputLimits = Pick<GitOptions, "maxStdoutBytes" | "maxStderrBytes">;

export class GitInputError extends Error {
  readonly code = "INVALID_OUTPUT_LIMIT";

  constructor(field: "maxStdoutBytes" | "maxStderrBytes") {
    super(`${field} must be a non-negative safe integer`);
    this.name = "GitInputError";
  }
}

// Thrown only when the `git` executable itself cannot be found or started. A non-zero exit code
// from a `git` invocation that did run is not an error -- it is data the caller inspects via
// GitResult.exitCode (spec §2.11: different exit codes mean different reasons).
export class GitMissingError extends Error {
  constructor(cause: unknown) {
    super("git executable was not found", { cause });
    this.name = "GitMissingError";
  }
}

// Runs `git` as a child process with an argv array (never a shell string) and hands its exit code
// back as data. Invalid output limits reject with GitInputError; a launch failure rejects with
// GitMissingError. A command that did start always resolves, including on a non-zero exit code.
export const runGit = (args: readonly string[], options: GitOptions): Promise<GitResult> => {
  for (const field of ["maxStdoutBytes", "maxStderrBytes"] as const) {
    const value = options[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return Promise.reject(new GitInputError(field));
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = (limit: number | undefined) => {
      const chunks: Buffer[] = [];
      let capturedBytes = 0;
      let totalBytes = 0;
      return {
        append: (chunk: Buffer): void => {
          totalBytes += chunk.byteLength;
          const remaining = limit === undefined ? chunk.byteLength : Math.max(0, limit - capturedBytes);
          if (remaining === 0) return;
          const kept = Math.min(remaining, chunk.byteLength);
          chunks.push(Buffer.from(chunk.subarray(0, kept)));
          capturedBytes += kept;
        },
        result: (): { text: string; bytes: number; truncated: boolean } => ({
          text: Buffer.concat(chunks, capturedBytes).toString("utf8"),
          bytes: totalBytes,
          truncated: totalBytes > capturedBytes,
        }),
      };
    };
    const stdout = capture(options.maxStdoutBytes);
    const stderr = capture(options.maxStderrBytes);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });

    child.on("error", (error: unknown) => {
      reject(new GitMissingError(error));
    });

    child.on("close", (exitCode: number | null) => {
      const capturedStdout = stdout.result();
      const capturedStderr = stderr.result();
      resolve({
        stdout: capturedStdout.text,
        stderr: capturedStderr.text,
        stdoutBytes: capturedStdout.bytes,
        stderrBytes: capturedStderr.bytes,
        stdoutTruncated: capturedStdout.truncated,
        stderrTruncated: capturedStderr.truncated,
        exitCode: exitCode ?? -1,
      });
    });
  });
};

// Runs a git plumbing command against a temporary index rather than the repository's real one, so
// the caller never touches the owner's actual index. `env` is spread over `process.env` rather
// than passed alone -- GitOptions.env replaces the child's environment, and passing only
// GIT_INDEX_FILE would drop PATH and leave `spawn` unable to find "git" at all.
export const runGitWithIndex = (
  args: readonly string[],
  cwd: string,
  indexFile: string,
  limits: GitOutputLimits = {},
): Promise<GitResult> => runGit(args, { cwd, env: { ...process.env, GIT_INDEX_FILE: indexFile }, ...limits });
