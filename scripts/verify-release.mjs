import { spawn, spawnSync } from "node:child_process";
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
import { verifyInstalledReleaseFiles, verifyReleaseReceipt } from "./release-integrity.mjs";

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

const stopLauncher = async (launcher) => {
  if (launcher.exitCode !== null || launcher.signalCode !== null) return;
  await new Promise((resolveWith, rejectWith) => {
    const timeout = setTimeout(() => {
      launcher.kill("SIGKILL");
      rejectWith(new Error("the packaged launcher did not stop within 20 seconds"));
    }, 20_000);
    launcher.once("close", () => {
      clearTimeout(timeout);
      resolveWith();
    });
    launcher.kill("SIGTERM");
  });
};

const run = async () => {
  const version = releaseVersion();
  const tarball = resolve(repositoryRoot, "dist-release", `${releaseName}-${version}.tgz`);
  const receiptPath = resolve(repositoryRoot, "dist-release", `${releaseName}-${version}.receipt.json`);
  const installDirectory = await mkdtemp(join(tmpdir(), "loomrail-release-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "loomrail-state-"));
  let launcher;

  try {
    const receipt = await verifyReleaseReceipt({
      receiptPath,
      tarballPath: tarball,
      name: releaseName,
      version,
      requireCleanSource: process.env.CI === "true",
    });
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
    execFileSync(
      toolCommand("npm"),
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", localTarball],
      {
        cwd: installDirectory,
        stdio: "inherit",
        ...toolSpawnOptions(),
      },
    );

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
    await verifyInstalledReleaseFiles({ installedRoot, receipt });
    execFileSync(toolCommand("npm"), ["audit", "--omit=dev", "--audit-level=high"], {
      cwd: installDirectory,
      stdio: "inherit",
      ...toolSpawnOptions(),
    });
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
    const diagnosticEnvironment = { ...process.env, LOOMRAIL_DATA_DIR: dataDirectory };
    const diagnosticOutput = execFileSync(process.execPath, [binaryPath, "doctor", "--json"], {
      cwd: installDirectory,
      env: diagnosticEnvironment,
      encoding: "utf8",
    });
    const diagnostic = JSON.parse(diagnosticOutput);
    if (
      diagnostic.schemaVersion !== 1 ||
      !["PASS", "WARN"].includes(diagnostic.status) ||
      diagnosticOutput.includes(dataDirectory)
    ) {
      throw new Error("the packaged read-only diagnostic report is invalid or leaks its data path");
    }
    const reportedDataPath = execFileSync(process.execPath, [binaryPath, "data-path"], {
      cwd: installDirectory,
      env: diagnosticEnvironment,
      encoding: "utf8",
    }).trim();
    if (reportedDataPath !== dataDirectory) {
      throw new Error("the packaged launcher did not resolve its explicit data path");
    }
    await access(join(dataDirectory, "state.sqlite"))
      .then(() => {
        throw new Error("doctor created state instead of inspecting it read-only");
      })
      .catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    const unusableDataPath = join(installDirectory, "not-a-data-directory");
    await writeFile(unusableDataPath, "diagnostic refusal fixture", "utf8");
    const failedDiagnostic = spawnSync(process.execPath, [binaryPath, "doctor", "--json"], {
      cwd: installDirectory,
      env: { ...process.env, LOOMRAIL_DATA_DIR: unusableDataPath },
      encoding: "utf8",
    });
    const failedDiagnosticReport = JSON.parse(failedDiagnostic.stdout);
    if (
      failedDiagnostic.status !== 1 ||
      failedDiagnosticReport.status !== "FAIL" ||
      failedDiagnostic.stdout.includes(unusableDataPath)
    ) {
      throw new Error("the packaged diagnostic did not fail closed for an unusable data path");
    }
    launcher = spawn(process.execPath, [binaryPath, "--no-open", "--port", String(port)], {
      cwd: installDirectory,
      env: diagnosticEnvironment,
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

    const activeExport = spawnSync(process.execPath, [binaryPath, "logs", "export"], {
      cwd: installDirectory,
      env: diagnosticEnvironment,
      encoding: "utf8",
    });
    if (
      activeExport.status !== 1 ||
      activeExport.stdout.length !== 0 ||
      !activeExport.stderr.includes("Stop the running Loomrail daemon") ||
      activeExport.stderr.includes(dataDirectory)
    ) {
      throw new Error("the packaged log export did not fail closed while the daemon was active");
    }

    await stopLauncher(launcher);
    const logExport = execFileSync(process.execPath, [binaryPath, "logs", "export"], {
      cwd: installDirectory,
      env: diagnosticEnvironment,
      encoding: "utf8",
    });
    const logEntries = logExport
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    if (
      logEntries.length === 0 ||
      logEntries.some((entry) => entry.schemaVersion !== 1 || entry.component !== "daemon") ||
      logExport.includes(dataDirectory) ||
      logExport.includes("#bootstrap=")
    ) {
      throw new Error("the packaged launcher did not produce a bounded redacted operational log export");
    }
    const deletionOutput = execFileSync(process.execPath, [binaryPath, "logs", "delete"], {
      cwd: installDirectory,
      env: diagnosticEnvironment,
      encoding: "utf8",
    });
    const emptyLogExport = execFileSync(process.execPath, [binaryPath, "logs", "export"], {
      cwd: installDirectory,
      env: diagnosticEnvironment,
      encoding: "utf8",
    });
    if (!deletionOutput.startsWith("Deleted ") || emptyLogExport.length !== 0) {
      throw new Error("the packaged log deletion command did not remove the retained operational segments");
    }

    process.stdout.write(
      `Release check passed: receipt, installed files and log lifecycle match; ${tarball} runs from a clean install.\n`,
    );
  } finally {
    launcher?.kill("SIGTERM");
    launcher?.stdout?.destroy();
    launcher?.stderr?.destroy();
    await rm(installDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

await run();
