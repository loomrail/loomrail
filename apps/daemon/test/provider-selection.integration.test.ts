import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerCapabilitiesResponseSchema, type ProviderCapabilitiesResponse } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { LOOMRAIL_PROVIDER_ENV_VAR } from "../src/provider-selection.js";
import { authenticate, bootstrapToken } from "./daemon-fixtures.js";

// The unit tests for `resolveDefaultProviderAdapter` (provider-selection.unit.test.ts) prove the
// selection function itself is correct in isolation. They do not prove `startDaemon` actually
// reads the real process environment when nothing overrides its default -- every other daemon test
// injects `providerAdapter` directly, which bypasses `resolveDefaultProviderAdapter` entirely. This
// file is the other half: no `providerAdapter` override anywhere below, so whatever
// `/api/v1/provider/capabilities` reports came from `process.env[LOOMRAIL_PROVIDER_ENV_VAR]` through
// the same default-resolution branch a real `loomrail` launch takes.
describe("provider selection at daemon startup", () => {
  const temporaryDirectories: string[] = [];
  const originalValue = process.env[LOOMRAIL_PROVIDER_ENV_VAR];

  afterEach(async () => {
    if (originalValue === undefined) Reflect.deleteProperty(process.env, LOOMRAIL_PROVIDER_ENV_VAR);
    else process.env[LOOMRAIL_PROVIDER_ENV_VAR] = originalValue;
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  const bootWithEnv = async (
    value: string | undefined,
  ): Promise<{ daemon: RunningDaemon; token: string }> => {
    if (value === undefined) Reflect.deleteProperty(process.env, LOOMRAIL_PROVIDER_ENV_VAR);
    else process.env[LOOMRAIL_PROVIDER_ENV_VAR] = value;
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail provider selection "));
    temporaryDirectories.push(temporaryDirectory);
    const token = bootstrapToken();
    const daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: join(temporaryDirectory, "state.sqlite"),
      logger: false,
    });
    return { daemon, token };
  };

  const readCapabilities = async (
    daemon: RunningDaemon,
    token: string,
  ): Promise<ProviderCapabilitiesResponse> => {
    const { cookie } = await authenticate(daemon, token);
    const response = await fetch(`${daemon.baseUrl}/api/v1/provider/capabilities`, {
      headers: { cookie },
    });
    return providerCapabilitiesResponseSchema.parse(await response.json());
  };

  const readReportedProvider = async (daemon: RunningDaemon, token: string): Promise<string> =>
    (await readCapabilities(daemon, token)).provider;

  // The other half of R28: the daemon must SAY which adapter it resolved, and must not fall back
  // silently on a value it could not read. The mock completes stages successfully, so an owner who
  // mistyped the variable can otherwise watch a whole delivery run believing a live agent did it.
  // Driven through the daemon's real logger stream rather than a spy on the resolver, because the
  // defect is the absence of the log line, not the resolver's return value.
  const bootCapturingLog = async (
    value: string | undefined,
  ): Promise<{ daemon: RunningDaemon; log: () => string }> => {
    if (value === undefined) Reflect.deleteProperty(process.env, LOOMRAIL_PROVIDER_ENV_VAR);
    else process.env[LOOMRAIL_PROVIDER_ENV_VAR] = value;
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail provider log "));
    temporaryDirectories.push(temporaryDirectory);
    let written = "";
    const daemon = await startDaemon({
      bootstrapToken: bootstrapToken(),
      stateDatabasePath: join(temporaryDirectory, "state.sqlite"),
      loggerStream: {
        write: (message: string) => {
          written += message;
        },
      },
    });
    return { daemon, log: () => written };
  };

  it("says at startup which adapter it will dispatch to, and whether its CLI is here", async () => {
    const { daemon, log } = await bootCapturingLog("CODEX");
    try {
      expect(log()).toContain("The provider adapter this daemon will dispatch to");
      expect(log()).toContain('"provider":"CODEX"');
      expect(log()).toContain('"cliAvailable"');
    } finally {
      await daemon.close();
    }
  });

  it("warns, naming the value and the accepted spellings, when the variable is not readable", async () => {
    const { daemon, log } = await bootCapturingLog("codex");
    try {
      const written = log();
      expect(written).toContain("does not know");
      expect(written).toContain('"codex"');
      expect(written).toContain("MOCK, CODEX, CLAUDE_CODE");
    } finally {
      await daemon.close();
    }
  });

  it("does not warn about a provider the owner never asked for", async () => {
    const { daemon, log } = await bootCapturingLog(undefined);
    try {
      expect(log()).not.toContain("does not know");
    } finally {
      await daemon.close();
    }
  });

  it("boots with the mock provider when the environment variable is not set", async () => {
    const { daemon, token } = await bootWithEnv(undefined);
    try {
      expect(await readReportedProvider(daemon, token)).toBe("MOCK");
    } finally {
      await daemon.close();
    }
  });

  it("boots with the real Codex adapter when the environment variable names it", async () => {
    const { daemon, token } = await bootWithEnv("CODEX");
    try {
      expect(await readReportedProvider(daemon, token)).toBe("CODEX");
    } finally {
      await daemon.close();
    }
  });

  // Milestone A2 added `start`, `stages` and `costReporting` to `ProviderCapabilities` and nothing
  // propagated them to this endpoint -- the one thing the cockpit reads. Without them the owner
  // cannot see which stages the selected adapter serves, or that its CLI is missing from this
  // machine, until a dispatch is refused mid-run.
  it("reports the stages the selected adapter serves, and whether it can start at all", async () => {
    const { daemon, token } = await bootWithEnv("CODEX");
    try {
      const capabilities = await readCapabilities(daemon, token);
      // As of E1 the Codex adapter runs its CLI in the work item's own worktree, so it serves every
      // stage -- IMPLEMENT included, which is the one the cockpit could never dispatch before.
      expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"]);
      // Whether `codex` happens to be installed on the machine running this test is not the point;
      // that the endpoint carries the claim at all is.
      expect(typeof capabilities.start).toBe("boolean");
      // Codex reports no cost figure anywhere in its stream; Claude Code does. The cockpit cannot
      // explain a missing spend figure without being told which it is talking to.
      expect(capabilities.costReporting).toBe(false);
      // The same stage list the launcher prints. `formatStartupReport` is tested on hand-built
      // input, so this is the half that proves what a real boot actually hands it: the adapter's
      // own declaration, not an empty list that would print "It serves ." at startup.
      expect(daemon.provider.stages).toEqual(capabilities.stages);
    } finally {
      await daemon.close();
    }
  });

  // The third accepted value, and the one this file used to leave entirely unpinned: booting
  // `CLAUDE_CODE` spends the owner's money through a different CLI than `CODEX` does, so "the
  // daemon reads this spelling and hands the whole run to the Claude adapter" is not a claim to
  // leave to the unit test of the resolver -- which is injected everywhere else and so proves
  // nothing about what a real launch does.
  it("boots with the real Claude Code adapter when the environment variable names it", async () => {
    const { daemon, token } = await bootWithEnv("CLAUDE_CODE");
    try {
      const capabilities = await readCapabilities(daemon, token);
      expect(capabilities.provider).toBe("CLAUDE_CODE");
      // Unchanged by E1, and deliberately not made symmetric with Codex above: this adapter still
      // runs in an empty temporary directory, because its write path has never been run against the
      // real CLI here (that CLI is unauthenticated on this machine). Asserting symmetry between two
      // adapters on evidence gathered from only one of them is what produced two Criticals in the
      // previous milestone.
      expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "REVIEW"]);
      expect(capabilities.stages).not.toContain("IMPLEMENT");
      // The one capability that genuinely differs between the two live adapters, and the reason
      // the cockpit can explain a missing spend figure for one and not the other: Claude Code
      // reports cost in its own result event; Codex reports none anywhere.
      expect(capabilities.costReporting).toBe(true);
      expect(typeof capabilities.start).toBe("boolean");
    } finally {
      await daemon.close();
    }
  });

  // The property that matters most: a typo must not stop the daemon from starting at all. Booting
  // successfully and reporting mock, rather than throwing during `startDaemon`, is the assertion.
  it("boots with the mock provider, not a startup failure, on an unrecognised value", async () => {
    const { daemon, token } = await bootWithEnv("codex-typo");
    try {
      expect(await readReportedProvider(daemon, token)).toBe("MOCK");
    } finally {
      await daemon.close();
    }
  });
});
