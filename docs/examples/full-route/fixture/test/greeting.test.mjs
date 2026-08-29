import assert from "node:assert/strict";
import test from "node:test";

import { greet } from "../src/greeting.mjs";

test("greets a named person", () => {
  assert.equal(greet("Ada"), "Hello, Ada.");
});
