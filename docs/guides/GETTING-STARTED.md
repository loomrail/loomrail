# Getting started

> Public pre-alpha · [Русская версия](GETTING-STARTED.ru.md)

This route connects Loomrail to a real provider API. It can consume provider quota. Use a fresh empty directory and a
key with an account-level spending limit appropriate for evaluation.

## 1. Configure one provider

Set either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the terminal that will run Loomrail. The key is read from the
process environment, sent only to that provider, and is not stored in the Loomrail database.

Then run the canonical install sequence:

<!-- loomrail-guided-activation-v1:start -->

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@next
npx playwright install chromium
npx loomrail try
```

<!-- loomrail-guided-activation-v1:end -->

The command performs a read-only preflight first. Missing credentials, an invalid `LOOMRAIL_PROVIDER` override,
missing Chromium, or an unsafe local state upgrade blocks startup and writes nothing. When ready, it states the local
side effects, binds the daemon to `127.0.0.1`, and opens a one-time authenticated browser URL.

Use `npx loomrail setup --mode live` for the preflight alone or `npx loomrail doctor` for the detailed report.

## 2. Create the guided task

1. Choose **Prepare demo workspace**.
2. In **Settings → AI provider**, select **OpenAI Responses**, **Anthropic Messages**, or leave **Auto** enabled.
3. Create the displayed task and move it to **Ready**.
4. Review the displayed token budget and model tier, then start the workflow.
5. Answer any durable Human Request in **Attention** and review any budget change before approving it.
6. Inspect provider evidence before making an owner decision.

Current pre-alpha API adapters run Discovery, Plan, Review, and Acceptance. Implementation and QA stop with an
explicit unsupported-stage error until the local workspace tool executor is implemented and security-reviewed. This
is deliberate: a model response is not proof that repository files changed or that tests ran.

## 3. Stop and resume

Keep the launch terminal open and press `Ctrl+C` to stop Loomrail. Workflow state, requests, budgets, and evidence are
stored in local SQLite and survive restart. The browser is delivery only; it is never the source of workflow truth.

For a no-open launch:

```bash
npx loomrail try --no-open --port 4176
```

Open the printed URL on the same machine within 60 seconds. This does not enable remote access.

Before using a real repository, read the [owner guide](USER-GUIDE.md), [provider API compatibility](PROVIDER-COMPATIBILITY.md),
[Browser QA guide](BROWSER-QA.md), and [threat model](../security/THREAT-MODEL.md).
