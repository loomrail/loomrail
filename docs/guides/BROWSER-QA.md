# Browser QA

> [Русская версия](BROWSER-QA.ru.md) · [Owner guide](USER-GUIDE.md)

Loomrail, not the selected AI provider, decides whether browser QA passed. At the QA stage the local daemon opens a
fresh isolated Chromium context, runs a bounded declarative plan, and records the exact Git tree, browser environment,
scenario results, screenshots, traces, console/network observations, and defects. A provider message saying that the
page works cannot advance the workflow to acceptance.

## The built-in demo

After the one-time `npx playwright install chromium` prerequisite, the bundled **Fixture web application** needs no
extra target command. Its mock implementation deliberately changes no app,
so its built-in QA plan measures Loomrail's public readiness endpoint on the actual loopback port. This verifies the
complete evidence and acceptance route without starting Codex, Claude Code, or a second development server.

The same materialized Project now includes an executable [sample application and task recipes](SAMPLES.md), but this
Mock plan does not claim to test that application. Start the sample explicitly and configure it like any owner
repository when the application itself is the QA target.

## Configure a web repository

For your own project, start the application on a loopback address and add `.loomrail/browser-qa.json` to the
repository. Loomrail does not guess or run `dev`, `npm`, or shell commands: repositories use different commands and
ports, and starting one without an approved launch contract would grant execution authority implicitly.

Minimal example:

```json
{
  "schemaVersion": 1,
  "targetOrigin": "http://127.0.0.1:4173",
  "revision": 1,
  "targets": [
    {
      "id": "desktop-light-en",
      "viewport": { "width": 1280, "height": 800 },
      "locale": "en-US",
      "theme": "LIGHT"
    },
    {
      "id": "mobile-dark-ru",
      "viewport": { "width": 320, "height": 720 },
      "locale": "ru-RU",
      "theme": "DARK"
    }
  ],
  "scenarios": [
    {
      "id": "home",
      "title": "Home opens without overflow",
      "steps": [
        {
          "id": "open-home",
          "title": "Open home",
          "action": { "type": "NAVIGATE", "path": "/" }
        }
      ],
      "assertions": [
        {
          "id": "home-path",
          "title": "Home path is active",
          "rule": { "type": "URL_PATH", "path": "/" }
        },
        {
          "id": "no-overflow",
          "title": "The page has no horizontal overflow",
          "rule": { "type": "NO_HORIZONTAL_OVERFLOW" }
        }
      ]
    }
  ]
}
```

`targetOrigin` must be a literal HTTP(S) loopback origin using `127.x.x.x`, `localhost`, or `[::1]`. `localhost` is
resolved before Chromium starts, must resolve only to loopback addresses, and is pinned to one verified address for
the run. Put only paths in `NAVIGATE`; external origins and redirects are blocked. The supported step actions are `NAVIGATE`, semantic-locator `CLICK`,
semantic-locator `PRESS`, and `WAIT_FOR_IDLE`. Assertions are `VISIBLE`, `TEXT_CONTAINS`, `URL_PATH`,
`NO_HORIZONTAL_OVERFLOW`, and `FOCUSED`. CSS selectors, XPath, arbitrary JavaScript, downloads, dialogs, mutations,
and signed-in browser profiles are not available to this baseline.

Increment `revision` whenever the intended plan changes. The daemon derives and stores an immutable content hash, so
the Task Cockpit can show which exact plan produced the evidence.

## Run and inspect it

1. Start the project at the configured loopback origin.
2. Start or resume the Loomrail workflow normally; no provider environment variable is needed.
3. Open the task after Review. **Browser QA** shows the tested tree, target, browser/runtime, every target/scenario
   cell, failures, observations, defects, and evidence files.
4. Open screenshots in the browser or download a Playwright trace. The authenticated route verifies the stored file's
   size and SHA-256 hash before streaming it and never exposes its absolute path.

A failed assertion or blocking console/network observation produces `FAILED` evidence and a durable defect. A missing
or invalid config, unhealthy target, forbidden origin, unsafe capability, timeout, or driver crash produces `ERROR`.
Neither outcome opens acceptance. Fix the named condition, keep the target running, and use the offered retry action.

Evidence files live under Loomrail's data directory, outside the repository and SQLite. Loomrail records the
`STANDARD_30_DAYS` retention class and removes screenshot/trace files after 30 days from the latest
transition that closed the work as `DONE` or `CANCELLED`. Cleanup runs in bounded batches at daemon startup, records
an append-only outcome, and unlinks only exact durable attachment paths. It never recursively removes a directory,
follows a symlink, touches a recovery-marker-bound run, or deletes an unknown neighboring file. This pre-alpha has no
end-user retention or cleanup screen yet.
