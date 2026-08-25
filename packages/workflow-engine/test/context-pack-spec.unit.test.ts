import { describe, expect, it } from "vitest";

import { ContextPackSpecError, validateContextPackSpec } from "../src/index.js";

const section = (id: string, ordinal: number, required: boolean) => ({ id, ordinal, required });

describe("context pack spec validation", () => {
  it("orders sections by ordinal", () => {
    const spec = validateContextPackSpec({
      schemaVersion: 1,
      sections: [section("EVIDENCE", 1, false), section("WORK_ITEM_BRIEF", 0, true)],
    });
    expect(spec.sections.map(({ id }) => id)).toEqual(["WORK_ITEM_BRIEF", "EVIDENCE"]);
  });

  it("rejects a duplicated section", () => {
    expect(() =>
      validateContextPackSpec({
        schemaVersion: 1,
        sections: [section("WORK_ITEM_BRIEF", 0, true), section("WORK_ITEM_BRIEF", 1, false)],
      }),
    ).toThrow(ContextPackSpecError);
  });

  it("rejects a gap in the ordinals", () => {
    expect(() =>
      validateContextPackSpec({
        schemaVersion: 1,
        sections: [section("WORK_ITEM_BRIEF", 0, true), section("EVIDENCE", 2, false)],
      }),
    ).toThrow(ContextPackSpecError);
  });

  it("rejects a spec with no required section", () => {
    // Без обязательной секции урезание может выбросить всё и запустить агента ни с чем.
    expect(() =>
      validateContextPackSpec({
        schemaVersion: 1,
        sections: [section("EVIDENCE", 0, false)],
      }),
    ).toThrow(ContextPackSpecError);
  });
});
