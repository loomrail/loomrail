# Q6 release-integrity and supply-chain evidence

**Date:** 2026-09-02

**Scope:** local implementation and macOS/Windows CI run

## Dependency-policy observation

The first strict frozen install rechecked 547 lockfile entries and refused one publisher-trust downgrade:
`semver@6.3.1`. `pnpm why` showed it is selected only by the Babel/ESLint development graph. The repository now has
one exact exception with that scope, historical rationale and an upstream-removal condition; it grants no lifecycle
script permission and does not enter the published runtime graph.

With that exception recorded:

```text
Lockfile passes supply-chain policies (547 entries)
No known vulnerabilities found
```

The enforced settings are strict 24-hour release age, refusal when registry publication time is missing,
publisher-trust no-downgrade, committed-lockfile re-verification, exotic-transitive blocking, and strict denial of
unreviewed dependency lifecycle scripts. Release-manifest tests also reject runtime dependency specs that are not
exact or caret semver registry ranges.

## Integrity mutation tests

`node --test scripts/release-integrity.test.mjs` passed 7/7 tests:

- create and verify the closed receipt plus installed-file manifest;
- reject an unknown receipt field and a dirty receipt when clean CI source is required;
- reject npm pack traversal metadata;
- reject staged files/directories outside the release allowlist before `npm pack` runs;
- reject tarball bytes changed after receipt generation;
- reject an installed package file changed after extraction;
- accept the current release dependency manifest only when every external spec is a supported registry semver.

The module uses only the Node standard library. It rejects non-regular staged entries, unsafe/unknown/duplicate paths,
unknown metadata fields, unexpected identity or bundled dependencies, inconsistent sizes and npm SHA-1/SHA-512, and
receipt/tarball/file digest drift.

## Real candidate observation

`pnpm pack:release && pnpm test:release` produced and verified:

| Observation               | Value                                       |
| ------------------------- | ------------------------------------------- |
| Package                   | `loomrail@0.1.0-alpha.5`                    |
| Package files             | 60 allowlisted regular files                |
| Receipt schema            | `loomrail.release-integrity.v1`             |
| Receipt size              | about 12 KiB                                |
| Tarball size              | below the enforced 64 MiB limit             |
| Tarball digests           | SHA-1, SHA-256 and SRI SHA-512 pass         |
| Installed-file check      | every package-owned file matched            |
| Dependency scripts        | install succeeded with ignored scripts      |
| Consumer production audit | 0 known vulnerabilities                     |
| Runtime smoke             | doctor/data-path/Plugin SDK/MCP/daemon pass |

The local receipt correctly records `source.tree=DIRTY` because Q6 was tested before commit. Unit coverage proves
that CI refuses this observation. The post-commit macOS/Windows release jobs must produce `CLEAN`, verify the receipt,
audit the consumer graph, and run the unchanged smoke.

The receipt contains source repository/commit and tool versions, but no timestamp, runner/user name, environment,
absolute path, token, cookie, or credential. It is ignored build output and was not added to Git.

MCP and Plugin SDK probe wrappers have a 10-second harness budget around the unchanged 5-second product probe
deadline. Loaded parallel root runs showed unrelated latency-bound daemon tests and the probe timing out together;
the focused Plugin SDK rerun passed 11/11. The root workspace test gate plus process-heavy MCP gateway and daemon
files are therefore serialized rather than weakening any production deadline. Non-landing ESLint, full TypeScript
typecheck and the Q5 fault-injection gate pass; the latter covers 50 files/486 tests, the daemon suite (24 files/188
tests), and the durable interrupted-run crash drill.

The final serialized `pnpm test` completed with exit code 0. Its process-heavy boundary results include MCP gateway
5/5 files and 25/25 tests, daemon 24/24 files and 188/188 tests, Plugin SDK 2/2 files and 11/11 tests, and CLI 4/4
files and 22/22 tests.

`pnpm verify` passes formatting, the 571-file public-tree/toolchain gate and the full build, then stops at exactly the
three protected `apps/landing/src/main.ts` lint diagnostics on lines 630, 631 and 634. ESLint over every non-landing
path passes, as do the full TypeScript check and `pnpm test`; Q6 does not modify or waive the landing diagnostics.

## Cross-platform CI evidence

[GitHub Actions run 33668749126](https://github.com/loomrail/loomrail/actions/runs/33668749126) exercised commit
`f4bb85d` on 2026-09-02:

| Job                              | Result                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Clean install (`macos-latest`)   | pass: 547-entry policy, clean receipt, exact installed files, audit and runtime smoke  |
| Clean install (`windows-latest`) | pass: 547-entry policy, clean receipt, exact installed files, audit and runtime smoke  |
| Browser smoke (macOS/Windows)    | pass on both platforms                                                                 |
| Verify (macOS/Windows)           | install, production audit and crash/fault pass; only protected landing lint then fails |

The release verifier rejects a non-`CLEAN` source observation whenever `CI=true`, so both completed Release jobs
also prove the committed receipt path saw a clean checkout. Their consumer audits reported zero vulnerabilities.
Both Verify jobs reached the same three landing diagnostics at lines 630, 631 and 634 after the Q5 crash/fault gate;
there was no Q6 or platform-specific failure.

## Authority boundary

The receipt is unsigned integrity metadata, not npm/Sigstore provenance. Ordinary CI retains `contents: read`; Q6
adds no publish workflow, npm credential, tag, GitHub Release, registry write, or dist-tag mutation. Registry
provenance remains an explicit stable-release gate that can be satisfied only after owner-authorized trusted
publishing from a supported hosted workflow. Private dogfood and the protected landing Verify failure remain
separate gates.
