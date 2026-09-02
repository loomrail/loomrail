import { describe, expect, it } from "vitest";

import { parseCliCommand } from "../src/options.js";

describe("CLI options", () => {
  it("uses a dynamic port and opens the browser by default", () => {
    expect(parseCliCommand([])).toEqual({ command: "START", noOpen: false });
  });

  it("keeps legacy start flags and accepts the explicit start command", () => {
    const expected = { command: "START", noOpen: true, port: 3210 };
    expect(parseCliCommand(["--no-open", "--port", "3210"])).toEqual(expected);
    expect(parseCliCommand(["start", "--no-open", "--port", "3210"])).toEqual(expected);
  });

  it("rejects an invalid port", () => {
    expect(() => parseCliCommand(["--port", "70000"])).toThrow(/--port/);
  });

  it("parses read-only commands without accepting mixed flags or positionals", () => {
    expect(parseCliCommand(["doctor"])).toEqual({ command: "DOCTOR", format: "HUMAN" });
    expect(parseCliCommand(["doctor", "--json"])).toEqual({ command: "DOCTOR", format: "JSON" });
    expect(parseCliCommand(["logs", "export"])).toEqual({ command: "LOGS_EXPORT" });
    expect(parseCliCommand(["logs", "delete"])).toEqual({ command: "LOGS_DELETE" });
    expect(parseCliCommand(["data-path"])).toEqual({ command: "DATA_PATH" });
    expect(parseCliCommand(["help"])).toEqual({ command: "HELP" });
    expect(parseCliCommand(["--help"])).toEqual({ command: "HELP" });
    expect(parseCliCommand(["-h"])).toEqual({ command: "HELP" });

    expect(() => parseCliCommand(["doctor", "--no-open"])).toThrow();
    expect(() => parseCliCommand(["logs"])).toThrow(/export or delete/);
    expect(() => parseCliCommand(["logs", "export", "extra"])).toThrow();
    expect(() => parseCliCommand(["logs", "unknown"])).toThrow(/export or delete/);
    expect(() => parseCliCommand(["data-path", "extra"])).toThrow();
    expect(() => parseCliCommand(["unknown"])).toThrow(/Unknown Loomrail command/);
  });
});
