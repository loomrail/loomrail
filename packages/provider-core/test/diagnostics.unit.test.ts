import { describe, expect, it } from "vitest";

import { createCliProviderDiagnostics, type ProviderRuntimeTarget } from "../src/index.js";

const darwinArm64 = {
  platform: "darwin",
  architecture: "arm64",
} as const satisfies ProviderRuntimeTarget;

const diagnosticsFor = (runtimeTarget: ProviderRuntimeTarget) =>
  createCliProviderDiagnostics(
    {
      command: "provider",
      versionArguments: ["--version"],
      authenticationArguments: ["auth", "status"],
      versionFromOutput: (output) => /^provider ([^\s]+)$/.exec(output.trim())?.[1] ?? null,
      verifiedTargets: [{ version: "1.2.3", ...darwinArm64 }],
    },
    runtimeTarget,
  );

describe("CLI provider compatibility targets", () => {
  it("verifies only an exact version, platform and architecture match", () => {
    expect(diagnosticsFor(darwinArm64).classifyVersion("provider 1.2.3\n")).toEqual({
      compatibility: "VERIFIED",
      version: "1.2.3",
    });
  });

  it.each([
    ["version", darwinArm64, "provider 1.2.4\n"],
    ["platform", { platform: "win32", architecture: "arm64" } as const, "provider 1.2.3\n"],
    ["architecture", { platform: "darwin", architecture: "x64" } as const, "provider 1.2.3\n"],
  ])("keeps a mismatched %s unverified", (_dimension, runtimeTarget, output) => {
    expect(diagnosticsFor(runtimeTarget).classifyVersion(output)).toEqual({
      compatibility: "UNVERIFIED",
      version: output.includes("1.2.4") ? "1.2.4" : "1.2.3",
    });
  });

  it("rejects malformed exact rows at construction", () => {
    expect(() =>
      createCliProviderDiagnostics(
        {
          command: "provider",
          versionArguments: ["--version"],
          authenticationArguments: ["auth", "status"],
          versionFromOutput: () => null,
          verifiedTargets: [{ version: "01.2.3", ...darwinArm64 }],
        },
        darwinArm64,
      ),
    ).toThrow("A verified provider version is not valid SemVer");
  });

  it("keeps the OS user identity needed by provider-owned auth while dropping unrelated values", async () => {
    await expect(
      diagnosticsFor(darwinArm64).probeAuthentication({
        command: process.execPath,
        commandArgsPrefix: [
          "-e",
          'process.exit(process.env.USER === "loomrail-owner" && process.env.SECRET_CANARY === undefined ? 0 : 1)',
          "--",
        ],
        environment: {
          PATH: process.env["PATH"],
          USER: "loomrail-owner",
          SECRET_CANARY: "must-not-cross",
        },
      }),
    ).resolves.toBe("AUTHENTICATED");
  });
});
