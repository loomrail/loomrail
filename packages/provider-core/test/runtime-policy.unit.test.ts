import { MAX_VERIFICATION_RECIPE_TIMEOUT_SECONDS } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  LOCAL_PROVIDER_SESSION_CONTROL_PLANE_RESERVE_MS,
  LOCAL_PROVIDER_SESSION_DEADLINE_MS,
} from "../src/index.js";

describe("local provider runtime policy", () => {
  it("keeps one maximum verification call inside the session plus a fixed reserve", () => {
    expect(LOCAL_PROVIDER_SESSION_CONTROL_PLANE_RESERVE_MS).toBe(300_000);
    expect(LOCAL_PROVIDER_SESSION_DEADLINE_MS).toBe(
      MAX_VERIFICATION_RECIPE_TIMEOUT_SECONDS * 1_000 + LOCAL_PROVIDER_SESSION_CONTROL_PLANE_RESERVE_MS,
    );
  });
});
