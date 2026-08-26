import { describe, expect, it } from "vitest";

import { eventSignalSchema } from "../src/event-stream.js";

const validSignal = {
  projectId: "01JB0000000000000000000000",
  aggregateType: "WORK_ITEM",
  aggregateId: "01JB0000000000000000000001",
} as const;

describe("eventSignalSchema", () => {
  it("accepts a signal carrying exactly the three identifiers", () => {
    expect(eventSignalSchema.parse(validSignal)).toEqual(validSignal);
  });

  // Each negative case mutates exactly one field of the proven-valid fixture, so a failure
  // identifies the rule that broke rather than "something in this object is wrong".
  it("rejects an unknown aggregate type", () => {
    expect(() => eventSignalSchema.parse({ ...validSignal, aggregateType: "STAGE_ATTEMPT" })).toThrow();
  });

  it("rejects a missing project", () => {
    const { projectId: _omitted, ...withoutProject } = validSignal;
    expect(() => eventSignalSchema.parse(withoutProject)).toThrow();
  });

  // The load-bearing one: spec §5.2 says the frame carries no content. Without .strict() a field
  // added later would ride along unvalidated, and the "no content in the channel" claim would
  // quietly stop being true while every other test stayed green.
  it("rejects any field beyond the three, so content cannot be added by accident", () => {
    expect(() => eventSignalSchema.parse({ ...validSignal, title: "Ship the billing page" })).toThrow();
  });
});
