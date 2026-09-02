const seedTasks = Object.freeze([
  Object.freeze({ id: "task-1", title: "Map the owner journey", completed: true }),
  Object.freeze({ id: "task-2", title: "Verify the acceptance evidence", completed: false }),
]);

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const listTasks = () => seedTasks.map((task) => ({ ...task }));

export const renderTaskList = (tasks) =>
  tasks
    .map(
      (task) =>
        `<li data-status="${task.completed ? "completed" : "open"}"><span>${escapeHtml(task.title)}</span></li>`,
    )
    .join("");

export const renderPage = (tasks = listTasks()) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Loomrail task sample</title>
  </head>
  <body>
    <main>
      <h1>Delivery tasks</h1>
      <ul>${renderTaskList(tasks)}</ul>
    </main>
  </body>
</html>
`;
