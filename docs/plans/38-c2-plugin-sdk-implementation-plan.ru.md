# C2 Plugin SDK v1 — implementation plan

**Дата:** 2026-08-31
**Статус:** implemented locally; platform CI gate pending
**Спецификация:** [`37-c2-plugin-sdk-spec.ru.md`](37-c2-plugin-sdk-spec.ru.md)

## 1. Contract and authoring module

- [x] Add `packages/plugin-sdk` with a strict manifest schema and exported types.
- [x] Add inferred `defineReadonlyTool` and manifest derivation without duplicated tool declarations.
- [x] Add `serveReadonlyToolPlugin` with closed annotations, bounded results and redacted failure.
- [x] Keep the external interface small; MCP server objects stay an implementation detail.

## 2. Conformance and security

- [x] Cover valid/invalid manifests, canonical ordering and closed schemas.
- [x] Cover tool/manifest drift, invalid input, invalid output and thrown handler errors.
- [x] Run a synthetic plugin through the real C1 capability probe.
- [x] Record C2 threats and make clear that manifest permissions are claims, not an OS sandbox.

## 3. Distribution and documentation

- [x] Export the SDK as `loomrail/plugin-sdk` with declarations in the packed artifact.
- [x] Verify the subpath from a clean tarball install.
- [x] Add EN/RU author guides and a minimal fixture.
- [x] Update README/docs index without adding marketplace or installer claims.

## 4. Gate

- [x] Run format, non-landing lint, typecheck, unit/integration, browser regression and clean release checks.
- [x] Confirm `apps/landing` has no diff from this work.
- [ ] Close C2 only after macOS and Windows CI are green for the shared C1/C3/C2 release candidate.

## 5. Local evidence

- `@loomrail/plugin-sdk`: 11/11 tests, including the real C1 probe and redacted handler failure;
- repository packages: 801/801 tests;
- Playwright: 40/40 scenarios;
- clean `loomrail-0.1.0-alpha.2.tgz`: CLI, Context7, MCP proxy/supervisor and `loomrail/plugin-sdk` verified outside
  the monorepo;
- format, public tree, non-landing lint, strict typecheck and production audit green;
- `apps/landing` source diff empty. Its independent lint ownership remains with the dedicated landing session.
