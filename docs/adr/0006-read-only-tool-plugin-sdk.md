# ADR-0006: Plugin SDK v1 is a read-only MCP tool module

- Status: accepted
- Date: 2026-08-31
- Owners: Loomrail maintainers

## Context

Loomrail needs a third-party extension interface without giving untrusted code authority over its deterministic
workflow. C1 already owns local process consent, MCP discovery, tool grants, provider isolation, bounded audit,
revoke and recovery. Adding a second plugin transport or a set of in-process workflow hooks would duplicate those
controls and create a path around them.

An executable manifest is useful for compatibility and review, but it is not an operating-system sandbox. A process
can lie about annotations or perform work during startup. The first SDK therefore needs to make a narrow promise that
the host can actually enforce: only granted tool names reach a provider through the C1 gateway, and no plugin method
can mutate Loomrail domain state.

## Decision

`loomrail/plugin-sdk` is a deep authoring module with three public operations:

1. define a typed read-only tool;
2. derive and validate one versioned plugin manifest from those tools;
3. serve the exact tool set over bounded MCP stdio.

The manifest contains identity, version, relative bundled entrypoint, license, declared outbound hosts and the exact
tool metadata. It cannot contain executable commands, argv, cwd, environment values, credentials, workflow hooks or
permission-bypass options. The SDK owns MCP annotations and always declares tools read-only and non-destructive.

The C1 gateway remains the host seam. A compatible plugin process is consented, probed and granted like any other
local MCP profile. Plugin authors do not import daemon, domain or persistence modules, and Loomrail never imports
plugin code into its own process.

## Rejected alternatives

### In-process JavaScript hooks

Rejected because package code would share daemon memory and authority, and unloading, recovery and permission
revocation would become unreliable.

### A new plugin RPC protocol

Rejected because C1 already provides typed discovery/call semantics, process supervision and provider adapters. A
second protocol would reproduce policy and audit code with different failure modes.

### Workflow lifecycle hooks in v1

Rejected because a plugin could become a second workflow engine or self-approve state changes. Future extension
points must enter as validated Loomrail commands with a separate product decision.

### Marketplace or runtime package installation

Rejected for C2. Distribution trust, signatures, provenance, updates and rollback are a later catalog decision.

## Consequences

- authors get one small TypeScript interface with inferred inputs and a standard stdio runtime;
- providers see only the Loomrail proxy and owner-granted names;
- SDK manifests are review/provenance data, not claims of sandbox enforcement;
- useful plugins that need writes, secrets or workflow hooks wait for explicit later contracts;
- the main npm package must expose and clean-install test the SDK subpath.

## Required verification

- schema rejects commands, absolute/traversing entrypoints, duplicate tools/hosts and unsupported permission fields;
- manifest tool names and served tool names cannot drift;
- SDK-generated MCP annotations are read-only/non-destructive and cannot be overridden;
- handler failure is bounded and does not emit a stack or secret through stdout;
- a synthetic SDK plugin passes a real C1 capability probe and exposes no resources or prompts;
- the packed npm artifact resolves `loomrail/plugin-sdk` outside the monorepo.
