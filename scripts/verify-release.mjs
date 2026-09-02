import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  releaseName,
  releaseVersion,
  repositoryRoot,
  toolCommand,
  toolSpawnOptions,
} from "./release-manifest.mjs";

/**
 * Installs the packed launcher into an empty directory and proves it runs there.
 *
 * This is the clean-machine gate: it uses only the tarball and the public registry, so a missing
 * asset, an unbundled workspace import or a forgotten runtime dependency fails here rather than in
 * a contributor's first `npx loomrail`.
 */
const readyTimeoutMs = 90_000;

const assertEntrypointRejectsInvalidInvocation = async (entrypoint, expectedError) =>
  new Promise((resolveWith, rejectWith) => {
    const child = spawn(process.execPath, [entrypoint], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectWith(new Error(`the packaged entrypoint did not exit: ${entrypoint}`));
    }, 10_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectWith(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 2 || !stderr.includes(expectedError)) {
        rejectWith(
          new Error(
            `the packaged entrypoint did not reject an invalid invocation as expected: ${entrypoint}\n${stderr}`,
          ),
        );
        return;
      }
      resolveWith();
    });
  });

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
  const version = releaseVersion();
  const tarball = resolve(repositoryRoot, "dist-release", `${releaseName}-${version}.tgz`);
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
    const installedRoot = join(installDirectory, "node_modules", releaseName);
    const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    if (installedManifest.name !== releaseName || installedManifest.version !== version) {
      throw new Error(
        `unexpected installed package: ${String(installedManifest.name)}@${String(installedManifest.version)}`,
      );
    }
    const binaryPath = join(installedRoot, installedManifest.bin.loomrail);
    if (installedManifest.dependencies?.["@upstash/context7-mcp"] !== "3.2.5") {
      throw new Error("the packaged launcher does not pin its bundled Context7 server");
    }
    const installedRequire = createRequire(binaryPath);
    if (typeof installedManifest.dependencies?.playwright !== "string") {
      throw new Error("the packaged launcher does not declare its Browser QA runtime");
    }
    const playwrightManifest = installedRequire.resolve("playwright/package.json");
    await readFile(playwrightManifest, "utf8");
    await access(
      join(
        installDirectory,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "playwright.cmd" : "playwright",
      ),
    );
    const context7Entrypoint = installedRequire.resolve("@upstash/context7-mcp/dist/index.js");
    await readFile(context7Entrypoint, "utf8");
    const consumerRequire = createRequire(join(installDirectory, "package.json"));
    const pluginSdkEntrypoint = consumerRequire.resolve(`${releaseName}/plugin-sdk`);
    const pluginSdk = await import(pathToFileURL(pluginSdkEntrypoint).href);
    const pluginManifest = pluginSdk.readonlyPluginManifestSchema.parse({
      schemaVersion: 1,
      protocol: "loomrail.readonly-tools.v1",
      id: "dev.loomrail.release-check",
      name: "Release check",
      version: "1.0.0",
      description: "Verifies the installed Plugin SDK subpath.",
      license: "Apache-2.0",
      entrypoint: "dist/plugin.mjs",
      permissions: { network: { mode: "NONE" } },
      tools: [{ name: "check", description: "Checks the installed SDK." }],
    });
    if (pluginManifest.id !== "dev.loomrail.release-check") {
      throw new Error("the packaged Plugin SDK did not validate its public manifest contract");
    }
    const mcpProxyPath = join(installedRoot, "apps", "cli", "dist", "proxy.js");
    const mcpSupervisorPath = join(installedRoot, "apps", "cli", "dist", "supervisor.js");
    await assertEntrypointRejectsInvalidInvocation(
      mcpProxyPath,
      "The Loomrail MCP proxy arguments are invalid.",
    );
    await assertEntrypointRejectsInvalidInvocation(
      mcpSupervisorPath,
      "Invalid Loomrail MCP supervisor invocation",
    );
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
