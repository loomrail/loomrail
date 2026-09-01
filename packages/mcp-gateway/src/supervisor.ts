import { spawn } from "node:child_process";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import { createProcessTreeOperations } from "./process-tree.js";

const GRACE_MS = 1_000;
const FORCE_WAIT_MS = 2_000;
const PARENT_CHECK_MS = 250;
const STDOUT_MESSAGE_LIMIT_BYTES = 1_048_576;
const processTree = createProcessTreeOperations();

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const parseInvocation = (): {
  parentPid: number;
  controlToken: string;
  registryFile: string | null;
  command: string;
  args: string[];
} | null => {
  const separator = process.argv.indexOf("--");
  if (process.argv[2] !== "--parent-pid" || process.argv[4] !== "--control-token") {
    return null;
  }
  const parentPid = Number(process.argv[3]);
  const controlToken = process.argv[5];
  const registryFile =
    process.argv[6] === "--registry-file" && separator === 8 ? (process.argv[7] ?? null) : null;
  const command = process.argv[separator + 1];
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    controlToken === undefined ||
    !/^[A-Za-z0-9_-]{43}$/u.test(controlToken) ||
    (separator !== 6 && registryFile === null) ||
    command === undefined ||
    command === ""
  ) {
    return null;
  }
  return { parentPid, controlToken, registryFile, command, args: process.argv.slice(separator + 2) };
};

const invocation = parseInvocation();
if (invocation === null) {
  process.stderr.write("Invalid Loomrail MCP supervisor invocation\n");
  process.exitCode = 2;
} else {
  const child = spawn(invocation.command, invocation.args, {
    detached: processTree.detachChild,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stopping = false;
  let stdoutBuffer = Buffer.alloc(0);
  let registryWritten = false;
  let registryTemporaryFile: string | null = null;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
      resolve();
    });
  });

  const waitFor = async (predicate: () => boolean, milliseconds: number): Promise<boolean> => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(25);
    }
    return predicate();
  };

  const terminateTree = async (): Promise<void> => {
    child.stdin.end();
    const pid = child.pid;
    if (pid === undefined || !processTree.treeExists(pid)) return;
    await processTree.gracefulStop(pid).catch(() => undefined);
    if (await waitFor(() => !processTree.treeExists(pid), GRACE_MS)) return;
    await processTree.forceStop(pid).catch(() => undefined);
    await waitFor(() => !processTree.treeExists(pid), FORCE_WAIT_MS);
  };

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void terminateTree().finally(() => {
      if (registryWritten && invocation.registryFile !== null) {
        try {
          unlinkSync(invocation.registryFile);
        } catch {
          // Startup reconciliation handles a record that could not be removed here.
        }
      }
      if (registryTemporaryFile !== null) {
        try {
          unlinkSync(registryTemporaryFile);
        } catch {
          // Startup reconciliation also recognises an atomic-write temporary record.
        }
      }
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
      const pid = child.pid;
      // A tree that outlived both stop attempts is the supervisor's own failure and overrides
      // everything. Otherwise the code the server chose is the more informative answer -- flattening
      // a server that rejected its configuration with 3 into a 0 loses the only signal a reader has.
      if (pid !== undefined && processTree.treeExists(pid)) process.exitCode = 1;
      else process.exitCode ??= 0;
    });
  };

  const rejectOutput = (state: "INVALID_RESPONSE" | "OUTPUT_LIMIT_REACHED"): void => {
    process.stderr.write(`LOOMRAIL_MCP_SUPERVISOR:${invocation.controlToken}:${state}\n`);
    child.stdout.destroy();
    stop();
  };

  if (invocation.registryFile !== null && child.pid !== undefined) {
    try {
      mkdirSync(dirname(invocation.registryFile), { recursive: true, mode: 0o700 });
      const temporaryFile = `${invocation.registryFile}.tmp-${process.pid.toString()}`;
      registryTemporaryFile = temporaryFile;
      writeFileSync(
        temporaryFile,
        JSON.stringify({
          schemaVersion: 1,
          supervisorPid: process.pid,
          serverPid: child.pid,
          startedAt: new Date().toISOString(),
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      renameSync(temporaryFile, invocation.registryFile);
      registryTemporaryFile = null;
      registryWritten = true;
    } catch {
      rejectOutput("INVALID_RESPONSE");
    }
  }

  child.once("error", () => {
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  child.stderr.on("error", () => undefined);
  process.stdin.on("error", () => {
    stop();
  });
  process.stdout.on("error", () => {
    stop();
  });
  process.stderr.on("error", () => {
    stop();
  });
  process.stdin.pipe(child.stdin);
  child.stdout.on("data", (chunk: Buffer) => {
    if (stopping) return;
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    let newline = stdoutBuffer.indexOf(0x0a);
    while (newline !== -1) {
      if (newline > STDOUT_MESSAGE_LIMIT_BYTES) {
        rejectOutput("OUTPUT_LIMIT_REACHED");
        return;
      }
      const message = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      try {
        JSON.parse(message.toString("utf8"));
      } catch {
        rejectOutput("INVALID_RESPONSE");
        return;
      }
      if (!process.stdout.write(Buffer.concat([message, Buffer.from("\n")]))) {
        child.stdout.pause();
        process.stdout.once("drain", () => {
          child.stdout.resume();
        });
      }
      newline = stdoutBuffer.indexOf(0x0a);
    }
    if (stdoutBuffer.length > STDOUT_MESSAGE_LIMIT_BYTES) rejectOutput("OUTPUT_LIMIT_REACHED");
  });
  child.stderr.pipe(process.stderr);

  process.stdin.once("end", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);

  const parentCheck = setInterval(() => {
    if (!processTree.pidExists(invocation.parentPid)) stop();
  }, PARENT_CHECK_MS);
  parentCheck.unref();
  void exited.finally(() => {
    clearInterval(parentCheck);
  });
}
