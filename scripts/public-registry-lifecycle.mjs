import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const betaVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commandOutputLimitBytes = 1024 * 1024;
const launcherOutputLimitBytes = 64 * 1024;
const commandDeadlineMs = 5 * 60_000;
const readyDeadlineMs = 90_000;
const shutdownDeadlineMs = 20_000;

const fail = (message) => {
  throw new Error(message);
};

export const parsePublicRegistryLifecycleArguments = (args) => {
  if (args.length !== 4 || args[0] !== "--beta" || args[2] !== "--stable") {
    fail("usage: public-registry-lifecycle --beta <exact-beta> --stable <exact-stable>");
  }
  const betaVersion = args[1];
  const stableVersion = args[3];
  if (!betaVersionPattern.test(betaVersion)) fail("the Beta version must be exact Beta semver");
  if (!stableVersionPattern.test(stableVersion)) fail("the Stable version must be exact stable semver");
  return { betaVersion, stableVersion };
};

export const assertContainedHarnessPath = async (root, target) => {
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  const fromRoot = relative(canonicalRoot, canonicalTarget);
  if (fromRoot.length === 0 || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail("lifecycle path is not a strict child of the harness root");
  }
  return canonicalTarget;
};

export const assertPublicLifecycleTarget = (platform, architecture) => {
  if (platform !== "darwin" || architecture !== "arm64") {
    fail("public registry lifecycle is live-gated only for darwin/arm64");
  }
};

export const assertSanitizedLifecycleEvidence = (text, { harnessRoot, canaries = [] }) => {
  const forbidden = [
    harnessRoot,
    "#bootstrap=",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    '"rawProviderPayload"',
    ...canaries,
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const value of forbidden) {
    if (text.includes(value)) fail("lifecycle evidence contains a forbidden value");
  }
};

const runCommand = async (command, args, { cwd, environment = process.env } = {}) => {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd,
    env: environment,
    detached,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let overflow = false;
  let timedOut = false;
  const terminate = () => {
    if (detached && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // The group may already have exited between observation and cancellation.
      }
    }
    child.kill("SIGKILL");
  };
  const collect = (channel) => (chunk) => {
    if (overflow) return;
    const next =
      channel === "stdout" ? stdout.byteLength + chunk.byteLength : stderr.byteLength + chunk.byteLength;
    if (next > commandOutputLimitBytes) {
      overflow = true;
      terminate();
      return;
    }
    if (channel === "stdout") stdout = Buffer.concat([stdout, chunk]);
    else stderr = Buffer.concat([stderr, chunk]);
  };
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));
  const deadline = setTimeout(() => {
    timedOut = true;
    terminate();
  }, commandDeadlineMs);
  const [code, signal] = await once(child, "close");
  clearTimeout(deadline);
  if (timedOut) fail("a lifecycle command exceeded its deadline");
  if (overflow) fail("a lifecycle command exceeded its output limit");
  if (code !== 0) fail(`a lifecycle command failed with code ${String(code)} and signal ${String(signal)}`);
  return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
};

const freePort = async () =>
  new Promise((resolveWith, rejectWith) => {
    const server = createServer();
    server.once("error", rejectWith);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectWith(new Error("could not reserve a loopback port"));
        return;
      }
      server.close(() => resolveWith(address.port));
    });
  });

const waitForLauncher = async (child, baseUrl, readOutput) => {
  const deadline = Date.now() + readyDeadlineMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      fail("the public launcher exited before readiness");
    const health = await fetch(`${baseUrl}/health/ready`).catch(() => null);
    const output = readOutput();
    const bootstrap = /#bootstrap=([A-Za-z0-9_-]{20,})/.exec(output)?.[1];
    if (health?.ok && bootstrap !== undefined) return bootstrap;
    await new Promise((resolveWith) => setTimeout(resolveWith, 250));
  }
  fail("the public launcher did not become ready before its deadline");
};

