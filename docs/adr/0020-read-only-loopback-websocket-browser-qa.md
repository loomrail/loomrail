# ADR-0020 — Read-only loopback WebSocket support in deterministic Browser QA

**Status:** Accepted

## Context

The deterministic Playwright driver intercepts every HTTP request, fetches the response through the driver, applies
size and credential checks, and only then fulfills the browser request. Chromium's Local Network Access protection
can classify a page fulfilled through that interception differently from a direct loopback navigation. A local
development runtime that needs a same-origin WebSocket before hydration (for example a Next.js development server)
then remains server-rendered: visible controls have no client handlers and a later locator action times out even
though the target is healthy.

Treating that timeout as a product defect is false evidence. Disabling Chromium's local-network check without an
independent network boundary would be worse: an untrusted page could open arbitrary WebSockets to local services,
and a bidirectional same-origin socket could perform mutations outside the Browser QA `BROWSER_READ` capability.

## Decision

The Playwright driver owns one narrow WebSocket seam in addition to its existing HTTP interception:

- the browser-local Local Network Access check is disabled only for the isolated Browser QA Chromium process;
- before target navigation, the BrowserContext intercepts every WebSocket URL;
- a malformed or non-exact target origin is closed with policy code `1008`, records `FORBIDDEN_ORIGIN`, and makes the
  run non-finalizable;
- an exact same-origin loopback socket may complete its handshake, but every page-to-server frame is discarded;
- frames in both directions share fixed per-context socket, message, per-message, and total-byte limits;
  server-to-page frames within those limits are forwarded, while page-to-server frames are still discarded;
  exceeding a limit records `INVALID_EVIDENCE`, closes the socket, and makes the run non-finalizable;
- navigation waits for the bounded page `load` state, then gives already-loaded framework work a 250 ms interaction
  settle window inside the same action deadline. It never waits indefinitely for application polling to become idle;
- protocols and raw frames are never persisted or included in provider context, evidence, logs, or UI.

The domain contract remains unchanged. Browser QA still has read-only browser authority, the exact loopback target
remains the only network origin, and only a complete measured matrix on the exact reviewed tree can pass QA.

## Consequences

- local development targets can hydrate reproducibly without asking owners to publish a production build merely for
  Browser QA;
- the page cannot use the compatibility seam as a bidirectional command channel;
- off-origin sockets and unbounded server streams fail closed with typed Browser QA outcomes;
- the compatibility flag is safe only while both HTTP and WebSocket interception stay installed before navigation.
  Removing either interceptor requires a superseding ADR and a new threat-model review.
