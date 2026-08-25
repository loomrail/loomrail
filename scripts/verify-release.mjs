import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { repositoryRoot } from "./release-manifest.mjs";

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
    execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
      cwd: installDirectory,
      stdio: "inherit",
    });

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    launcher = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["loomrail", "--no-open", "--port", String(port)],
      {
        cwd: installDirectory,
        env: { ...process.env, LOOMRAIL_DATA_DIR: dataDirectory },
        shell: process.platform === "win32",
      },
    );

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
    await rm(installDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

await run();
