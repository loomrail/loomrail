# Bundled samples and the shipped workflow

> Public pre-alpha · [Русская версия](SAMPLES.ru.md) · [Quick start](GETTING-STARTED.md)

Loomrail includes two small repository templates. Registering one copies reviewed regular files into the Loomrail
data directory, initializes a separate local Git repository, and records that repository as a Project. Loomrail does
not run the sample, install dependencies, make a remote, or push anything.

Both samples use only the Node.js standard library. Open the materialized repository path shown in **Settings →
Projects** and verify its untouched baseline with:

```bash
npm test
```

No `npm install` is required.

## Repository catalog

| Built-in Project | Baseline                                               | Included task recipes                        |
| ---------------- | ------------------------------------------------------ | -------------------------------------------- |
| Web application  | Server-rendered task list and optional loopback server | Status filters; accessible empty state       |
| API service      | Pure in-memory HTTP-style issue handler                | Severity filtering; validated issue creation |

Each materialized repository contains `SAMPLE-WORKFLOWS.md`. Copy one recipe's title, brief, and acceptance criteria
unchanged into a new Loomrail Task. The recipes are bounded product examples, not executable scripts and not extra
workflow definitions.

The web sample can be started explicitly with `npm start` at `http://127.0.0.1:4173`. Loomrail never starts it. The
built-in Mock walkthrough still measures Loomrail's own readiness endpoint so a first evaluation needs no second
server. To measure the sample application itself, start it and add an explicit `.loomrail/browser-qa.json` as
described in the [Browser QA guide](BROWSER-QA.md).

## One shipped delivery workflow

Every recipe uses the same domain-owned workflow, `mock-delivery-v1` revision 4:

```text
Discovery → Plan → Implement → Review → QA → Acceptance
```

The historical ID does not mean live providers use a different workflow. Mock, Codex, and Claude Code adapters feed
the same deterministic state machine. The current pre-alpha does not offer workflow selection or custom templates.

## Built-in role catalog

The standard squad dispatches one versioned profile for each provider-run stage:

| Stage     | Assigned built-in role |
| --------- | ---------------------- |
| Discovery | Product Analyst        |
| Plan      | Software Architect     |
| Implement | Developer              |
| Review    | Code Reviewer          |
| QA        | Browser QA             |

Lead PM and Acceptance Manager are also versioned built-in profiles, but the current standard squad does not
dispatch them. Loomrail assembles the criterion-bound Acceptance Package deterministically from current Review and QA
evidence. Only the owner can Accept, Return, or Reject it.

A recipe cannot change a role's capabilities, budget, provider selection, Project Constitution, or approval gates.
Those remain Loomrail state and owner decisions rather than instructions hidden in sample text.

## Choose the right route

- Use **Mock** plus either sample to learn durable requests, budgets, evidence, restart recovery, and acceptance
  without provider quota. Mock does not edit the sample source.
- Use the [full-route example](../examples/full-route/README.md) only after an exact live provider version is admitted.
  It runs a real CLI, consumes quota, and demonstrates an actual repository change.
- A green sample baseline is release evidence for the bundled templates. It is not private dogfood evidence and does
  not make an unverified provider compatible.

The release gate runs every sample test from source and again from the clean npm tarball on macOS and Windows. It also
refuses unreviewed files, dependencies, lifecycle scripts, symbolic links, or a changed catalog identity.
