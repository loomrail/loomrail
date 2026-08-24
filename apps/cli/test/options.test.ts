import { describe, expect, it } from "vitest";

import { parseCliOptions } from "../src/options.js";

describe("CLI options", () => {
  it("uses a dynamic port and opens the browser by default", () => {
    expect(parseCliOptions([])).toEqual({ noOpen: false });
  });

  it("accepts a fixed test port", () => {
    expect(parseCliOptions(["--no-open", "--port", "3210"])).toEqual({ noOpen: true, port: 3210 });
  });

  it("rejects an invalid port", () => {
    expect(() => parseCliOptions(["--port", "70000"])).toThrow(/--port/);
  });
});
