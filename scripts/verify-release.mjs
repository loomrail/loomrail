import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { repositoryRoot, toolCommand, toolSpawnOptions } from "./release-manifest.mjs";

/**
 * Installs the packed launcher into an empty directory and proves it runs there.
 *
 * This is the clean-machine gate: it uses only the tarball and the public registry, so a missing
 * asset, an unbundled workspace import or a forgotten runtime dependency fails here rather than in
 * a contributor's first `npx loomrail`.
 */
const readyTimeoutMs = 90_000;

const freePort = async () =>
  new Promise((resolveWith, rejectWith) => {
    const probe = createServer();
    probe.once("error", rejectWith);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => {
        resolveWith(port);
      });
    });
  });

const waitForReady = async (baseUrl, launcher, readOutput) => {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (launcher.exitCode !== null) {
      throw new Error(`the launcher exited with ${launcher.exitCode}:\n${readOutput()}`);
    }
    const response = await fetch(`${baseUrl}/health/ready`).catch(() => null);
    if (response?.ok) return response.json();
    await new Promise((resolveWith) => setTimeout(resolveWith, 250));
  }
  throw new Error(`the launcher was not ready within ${readyTimeoutMs}ms:\n${readOutput()}`);
};

const run = async () => {
  const tarball = resolve(repositoryRoot, "dist-release", "loomrail-0.0.0.tgz");
  const installDirectory = await mkdtemp(join(tmpdir(), "loomrail-release-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "loomrail-state-"));
  let launcher;

  try {
    // An empty project, so nothing from the workspace can satisfy an import by accident.
    await writeFile(
      join(installDirectory, "package.json"),
      `${JSON.stringify({ name: "loomrail-release-check", private: true, version: "0.0.0" }, null, 2)}\n`,
      "utf8",
    );
    // Install by bare filename from inside the directory: on Windows the arguments go through a
    // shell, and a temporary path containing a space would break the command.
    const localTarball = "loomrail.tgz";
    await copyFile(tarball, join(installDirectory, localTarball));
    execFileSync(toolCommand("npm"), ["install", "--no-audit", "--no-fund", localTarball], {
      cwd: installDirectory,
      stdio: "inherit",
      ...toolSpawnOptions(),
    });

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    // Launch the installed binary through Node directly rather than the `npx` shim. On Windows the
    // shim needs a shell, and killing that shell leaves the real process running with its pipes
    // open, which hangs this script long after the check has passed. Reading `bin` from the
    // installed manifest also asserts that the published entry point is where it claims to be.
    const installedRoot = join(installDirectory, "node_modules", "loomrail");
    const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    const binaryPath = join(installedRoot, installedManifest.bin.loomrail);
    launcher = spawn(process.execPath, [binaryPath, "--no-open", "--port", String(port)], {
      cwd: installDirectory,
      env: { ...process.env, LOOMRAIL_DATA_DIR: dataDirectory },
    });

    let output = "";
    launcher.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));
    launcher.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));

    const health = await waitForReady(baseUrl, launcher, () => output);
    if (health.status !== "ready") throw new Error(`unexpected health payload: ${JSON.stringify(health)}`);

    // The installed launcher must serve the built Workbench, not just answer health checks.
    const page = await fetch(baseUrl);
    const html = await page.text();
    if (!page.ok || !html.includes("<title>Loomrail</title>")) {
      throw new Error("the installed launcher did not serve the Workbench shell");
    }

    // Headless installs authenticate through the printed one-time URL.
    if (!output.includes("#bootstrap=")) {
      throw new Error(`the launcher did not print a sign-in URL:\n${output}`);
    }

    process.stdout.write(`Release check passed: ${tarball} runs from a clean install.\n`);
  } finally {
    launcher?.kill("SIGTERM");
    launcher?.stdout?.destroy();
    launcher?.stderr?.destroy();
    await rm(installDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

await run();
