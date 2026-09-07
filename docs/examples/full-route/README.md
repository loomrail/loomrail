# Real-provider repository route — executor gate

This fixture is retained for the first complete repository-writing acceptance run, but that run is intentionally
disabled in the current build. Loomrail now dispatches only to the OpenAI Responses and Anthropic Messages APIs.
Those adapters serve `DISCOVERY`, `PLAN`, `REVIEW` and `ACCEPTANCE`; they refuse `IMPLEMENT` and `QA` before making a
provider request because no reviewed local workspace tool executor exists yet.

This is a security boundary, not a simulated success. A provider response cannot be treated as proof that a file was
edited or a command passed. Until the executor lands, this fixture must not be cited as full-delivery evidence.

## What can be verified now

1. Follow the [provider setup guide](../../guides/PROVIDER-COMPATIBILITY.md) and configure either
   `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the environment that starts Loomrail.
2. Run `loomrail setup --mode live`. Missing credentials must produce `BLOCKED`; there is no offline success path.
3. Start Loomrail and select **OpenAI Responses**, **Anthropic Messages**, or **Auto** in Project settings.
4. Create a disposable task and start its workflow only if you intend to spend provider quota.
5. Confirm that returned Discovery/Plan data is structured and attributed to the selected provider. When the
   workflow reaches a workspace-writing stage, confirm that it stops with the executor-required refusal and records
   no claimed file/test evidence.

Tests exercise the same adapters through an injected HTTP transport with provider-shaped responses. They do not
contact paid APIs and are not credentialed-live evidence.

## Future acceptance route

When the local executor is implemented and reviewed, this fixture will again cover a disposable Git repository from
Discovery through owner Acceptance. The intended change remains small: add a `farewell(name)` function, preserve the
existing greeting, add a focused Node test, and verify the exact result tree before acceptance.

Record only sanitized observations in [`RUN-REPORT.md`](RUN-REPORT.md). Never record API keys, authorization headers,
bootstrap URLs, cookies, CSRF values, raw provider transcripts, local database paths or absolute repository paths.
