# Loomrail quick start

> Public pre-alpha · [Русская версия](GETTING-STARTED.ru.md) · [Full user guide](USER-GUIDE.md)

This is the shortest safe route from an empty folder to a persisted mock delivery. It does not start Codex or Claude
Code and does not consume provider quota.

## Requirements

- Node.js `>=24.19 <25`
- macOS or Windows; Linux is best effort
- a same-machine browser

## 1. Install and start

Use a project-local install so the selected pre-alpha version stays explicit:

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install loomrail@next
npx loomrail
```

The launcher binds only to loopback and opens a one-time authenticated URL. Keep the terminal open. If the browser
must not open automatically, run `npx loomrail --no-open --port 4176` and open the printed URL on the same machine
within 60 seconds.

To install the launcher on your `PATH` instead:

```bash
npm install -g loomrail@next
loomrail
```

## 2. Complete the mock route

1. Choose **Initialize demo workspace**.
2. Create a task with a concrete brief and observable acceptance criteria.
3. Move it to **Ready**, then choose **Start workflow**.
4. Answer the blocking Human Request.
5. Approve the explicit mock budget increase when the run pauses.
6. Inspect Review and QA evidence, then accept or return the delivery as the owner.

Reloading the page or restarting Loomrail does not erase the task, request, Decision, budget, evidence, or acceptance
state. Stop Loomrail with `Ctrl+C`.

## 3. Connect your repository

Open **Settings → Projects → Register a local repository** and enter the absolute path to its Git top-level directory.
Then open **Project Constitution**:

1. run the read-only bounded scan;
2. review all seven proposed sections and their source labels;
3. adopt the proposal only if it matches the repository;
4. confirm the published `.loomrail/constitution.md` in the repository.

The scan reads only allowlisted metadata and documentation. Loomrail does not write the Constitution before explicit
adoption and refuses to overwrite an owner-edited target.

Before a live run, read the [repository and worktree section](USER-GUIDE.md#4-register-your-own-repository) and the
[threat model](../security/THREAT-MODEL.md). A worktree is isolation from another task, not an operating-system sandbox.

## 4. Try a live provider

Install and authenticate the provider CLI yourself, then restart Loomrail with an explicit adapter:

```bash
LOOMRAIL_PROVIDER=CODEX npx loomrail
```

Codex currently serves all six stages. Claude Code serves Discovery, Plan, and Review only; Loomrail opens a Human
Request instead of silently switching providers on an unsupported stage. Loomrail never commits, pushes, merges, or
deploys agent changes.

Continue with the [full user guide](USER-GUIDE.md) for change inspection, restart recovery, state backup, and
troubleshooting, or use the [reproducible full-route example](../examples/full-route/README.md).
