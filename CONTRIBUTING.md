# Contributing to Loomrail

Loomrail is in pre-alpha implementation. The Phase 0 architecture and repository contracts are approved; broader
implementation contributions will open after the initial public checkpoint. Documentation corrections and
well-scoped design feedback are welcome earlier.

Participation in project spaces is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Local setup and verification

The toolchain is pinned in two places and nowhere else: [`.nvmrc`](.nvmrc) holds the Node version and
`packageManager` in `package.json` holds the pnpm version. CI and `pnpm verify` both derive from
them, so never restate either number.

```bash
nvm use          # or: fnm use
corepack enable  # installs the pnpm version pinned by packageManager
pnpm install
pnpm verify
```

Run `pnpm test:e2e` after `pnpm exec playwright install chromium` when changing CLI, daemon session behavior, or the
web shell. Run `pnpm pack:release && pnpm test:release` when changing how the launcher, the daemon or the persistence
layer locate files on disk; see the [release guide](docs/RELEASE.md). macOS and Windows are blocking platforms; platform-specific behavior must not be accepted from only one.

## Public-by-default rule

Treat every committed object as permanently public, even while the repository itself is private. Never commit secrets,
personal filesystem paths, private email addresses, customer data, raw agent transcripts, local databases, logs,
browser traces, or unsanitized screenshots. Deleting a file later does not remove it from Git history.

The `docs/` directory is intentionally versioned. Architecture, ADRs, implementation plans, threat models, design
contracts, and agent rules are part of the product and must evolve with the code.

## Commits

Use Conventional Commit subjects:

```text
<type>(<optional-scope>): <imperative summary>
```

Primary types are `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, and `chore`. Keep commits atomic,
lowercase, and internally consistent. Explain motivation, trade-offs, migrations, security impact, and verification in
the commit body when they are not obvious from the diff.

Maintainers should use their GitHub-provided `noreply` address and sign commits and release tags with an SSH or GPG
key.

## Branches and pull requests

- `main` is the only long-lived branch.
- Use short-lived `feat/`, `fix/`, `docs/`, `refactor/`, or `chore/` branches.
- Keep one pull request focused on one coherent outcome.
- Include required tests, documentation, migration notes, and evidence in the same pull request.
- Use **Squash and merge** to preserve a linear, semantic history.
- Never force-push or delete `main`.

Once the public repository supports enforcement, `main` requires pull requests, resolved conversations, linear
history, and passing CI. While Loomrail has a single maintainer, the ruleset does not require an approval that the pull
request author cannot provide.

## Licensing

Unless stated otherwise, contributions are accepted under the Apache License 2.0 that covers this repository. By
submitting a contribution, you confirm that you have the right to provide it under that license.
