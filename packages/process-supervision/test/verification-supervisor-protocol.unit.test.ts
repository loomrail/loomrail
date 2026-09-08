import { describe, expect, it } from "vitest";

import {
  encodeSupervisorStartFrame,
  parseSupervisorStartFrame,
} from "../src/verification-supervisor-protocol.js";

describe("verification supervisor control protocol", () => {
  const token = "a".repeat(43);

  it("round-trips a bounded target environment without path interpretation", () => {
    const frame = encodeSupervisorStartFrame(token, {
      PATH: "C:\\Program Files\\Node;C:\\Windows\\System32",
      HOME: "C:\\Users\\тестовый пользователь",
    });

    expect(parseSupervisorStartFrame(frame.trimEnd(), token)).toEqual({
      PATH: "C:\\Program Files\\Node;C:\\Windows\\System32",
      HOME: "C:\\Users\\тестовый пользователь",
    });
  });

  it("rejects unauthenticated, malformed and oversized environment frames", () => {
    const frame = encodeSupervisorStartFrame(token, { PATH: "/usr/bin" }).trimEnd();

    expect(parseSupervisorStartFrame(frame, "b".repeat(43))).toBeNull();
    expect(parseSupervisorStartFrame(`${frame}!`, token)).toBeNull();
    expect(parseSupervisorStartFrame(`GO:${token}:e1wiQkFEXCI6MX0`, token)).toBeNull();
    expect(() => encodeSupervisorStartFrame(token, { VALUE: "x".repeat(32_001) })).toThrow(
      "Target environment exceeds the supervisor protocol limit",
    );
  });
});
