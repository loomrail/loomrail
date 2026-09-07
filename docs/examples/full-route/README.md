# Local-provider repository route

This fixture covers a complete disposable repository-writing acceptance run through the signed-in local Codex CLI or
Claude Code CLI. Both adapters serve all six stages. Loomrail gives the provider no repository path or project
environment; selected file and command operations cross only its one-use bounded workspace MCP connection.

This is a security boundary, not a simulated success. Provider prose cannot prove that a file was edited or a
command passed. Only measured executor and QA records may be cited as file or test evidence.

## Verification route

1. Follow the [provider setup guide](../../guides/PROVIDER-COMPATIBILITY.md), install an official CLI, and sign in with
   `codex login` or `claude auth login`.
2. Run `loomrail setup --mode live`. A missing, incompatible, or signed-out CLI must produce `BLOCKED`; there is no
   offline success path.
3. Start Loomrail and select **Codex CLI**, **Claude Code CLI**, or **Auto** in Project settings.
4. Create a disposable task and start its workflow only if you intend to consume subscription allowance.
5. Confirm that structured stage results are attributed to the selected provider and that `IMPLEMENT`/`QA` evidence
   matches the executor audit and resulting Git tree.

Tests exercise the adapters with test-only CLI fixtures. They do not contact provider services. The intended live
change remains small: add a `farewell(name)` function, preserve the existing greeting, add a focused Node test, and
verify the exact result tree before acceptance.

Record only sanitized observations in [`RUN-REPORT.md`](RUN-REPORT.md). Never record provider session credentials,
API keys inherited from an unrelated environment, bootstrap URLs, cookies, CSRF values, raw provider transcripts,
local database paths or absolute repository paths.
