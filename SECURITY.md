# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for the
`loomrail/loomrail` repository:

<https://github.com/loomrail/loomrail/security/advisories/new>

Include the affected component and version or commit, reproduction steps, expected impact, and any suggested
mitigation. Do not include real user data, credentials, or unrelated private information.

Loomrail is currently pre-alpha and does not yet publish supported release lines or response-time guarantees. Valid
reports will be acknowledged and handled privately before coordinated disclosure whenever practical.

## Scope

Security boundaries include local process execution, provider credentials, repository access, browser automation,
human approvals, token budgets, logs, artifacts, plugins, and imported agent instructions. A git worktree or container
is not automatically treated as a complete security sandbox.
