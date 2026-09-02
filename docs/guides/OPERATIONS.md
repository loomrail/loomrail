# Loomrail operations guide

> Public pre-alpha · [Русская версия](OPERATIONS.ru.md) · [Owner guide](USER-GUIDE.md)

This guide is the operational contract for the npm launcher: install checks, local diagnostics, data preservation,
upgrade, rollback, and uninstall. Loomrail is local-first. These commands do not upload a support report or modify a
provider account.

## Supported installation

The current package supports Node.js `>=24.19 <25` on macOS and Windows. Linux remains best effort. Git is required
for repository and worktree operations; Browser QA separately needs the Chromium build installed by Playwright.

For an isolated evaluation install:

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@next
npx playwright install chromium
npx loomrail doctor
npx loomrail start
```

`next` is the explicit pre-alpha channel. A global installation uses
`npm install -g --ignore-scripts loomrail@next`, followed by `npx playwright install chromium`, `loomrail doctor`,
and `loomrail start`. Pin an exact version instead of `next` when you need a reproducible installation. Loomrail does
not require dependency lifecycle scripts; Chromium remains a separate, visible installation step.

## Verify package origin

Use an exact version when verifying a release; a moving `next` tag can change after review:

```bash
npm view loomrail@<exact-version> name version dist.integrity --json
npm install --ignore-scripts loomrail@<exact-version>
npm audit signatures
```

The registry integrity value binds the downloaded tarball. `npm audit signatures` verifies registry signatures and
available provenance attestations for the installed dependency graph. A release that advertises Loomrail provenance
must link to this public repository, the trusted publish workflow, and the reviewed source commit. Provenance does
not prove that the code is safe; keep the exact version, release notes, and backup boundary visible.

The current published pre-alpha may predate the trusted-publishing policy. A future stable release cannot pass its
release gate without registry provenance. The JSON file produced beside a local candidate tarball is an unsigned
integrity receipt, not a registry attestation. See the [supply-chain policy](../security/SUPPLY-CHAIN.md).

## Read-only diagnostics

Run the human-readable check:

```bash
npx loomrail doctor
```

Or produce a machine-readable local support summary:

```bash
npx loomrail doctor --json
```

The report checks the declared Node range, Git launch, data-directory access, SQLite integrity and migration
compatibility, and supported provider CLI installation/authentication. It does not start the daemon or browser,
create the data directory, apply migrations, recover workflows, or change provider authentication.

`PASS` and `WARN` exit with code 0. A new installation with no database or an installation using only Mock is a
warning, not a failure. `FAIL` exits with code 1 and covers an unsupported runtime, missing/unlaunchable Git,
unavailable storage, and corrupt, drifted, future, or unreadable state.

The JSON is deliberately allowlisted. It contains no current directory, home directory, data path, repository path,
raw environment value, provider account, command output, credential, or exception message. Review it before sharing
it anyway: provider presence and authentication state are still local machine metadata.

Supported provider probes are bounded read-only status calls. Loomrail ignores their output and observes only the
exit result:

| Provider    | Probe observed by Loomrail | Credential owner |
| ----------- | -------------------------- | ---------------- |
| Mock        | none; always ready         | none             |
| Codex       | `codex login status`       | Codex CLI        |
| Claude Code | `claude auth status`       | Claude Code CLI  |

Loomrail does not install these CLIs, sign in for you, or persist their credentials. Provider versions are not yet a
validated compatibility matrix; run `doctor` and the mock walkthrough after either CLI changes.

To reveal the exact local storage path explicitly:

```bash
npx loomrail data-path
```

Unlike `doctor`, this command intentionally prints an absolute path. Do not paste it into a public issue without
reviewing it.

## Start and stop

`npx loomrail start` is the explicit launch command. The previous `npx loomrail` form remains equivalent. Both accept
`--no-open` and `--port N`. Stop with `Ctrl+C` and wait for the shutdown message before preserving, restoring,
upgrading, or removing local state.

## Operational logs

The production launcher keeps redacted structured diagnostics under `logs/` in the data directory. Logs are capped
at 2 MiB per segment and 16 MiB in total, rotate at least daily while active, and are removed after 30 days. They are
not the durable Event audit, acceptance evidence, or raw provider output.

Stop Loomrail before either management command. Export writes only revalidated, re-redacted NDJSON to stdout, so use
shell redirection only to a location you intend to review and protect:

```bash
npx loomrail logs export > loomrail-logs.ndjson
npx loomrail logs delete
```

Export is complete-or-error and includes neither source filenames nor the data-directory path. Delete removes only
Loomrail-owned operational segments; it leaves unknown files in `logs/` and does not touch SQLite, migration backups,
Browser QA artifacts, repositories, workspaces, provider credentials, or Git state. Both commands refuse to run
while a live daemon owns the writer lease. Review an export before sharing it: redaction reduces disclosure risk but
cannot prove arbitrary application text harmless.

## Preserve and restore

The data directory contains the SQLite database and possible WAL files, migration safety backups, Browser QA
artifacts, redacted operational logs, demo repositories, and managed task worktrees. It does not contain external
repositories or provider credentials.

To preserve an installation:

1. Run `loomrail data-path` and record the exact path.
2. Stop Loomrail and wait for exit.
3. Copy or archive the **whole data directory**, including `state.sqlite-wal` and `state.sqlite-shm` if present.
4. Back up every registered external repository separately.
5. Preserve valuable uncommitted agent work from the displayed worktree or commit it yourself in its repository.

Never copy only `state.sqlite` while Loomrail is running. The files under `backups/` are automatic pre-migration
safety copies, not a scheduled full backup or a portable workspace export.

For the least surprising restore, stop Loomrail, restore the whole directory to the same path, restore registered
repositories to their original paths, install the same Loomrail version, run `doctor`, and then start. Linked Git
worktrees record metadata on both sides; moving only the Loomrail directory does not make them portable.

## Upgrade

Pre-alpha schema changes are forward migrations. Before every upgrade:

1. Note the exact installed Loomrail version.
2. Stop Loomrail and preserve the whole data directory as above.
3. Review the target's release notes, exact registry integrity, and advertised provenance.
4. Install an explicit target version or intentionally update the `next` channel.
5. Run `loomrail doctor`. `STATE_UPGRADE_REQUIRED` is expected before the first start with a newer compatible build.
6. Start normally. Only startup applies migrations and performs recovery.
7. Run the mock walkthrough before trusting live-provider work.

An automatic database copy may be created under `backups/` immediately before a non-empty database migration. Keep
your own pre-upgrade whole-directory backup as well; the automatic copy excludes repositories and other installation
files.

## Roll back

Loomrail does not promise down-migrations. Do not open state already migrated by a newer build with an older binary.
To roll back safely:

1. Stop the newer build.
2. Preserve its current whole data directory separately in case investigation needs it.
3. Restore the **pre-upgrade** whole-directory backup.
4. Reinstall the exact Loomrail version that created that backup.
5. Run `doctor`, then start.

If no matching pre-upgrade backup exists, keep the newer state and report the problem; guessing at individual SQLite
files risks losing committed WAL state.

## Uninstall and local data

Removing the npm package and removing owner data are separate actions.

1. Stop Loomrail and preserve anything you may need.
2. Remove the package from the evaluation project with your package manager, or use `npm uninstall -g loomrail` for a
   global installation.
3. Run the previously recorded path through Finder or File Explorer and inspect it before moving that exact Loomrail
   data directory to Trash/Recycle Bin.

The package uninstall deliberately leaves the data directory in place. `loomrail logs delete` removes only owned log
segments; Loomrail provides no recursive installation reset command. It also does not remove source repositories,
provider configuration or credentials, Git commits/branches, or worktree metadata stored by source repositories.
Inspect those repositories separately before any manual cleanup.

## Retention and privacy

Durable Tasks, Events, Decisions, usage, and acceptance records remain until the owner removes the installation data.
Browser QA screenshots and traces use the audited `STANDARD_30_DAYS` policy after a task reaches `DONE` or
`CANCELLED`. Operational logs use the same 30-day maximum plus a 16 MiB capacity bound; raw provider output is not
recorded. Unsafe or unknown files are preserved rather than recursively deleted. There is no telemetry or crash
upload in this release, and no supported online workspace export/import or retention UI.

For the product workflow, continue with the [quick start](GETTING-STARTED.md) and [owner guide](USER-GUIDE.md). For
maintainer packaging gates, see the [release guide](../RELEASE.md).
