import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerCapabilitiesResponseSchema, sessionExchangeResponseSchema } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { LOOMRAIL_PROVIDER_ENV_VAR } from "../src/provider-selection.js";

// Deliberately not imported from `server.integration.test.ts`, even though it exports equivalents:
// that file is itself matched by the `integration` project's test glob, and importing it re-runs
// its own top-level `describe` blocks a second time in this file's module instance (already true,
// pre-existing, of `event-stream.integration.test.ts`'s import of it -- see that file's own note).
// Adding a third import site would triple-register the "stage capability gate" suite for no reason
// this file needs. These two are short enough to duplicate instead.
const bootstrapToken = (): string => randomBytes(32).toString("base64url");

const sessionCookie = async (daemon: RunningDaemon, token: string): Promise<string> => {
  const exchange = await fetch(`${daemon.baseUrl}/api/session/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: daemon.baseUrl },
    body: JSON.stringify({ bootstrapToken: token }),
  });
  sessionExchangeResponseSchema.parse(await exchange.json());
  const setCookie = exchange.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie) throw new Error("Session exchange did not return a cookie");
  return cookie;
};

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

  const readReportedProvider = async (daemon: RunningDaemon, token: string): Promise<string> => {
    const cookie = await sessionCookie(daemon, token);
    const response = await fetch(`${daemon.baseUrl}/api/v1/provider/capabilities`, {
      headers: { cookie },
    });
    return providerCapabilitiesResponseSchema.parse(await response.json()).provider;
  };

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
