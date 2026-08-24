# ADR-0003 — Loopback daemon and one-time browser bootstrap

**Status:** Accepted
**Date:** 2026-08-22

## Context

Binding to localhost does not authenticate a caller. Any website opened by the user can attempt requests to local
ports, and another local process can also connect. Putting a long-lived token in a query string leaks it through
history, logs and referrers. The browser UI still needs a low-friction one-command startup.

## Decision

### Listener

- bind only to explicit loopback addresses;
- prefer an OS-assigned available port; allow a fixed port only through explicit local configuration;
- startup fails if address resolution would expose a non-loopback interface;
- remote/LAN mode does not exist in MVP.

### Bootstrap

1. CLI starts or discovers the daemon.
2. CLI generates a cryptographically random 256-bit one-time token.
3. Daemon stores only its hash, expiry and unused status.
4. CLI opens `http://127.0.0.1:<port>/#bootstrap=<token>`.
5. URL fragment is read by the bundled UI and never sent in the initial HTTP request.
6. UI posts the token to `/api/session/exchange` with an exact allowed Origin.
7. Daemon consumes it atomically and returns an opaque session cookie.
8. UI removes the fragment with `history.replaceState`.

Bootstrap tokens expire within one minute and cannot be replayed.

### Session and mutation protection

- session cookie is random, `HttpOnly`, `SameSite=Strict`, scoped to `/` and stored hashed server-side;
- because the first browser version uses HTTP loopback, security does not rely on a `Secure` cookie that some browser
  configurations may reject on numeric loopback;
- every non-idempotent request requires exact Origin, JSON content type and a session-bound CSRF header;
- CORS is disabled for arbitrary origins;
- WebSocket upgrade validates Origin and the same session;
- session logout/revocation is durable;
- daemon restart preserves valid sessions but never preserves unused plaintext bootstrap tokens.

### Browser content security

- strict Content Security Policy with no remote scripts;
- UI assets served from the daemon or an exact approved development origin;
- WorkItem/artifact Markdown is rendered without raw HTML;
- framing is denied;
- request/event payload sizes are bounded;
- auth/bootstrap/cookie/CSRF values are redacted before logging.

## Consequences

### Positive

- one-command browser opening remains simple;
- token does not enter normal request URLs or Git/config;
- hostile websites cannot use ambient localhost access as Loomrail authority;
- WebSocket and HTTP share one session model.

### Costs and risks

- development origin must be configured explicitly;
- cookie behavior needs Chrome, Edge and Safari tests;
- a fully compromised local user account remains outside this boundary;
- remote access later requires a separate threat model and cannot reuse this mode by toggling one bind flag.

## Required tests

- external Host/Origin rejected;
- missing/expired/replayed bootstrap token rejected;
- cookie alone cannot perform mutation without CSRF header;
- WebSocket rejects untrusted Origin and anonymous session;
- token/cookie absent from logs and browser-visible URL after exchange;
- logout and expiry prevent reconnect.
