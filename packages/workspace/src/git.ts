import { spawn } from "node:child_process";

export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitOptions = {
  cwd: string;
  // Passed straight to `child_process.spawn` -- this REPLACES the child's environment rather than
  // merging with `process.env`. A caller that needs one extra variable (e.g. GIT_INDEX_FILE) and
  // passes only that loses PATH, and `spawn` resolves "git" through PATH, so git will not run at
  // all. Spread `process.env` yourself: `{ ...process.env, GIT_INDEX_FILE: path }`.
  env?: Readonly<Record<string, string>>;
};

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
// back as data. Only a failure to launch `git` at all (e.g. it is not on PATH) rejects, and only
// with GitMissingError.
export const runGit = (args: readonly string[], options: GitOptions): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error: unknown) => {
      reject(new GitMissingError(error));
    });

    child.on("close", (exitCode: number | null) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: exitCode ?? -1,
      });
    });
  });

// Runs a git plumbing command against a temporary index rather than the repository's real one, so
// the caller never touches the owner's actual index. `env` is spread over `process.env` rather
// than passed alone -- GitOptions.env replaces the child's environment, and passing only
// GIT_INDEX_FILE would drop PATH and leave `spawn` unable to find "git" at all.
export const runGitWithIndex = (
  args: readonly string[],
  cwd: string,
  indexFile: string,
): Promise<GitResult> => runGit(args, { cwd, env: { ...process.env, GIT_INDEX_FILE: indexFile } });
