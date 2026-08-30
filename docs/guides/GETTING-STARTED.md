# Loomrail quick start

> Public pre-alpha · [Русская версия](GETTING-STARTED.ru.md) · [Owner guide](USER-GUIDE.md)

This is the shortest safe route from an empty directory to a persisted mock delivery. It starts no Codex or Claude
Code process, touches no existing repository, and spends no provider quota.

## Requirements

- Node.js `>=24.19 <25`
- macOS or Windows; Linux is best effort
- a browser on the same machine

Check Node before installing:

```bash
node --version
```

## 1. Install and start

Create a separate evaluation directory. Do not begin inside a repository you care about.

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install loomrail@next
npx loomrail
```

`next` selects the public pre-alpha channel explicitly. The launcher binds to `127.0.0.1`, opens a one-time
authenticated URL, and uses the deterministic `MOCK` provider unless you explicitly choose another provider. Keep the
terminal open.

If the browser must not open automatically:

```bash
npx loomrail --no-open --port 4176
```

Open the printed URL in a browser on the same machine within 60 seconds. `--no-open` does not enable remote access.

To put the launcher on your `PATH` instead, run `npm install -g loomrail@next` and then `loomrail`. The project-local
installation above is recommended for evaluation because the selected pre-alpha channel remains visible.

## 2. Complete the mock delivery

1. Choose **Initialize demo workspace**.
2. Create a task with a concrete outcome and observable acceptance criteria.
3. Move it to **Ready**, then choose **Start workflow**.
4. Answer the blocking Human Request.
5. Approve the explicit mock budget increase when the run pauses.
6. Inspect Review and QA evidence, then accept or return the delivery as the owner.

Reloading the page or restarting Loomrail does not erase the task, request, Decision, budget, evidence, or acceptance
state. Stop Loomrail with `Ctrl+C` and wait for the command to exit.

## After the first run

Continue with the [owner guide](USER-GUIDE.md) before registering a repository or enabling a live provider. It covers
Project Constitution review, task worktrees, change inspection, recovery, backup, and troubleshooting. Read the
[threat model](../security/THREAT-MODEL.md) before exposing sensitive code to an agent: a worktree isolates task files,
but it is not an operating-system sandbox.
