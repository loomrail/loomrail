import assert from "node:assert/strict";
import test from "node:test";

import { listTasks, renderPage, renderTaskList } from "../src/tasks.mjs";

test("returns isolated task values", () => {
  const first = listTasks();
  first[0].title = "Changed by the caller";

  assert.equal(listTasks()[0].title, "Map the owner journey");
});

test("renders task state and escapes task titles", () => {
  const list = renderTaskList([{ id: "unsafe", title: "Review <script>", completed: false }]);

  assert.match(list, /data-status="open"/);
  assert.match(list, /Review &lt;script&gt;/);
  assert.doesNotMatch(list, /<script>/);
});

test("renders a complete accessible document shell", () => {
  const page = renderPage();

  assert.match(page, /<meta name="viewport"/);
  assert.match(page, /<h1>Delivery tasks<\/h1>/);
  assert.equal((page.match(/<li /g) ?? []).length, 2);
});