const stopLauncher = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  let deadline;
  try {
    await Promise.race([
      closed,
      new Promise((_, rejectWith) => {
        deadline = setTimeout(() => {
          child.kill("SIGKILL");
          rejectWith(new Error("the public launcher did not stop before its deadline"));
        }, shutdownDeadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
};

const startInstalled = async ({ binaryPath, cwd, dataDirectory, canary }) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    LOOMRAIL_DATA_DIR: dataDirectory,
    LOOMRAIL_PROVIDER: "",
    OPENAI_API_KEY: canary,
    ANTHROPIC_API_KEY: canary,
  };
  const child = spawn(process.execPath, [binaryPath, "start", "--no-open", "--port", String(port)], {
    cwd,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = Buffer.alloc(0);
  let overflow = false;
  const collect = (chunk) => {
    if (overflow) return;
    if (output.byteLength + chunk.byteLength > launcherOutputLimitBytes) {
      overflow = true;
      child.kill("SIGKILL");
      return;
    }
    output = Buffer.concat([output, chunk]);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const bootstrapToken = await waitForLauncher(child, baseUrl, () => output.toString("utf8"));
  if (overflow) fail("the public launcher exceeded its output limit");
  return { child, baseUrl, bootstrapToken, environment, readOutput: () => output.toString("utf8") };
};

const authenticate = async ({ baseUrl, bootstrapToken }) => {
  const response = await fetch(`${baseUrl}/api/session/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ bootstrapToken }),
  });
  if (!response.ok) fail("public launcher session exchange failed");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const payload = await response.json();
  if (cookie === undefined || typeof payload.csrfToken !== "string")
    fail("public launcher session is invalid");
  return { cookie, csrfToken: payload.csrfToken };
};

const authenticatedHeaders = (baseUrl, session, mutation = false) => ({
  cookie: session.cookie,
  ...(mutation
    ? {
        "content-type": "application/json",
        origin: baseUrl,
        "x-loomrail-csrf": session.csrfToken,
      }
    : {}),
});

const registerFixture = async (launcher, commandId) => {
  const session = await authenticate(launcher);
  const response = await fetch(`${launcher.baseUrl}/api/v1/projects/fixtures/register`, {
    method: "POST",
    headers: authenticatedHeaders(launcher.baseUrl, session, true),
    body: JSON.stringify({ schemaVersion: 1, commandId, fixtureId: "web-app-a" }),
  });
  if (!response.ok) fail("public lifecycle fixture registration failed");
};

const assertFixtureVisible = async (launcher) => {
  const session = await authenticate(launcher);
  const response = await fetch(`${launcher.baseUrl}/api/v1/projects`, {
    headers: authenticatedHeaders(launcher.baseUrl, session),
  });
  if (!response.ok) fail("public lifecycle project read failed");
  const payload = await response.json();
  if (
    !Array.isArray(payload.projects) ||
    !payload.projects.some((project) => project.id === "project-fixture-web-app-a")
  ) {
    fail("public lifecycle did not preserve its durable fixture project");
  }
};

const installPublicVersion = async ({ root, version, label }) => {
  const directory = join(root, `${label} install`);
  await mkdir(directory);
  await assertContainedHarnessPath(root, directory);
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: `loomrail-${label}-lifecycle`, private: true, version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );
  await runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `loomrail@${version}`], {
    cwd: directory,
  });
  const installedRoot = join(directory, "node_modules", "loomrail");
  const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  if (
    manifest.name !== "loomrail" ||
    manifest.version !== version ||
    typeof manifest.bin?.loomrail !== "string"
  ) {
    fail("registry installation did not produce the exact requested Loomrail package");
  }
  return { directory, installedRoot, binaryPath: join(installedRoot, manifest.bin.loomrail) };
};

const runJsonCli = async (installation, environment, args) => {
  const result = await runCommand(process.execPath, [installation.binaryPath, ...args], {
    cwd: installation.directory,
    environment,
  });
  try {
    return { raw: `${result.stdout}\n${result.stderr}`, value: JSON.parse(result.stdout) };
  } catch {
    fail("public lifecycle CLI did not return valid JSON");
  }
};

const proveInstallation = async ({ installation, dataDirectory, canary, root }) => {
  const environment = {
    ...process.env,
    LOOMRAIL_DATA_DIR: dataDirectory,
    LOOMRAIL_PROVIDER: "",
    OPENAI_API_KEY: canary,
    ANTHROPIC_API_KEY: canary,
  };
  const setup = await runJsonCli(installation, environment, ["setup", "--mode", "live", "--json"]);
  const doctor = await runJsonCli(installation, environment, ["doctor", "--json"]);
  assertSanitizedLifecycleEvidence(`${setup.raw}\n${doctor.raw}`, { harnessRoot: root, canaries: [canary] });
  if (setup.value.status !== "READY" || setup.value.checks?.route?.code !== "LIVE_ROUTE_READY") {
    fail("public lifecycle setup is not ready");
  }
  if (!Array.isArray(doctor.value.checks?.providers?.items)) fail("public lifecycle Doctor is invalid");
  return { environment, doctor: doctor.value };
};

export const runPublicRegistryLifecycle = async ({ betaVersion, stableVersion }) => {
  if (!betaVersionPattern.test(betaVersion) || !stableVersionPattern.test(stableVersion)) {
    fail("public lifecycle requires exact Beta and Stable versions");
  }
  assertPublicLifecycleTarget(process.platform, process.arch);

  const root = await mkdtemp(join(tmpdir(), "Loomrail public lifecycle space Юникод-"));
  const dataDirectory = join(root, "shared data Данные");
  const backupDirectory = join(root, "stopped backup Αντίγραφο");
  const restoredDirectory = join(root, "restored beta data 復元");
  const canary = "loomrail-public-lifecycle-secret-canary";
  let betaLauncher;
  let stableLauncher;
  let restoredLauncher;

  try {
    await mkdir(dataDirectory);
    await assertContainedHarnessPath(root, dataDirectory);
    const betaInstallation = await installPublicVersion({ root, version: betaVersion, label: "beta" });
    const stableInstallation = await installPublicVersion({
      root,
      version: stableVersion,
      label: "stable",
    });
    await runCommand("npm", ["audit", "signatures", "--json"], {
      cwd: stableInstallation.directory,
    });

    const betaProbe = await proveInstallation({
      installation: betaInstallation,
      dataDirectory,
      canary,
      root,
    });
    let running = await startInstalled({
      binaryPath: betaInstallation.binaryPath,
      cwd: betaInstallation.directory,
      dataDirectory,
      canary,
    });
    betaLauncher = running;
    await registerFixture(running, "public-lifecycle-register-fixture");
    await stopLauncher(running.child);
    betaLauncher = undefined;
    await access(join(dataDirectory, "state.sqlite"));

    await cp(dataDirectory, backupDirectory, { recursive: true, errorOnExist: true });
    await assertContainedHarnessPath(root, backupDirectory);

    const stableProbe = await proveInstallation({
      installation: stableInstallation,
      dataDirectory,
      canary,
      root,
    });
    if (stableProbe.doctor.checks?.stateDatabase?.code !== "STATE_READY") {
      fail("the exact Beta to Stable rehearsal was expected to be schema-neutral");
    }
    running = await startInstalled({
      binaryPath: stableInstallation.binaryPath,
      cwd: stableInstallation.directory,
      dataDirectory,
      canary,
    });
    stableLauncher = running;
    await assertFixtureVisible(running);
    await stopLauncher(running.child);
    stableLauncher = undefined;

    const logs = await runCommand(process.execPath, [stableInstallation.binaryPath, "logs", "export"], {
      cwd: stableInstallation.directory,
      environment: stableProbe.environment,
    });
    assertSanitizedLifecycleEvidence(`${logs.stdout}\n${logs.stderr}`, {
      harnessRoot: root,
      canaries: [canary],
    });

    await cp(backupDirectory, restoredDirectory, { recursive: true, errorOnExist: true });
    await assertContainedHarnessPath(root, restoredDirectory);
    const restoredProbe = await proveInstallation({
      installation: betaInstallation,
      dataDirectory: restoredDirectory,
      canary,
      root,
    });
    if (restoredProbe.doctor.checks?.stateDatabase?.code !== "STATE_READY") {
      fail("the restored pre-upgrade backup is not current for its matching Beta binary");
    }
    running = await startInstalled({
      binaryPath: betaInstallation.binaryPath,
      cwd: betaInstallation.directory,
      dataDirectory: restoredDirectory,
      canary,
    });
    restoredLauncher = running;
    await assertFixtureVisible(running);
    await stopLauncher(running.child);
    restoredLauncher = undefined;

    await runCommand("npm", ["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "loomrail"], {
      cwd: stableInstallation.directory,
    });
    await access(stableInstallation.installedRoot)
      .then(() => fail("package uninstall left the Stable package installed"))
      .catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    const dataMetadata = await lstat(join(dataDirectory, "state.sqlite"));
    if (!dataMetadata.isFile()) fail("package uninstall removed or changed owner state");

    const evidence = {
      schemaVersion: 1,
      result: "PASSED",
      target: "MACOS_ARM64",
      betaVersion,
      stableVersion,
      betaInitialState: betaProbe.doctor.checks?.stateDatabase?.code,
      stablePreStartState: stableProbe.doctor.checks?.stateDatabase?.code,
      restoredBetaState: restoredProbe.doctor.checks?.stateDatabase?.code,
      durableProjectPreserved: true,
      restoreOpenedOnlyByMatchingVersion: true,
      stablePackageRemoved: true,
      ownerDataPreserved: true,
    };
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    assertSanitizedLifecycleEvidence(serialized, { harnessRoot: root, canaries: [canary] });
    return serialized;
  } finally {
    await Promise.allSettled(
      [betaLauncher, stableLauncher, restoredLauncher]
        .map((launcher) => launcher?.child)
        .filter((child) => child !== undefined)
        .map((child) => stopLauncher(child)),
    );
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parsePublicRegistryLifecycleArguments(process.argv.slice(2));
  const evidence = await runPublicRegistryLifecycle(options);
  process.stdout.write(evidence);
}
