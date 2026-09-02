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
  runPnpm(["--filter", workspace, "test"]);
}

execFileSync(process.execPath, [resolve(repositoryRoot, "scripts/verify-crash-recovery.mjs")], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
process.stdout.write("Fault-injection gate passed.\n");
