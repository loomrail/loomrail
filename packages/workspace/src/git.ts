import { spawn } from "node:child_process";

export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitOptions = {
  cwd: string;
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
