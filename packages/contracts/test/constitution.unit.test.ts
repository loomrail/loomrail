import { describe, expect, it } from "vitest";

import {
  constitutionPublicationErrorCodeSchema,
  scannedConstitutionTargetSchema,
  scanProjectConstitutionRequestSchema,
} from "../src/index.js";

describe("Project Constitution contracts", () => {
  it("keeps target presence and digest states internally consistent", () => {
    expect(scannedConstitutionTargetSchema.safeParse({ state: "ABSENT", digest: null }).success).toBe(true);
    expect(scannedConstitutionTargetSchema.safeParse({ state: "PRESENT", digest: null }).success).toBe(false);
    expect(
      scannedConstitutionTargetSchema.safeParse({
        state: "BLOCKED",
        digest: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("rejects fields outside the bounded scan request", () => {
    expect(
      scanProjectConstitutionRequestSchema.safeParse({
        schemaVersion: 1,
        commandId: "scan-1",
        expectedProjectVersion: 1,
        includeSourceTree: true,
      }).success,
    ).toBe(false);
  });

  it("allows only publication failures the UI can recover from safely", () => {
    expect(constitutionPublicationErrorCodeSchema.safeParse("CONSTITUTION_TARGET_CHANGED").success).toBe(
      true,
    );
    expect(constitutionPublicationErrorCodeSchema.safeParse("EXECUTE_REPOSITORY_SCRIPT").success).toBe(false);
  });
});
