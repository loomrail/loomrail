import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest, listIssues } from "../src/issues.mjs";

test("returns isolated issue values", () => {
  const first = listIssues();
  first[0].title = "Changed by the caller";

  assert.equal(listIssues()[0].title, "Review checkout boundary");
});

test("reports health without external I/O", () => {
  assert.deepEqual(handleRequest({ method: "GET", path: "/health" }), {
    status: 200,
    body: { status: "ready" },
  });
});

test("lists issues and returns a closed not-found error", () => {
  assert.equal(handleRequest({ method: "GET", path: "/issues" }).body.issues.length, 2);
  assert.deepEqual(handleRequest({ method: "DELETE", path: "/issues/issue-1" }), {
    status: 404,
    body: { error: { code: "NOT_FOUND", message: "Route not found" } },
  });
});
