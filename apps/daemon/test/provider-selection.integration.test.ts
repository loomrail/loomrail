import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  providerCapabilitiesResponseSchema,
  type ProviderCapabilitiesResponse,
  type ProviderId,
} from "@loomrail/contracts";
import { createCodexProvider } from "@loomrail/provider-codex";
import { createClaudeCodeProvider } from "@loomrail/provider-claude-code";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { createProviderRegistry, LOOMRAIL_PROVIDER_ENV_VAR } from "../src/provider-selection.js";
import { authenticate, bootstrapToken } from "./daemon-fixtures.js";

// Keep real environment parsing, registry selection and adapter capability declarations. Only
// machine observations are injected: installed/logged-in CLIs on a contributor's computer must
// not decide the expected result, and this suite must never start a provider session.
const registryFor = (readyProviders: readonly ProviderId[]) => {
  const neverStart = () => Promise.reject(new Error("Selection tests must not dispatch a provider"));
  return createProviderRegistry({
    adapters: {
      CODEX: { ...createCodexProvider({ command: process.execPath }), start: neverStart },
      CLAUDE_CODE: { ...createClaudeCodeProvider({ command: process.execPath }), start: neverStart },
    },
    probeRuntime: (provider) =>
      Promise.resolve(
        readyProviders.includes(provider)
          ? { installed: true, compatibility: "VERIFIED", version: "test-runtime" }
          : { installed: false, compatibility: "MISSING", version: null },
      ),
    probeAuthentication: () => Promise.resolve("AUTHENTICATED"),
  });
};
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
    readyProviders: readonly ProviderId[] = [],
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
      providerRegistry: registryFor(readyProviders),
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
  // silently on a value it could not read. A hidden fallback could otherwise let an owner watch a
  // whole delivery run believing the provider they requested did it.
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
      providerRegistry: registryFor([]),
      loggerStream: {
        write: (message: string) => {
          written += message;
        },
      },
    });
    return { daemon, log: () => written };
  };

  it("says at startup which local adapter it will dispatch to and whether it is ready", async () => {
    const { daemon, log } = await bootCapturingLog("CODEX");
    try {
      expect(log()).toContain("The provider adapter this daemon will dispatch to");
      expect(log()).toContain('"provider":"CODEX"');
      expect(log()).toContain('"providerReady"');
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
      expect(written).toContain("CODEX, CLAUDE_CODE");
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

  it("boots fail-closed when the variable is unset and neither CLI is ready", async () => {
    const { daemon, token } = await bootWithEnv(undefined);
    try {
      expect(await readCapabilities(daemon, token)).toMatchObject({ provider: "CODEX", start: false });
      expect(daemon.provider.providerReady).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it.each([
    { ready: ["CLAUDE_CODE"] as const, expected: "CLAUDE_CODE" },
    { ready: ["CODEX"] as const, expected: "CODEX" },
    { ready: ["CODEX", "CLAUDE_CODE"] as const, expected: "CODEX" },
  ])("AUTO selects $expected from the ready local runtimes $ready", async ({ ready, expected }) => {
    const { daemon, token } = await bootWithEnv(undefined, ready);
    try {
      expect(await readCapabilities(daemon, token)).toMatchObject({ provider: expected, start: true });
      expect(daemon.provider).toMatchObject({ provider: expected, providerReady: true });
    } finally {
      await daemon.close();
    }
  });

  it("does not replace an explicitly selected unavailable Codex with ready Claude", async () => {
    const { daemon, token } = await bootWithEnv("CODEX", ["CLAUDE_CODE"]);
    try {
      expect(await readCapabilities(daemon, token)).toMatchObject({ provider: "CODEX", start: false });
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
  // cannot see which stages the selected adapter serves, or that its local runtime is unavailable,
  // until a dispatch is refused mid-run.
  it("reports the stages the selected adapter serves, and whether it can start at all", async () => {
    const { daemon, token } = await bootWithEnv("CODEX");
    try {
      const capabilities = await readCapabilities(daemon, token);
      // Q20 gives the local CLI only the daemon-owned bounded executor, so IMPLEMENT and QA can
      // be declared without handing provider output arbitrary local authority.
      expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"]);
      expect(capabilities.start).toBe(false);
      // Codex does not expose a normalized monetary cost report to the cockpit.
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
  // `CLAUDE_CODE` selects a different local runtime than `CODEX`, so "the
  // daemon reads this spelling and hands the whole run to the Claude adapter" is not a claim to
  // leave to the unit test of the resolver -- which is injected everywhere else and so proves
  // nothing about what a real launch does.
  it("boots with the real Claude Code adapter when the environment variable names it", async () => {
    const { daemon, token } = await bootWithEnv("CLAUDE_CODE");
    try {
      const capabilities = await readCapabilities(daemon, token);
      expect(capabilities.provider).toBe("CLAUDE_CODE");
      // The Claude CLI receives the same bounded Loomrail tool connector;
      // this integration test asserts the public capability surface without making a paid call.
      expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"]);
      expect(capabilities.costReporting).toBe(true);
      expect(capabilities.start).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  // The property that matters most: a typo must not stop the daemon from starting at all. Booting
  // successfully and reporting the blocked OpenAI adapter, rather than throwing during
  // `startDaemon`, is the assertion.
  it.each([
    { ready: [] },
    { ready: ["CODEX"] },
    { ready: ["CLAUDE_CODE"] },
    { ready: ["CODEX", "CLAUDE_CODE"] },
  ] satisfies {
    ready: ProviderId[];
  }[])("blocks an invalid override even with ready runtimes $ready", async ({ ready }) => {
    const { daemon, token } = await bootWithEnv("codex-typo", ready);
    try {
      expect(await readCapabilities(daemon, token)).toMatchObject({ provider: "CODEX", start: false });
      expect(daemon.provider).toMatchObject({ providerReady: false, recognised: false });
    } finally {
      await daemon.close();
    }
  });
});
