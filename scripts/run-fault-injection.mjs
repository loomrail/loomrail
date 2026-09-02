import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

import { repositoryRoot, toolCommand, toolSpawnOptions } from "./release-manifest.mjs";

const runPnpm = (args) => {
  execFileSync(toolCommand("pnpm"), args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    ...toolSpawnOptions(),
  });
};

runPnpm(["build"]);
for (const workspace of [
  "@loomrail/persistence-sqlite",
  "@loomrail/provider-core",
  "@loomrail/provider-codex",
  "@loomrail/provider-claude-code",
  "@loomrail/mcp-gateway",
  "@loomrail/project-scaffolding",
  "@loomrail/browser-qa",
  "@loomrail/daemon",
]) {
  if (workspace === "@loomrail/daemon") {
    // Daemon files each own real SQLite/process/server lifecycles. Running those files concurrently
    // made the Windows release runner exhaust otherwise-valid per-test deadlines under contention,
    // which is the resource race this reliability gate is meant to avoid rather than measure.
    runPnpm(["--filter", workspace, "exec", "vitest", "run", "--maxWorkers=1"]);
  } else {
    runPnpm(["--filter", workspace, "test"]);
  }
}

execFileSync(process.execPath, [resolve(repositoryRoot, "scripts/verify-crash-recovery.mjs")], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
process.stdout.write("Fault-injection gate passed.\n");
