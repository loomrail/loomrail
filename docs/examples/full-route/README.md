# Reproducible Codex route

This fixture exercises one real Loomrail route from Discovery to the owner Acceptance gate. It is deliberately tiny:
plain JavaScript, Node's standard test runner, no dependency install, no network requirement, and no nested `.git`
directory in the Loomrail repository.

The route consumes Codex quota and runs the Codex CLI with your operating-system identity. Read the
[user guide](../../guides/USER-GUIDE.md#5-run-and-inspect-live-work) and
[threat model](../../security/THREAT-MODEL.md) first. Loomrail creates a branch and linked worktree but does not commit,
push, merge, or accept the result for you.

## 1. Create an isolated repository

From a Loomrail source checkout on macOS or another POSIX shell:

```sh
example_root="$(mktemp -d)"
cp -R docs/examples/full-route/fixture/. "$example_root/"
git -C "$example_root" init -b main
git -C "$example_root" add .
git -C "$example_root" -c user.name="Loomrail D2" -c user.email="loomrail-d2@example.invalid" commit -m "fixture baseline"
node --test "$example_root/test/greeting.test.mjs"
printf '%s\n' "$example_root"
```

Windows PowerShell:

```powershell
$exampleRoot = Join-Path ([IO.Path]::GetTempPath()) ("loomrail-d2-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $exampleRoot | Out-Null
Copy-Item -Recurse -Force "docs/examples/full-route/fixture/*" $exampleRoot
git -C $exampleRoot init -b main
git -C $exampleRoot add .
git -C $exampleRoot -c user.name="Loomrail D2" -c user.email="loomrail-d2@example.invalid" commit -m "fixture baseline"
node --test (Join-Path $exampleRoot "test/greeting.test.mjs")
$exampleRoot
```

Keep the printed absolute path. Register exactly that directory in **Settings → Projects → Register a local
repository**.

## 2. Start Loomrail with Codex

Authenticate the Codex CLI yourself. This reproducible route deliberately pins the whole test process with
`LOOMRAIL_PROVIDER=CODEX`; ordinary use can select Codex per project in **Settings → AI provider** without restarting.
Start the same Loomrail installation you used in the user guide and confirm the launcher reports all three facts before
creating the task:

```text
Provider: CODEX
Provider CLI available: yes
Repository workspaces: yes
```

Do not continue if the launcher reports `MOCK`: that would demonstrate the scripted route, not D2.

## 3. Create the task

Create a Task in the registered fixture project with this exact brief:

**Title**

```text
Add a farewell with owner-chosen punctuation
```

**Description**

```text
During Discovery, if no punctuation Decision exists, ask the owner once whether farewell messages end with a period
or an exclamation mark. If that Decision already exists, do not ask for the choice again and do not request
confirmation or permission to proceed; complete Discovery using the recorded answer. Then export farewell(name) from
src/greeting.mjs using the chosen punctuation. Preserve greet, add focused tests, use only the existing Node
standard-library test runner, and do not add dependencies or use the network.
```

**Acceptance criteria**

```text
Discovery records exactly one punctuation Human Request and Decision before implementation, then completes without
another owner gate.
farewell("Ada") returns "Goodbye, Ada." for period or "Goodbye, Ada!" for exclamation, matching that Decision.
The existing greet behavior remains unchanged and node --test passes.
```

Move the task to **Ready** and select **Start workflow**.

## 4. Resolve the decision and inspect the run

Discovery should open a blocking Human Request for punctuation. Choose either answer and select **Answer & resume**.
The particular punctuation is not the proof; the durable question, answer, and resulting Decision are.

Let the workflow reach **Acceptance package**, but do not accept it blindly. Confirm all of the following:

- Workflow has successful Discovery, Plan, Implement, Review, and QA attempts.
- Decisions contains the punctuation choice.
- Changes names `src/greeting.mjs` and a focused test file; each text diff matches the Decision.
- Review evidence is a `REVIEW_REPORT` attributed to `CODEX`.
- QA evidence is a `QA_REPORT` attributed to `CODEX` and names the verification performed.
- Acceptance is waiting for the owner; the task is not Done yet.

Run the fixture's verification in the worktree path shown by Loomrail:

```sh
node --test "/absolute/path/shown/by/loomrail/test/greeting.test.mjs"
```

Only after the diff, test result, evidence, and criterion matrix agree should the owner choose **Accept delivery**.
Return or reject it when they do not.

## 5. Record sanitized evidence

Copy only non-sensitive observations into [`RUN-REPORT.md`](RUN-REPORT.md): CLI versions, selected answer, changed
relative paths, line counts, evidence titles/checks, and acceptance state. Never copy the bootstrap URL, cookies, CSRF
values, raw provider transcript, data-directory path, source-repository absolute path, or SQLite database.

The fixture repository is temporary. Remove it and its Loomrail worktree only after preserving any result you intend
to keep through your own Git workflow.
