import { describe, expect, it } from "vitest";

import {
  CONTEXT7_PRESET_TOOLS,
  Context7PresetError,
  resolveBundledContext7Candidate,
} from "../src/context7-preset.js";

describe("bundled Context7 preset", () => {
  it("builds one closed stdio recipe without a package launcher or PATH lookup", () => {
    const candidate = resolveBundledContext7Candidate({
      runtimeExecutable: "/Applications/Loomrail Runtime/node",
      resolveEntrypoint: () => "/Applications/Loomrail Runtime/context7/dist/index.js",
    });

    expect(candidate).toEqual({
      profileId: null,
      name: "Context7",
      executable: "/Applications/Loomrail Runtime/node",
      args: ["/Applications/Loomrail Runtime/context7/dist/index.js", "--transport", "stdio"],
      declaredTools: [...CONTEXT7_PRESET_TOOLS],
    });
    expect([candidate.executable, ...candidate.args]).not.toContain("npx");
  });

  it("fails closed when the bundled package cannot be resolved", () => {
    expect(() =>
      resolveBundledContext7Candidate({
        resolveEntrypoint: () => {
          throw new Error("missing package");
        },
      }),
    ).toThrow(Context7PresetError);
  });
});
