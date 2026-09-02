# Web sample task recipes

Use one recipe unchanged when creating a Loomrail Task. Both recipes target the shipped
Discovery → Plan → Implement → Review → QA → Acceptance workflow. They do not execute automatically.

## Recipe 1 — Filter the task list

**Title**

```text
Add explicit task-status filters
```

**Brief**

```text
Add All, Open and Completed controls to the server-rendered task page. Keep All as the default, express filtering in
the pure task module, preserve HTML escaping, and do not add dependencies, client-side JavaScript or non-loopback
network access. Add focused tests for every filter and for the unchanged default page.
```

**Acceptance criteria**

```text
All shows both seed tasks, Open shows only the unfinished task, and Completed shows only the finished task.
Unknown filter input behaves as All and never changes the seed task values.
The existing escaping and complete-document tests pass together with the new focused tests under node --test.
```

## Recipe 2 — Accessible empty state

**Title**

```text
Render an accessible empty task state
```

**Brief**

```text
When the task list is empty, render a concise status message instead of an empty list. Keep non-empty markup and HTML
escaping unchanged. Use semantic server-rendered HTML, add focused tests, and do not add dependencies or client-side
JavaScript.
```

**Acceptance criteria**

```text
An empty input renders exactly one visible status message and no empty ul element.
A non-empty input preserves the current list markup and escaped titles.
All tests pass with node --test and no install or network step.
```
