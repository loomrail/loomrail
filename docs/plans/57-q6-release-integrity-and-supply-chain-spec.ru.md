# Q6 — Release integrity и supply-chain policy

**Дата:** 2026-09-02

**Статус:** implemented; clean macOS/Windows receipt evidence green in run 33668749126

**Предшественники:** Q4, Q5

**Нормативные решения:** T12, local-first release, human final publish, no hidden update, no down-migration claim

## 1. Outcome

Release candidate становится проверяемым артефактом, а dependency/update/publish boundary — явной политикой. Одна
packaging command должна fail closed на неожиданном npm output, package identity, пути или типы файлов, записать
machine-readable receipt с digest tarball и каждого опубликованного файла, а clean-install gate — проверить receipt
до запуска и сверить его с реально распакованным package.

Supply-chain настройки repository обязаны проверять committed lockfile, release age, trust downgrade, exotic
transitive sources и unreviewed dependency lifecycle scripts. Публичная документация различает локальный integrity
receipt и registry provenance: только npm trusted publishing из поддерживаемого hosted CI может создать
consumer-verifiable Sigstore attestation.

## 2. Термины и authority

**Release Candidate Artifact** — exact `.tgz` bytes, подготовленные одной clean build из versioned source tree.

**Release Integrity Receipt** — unsigned closed JSON рядом с tarball. Он связывает package name/version, source
commit и clean/dirty observation, build toolchain, tarball SHA-1/SHA-256/SHA-512 и sorted allowlisted file hashes.
Receipt обнаруживает substitution/tampering в локальном или CI handoff, но сам не доказывает identity builder.

**Registry Provenance** — npm/Sigstore attestation, созданная registry/trusted publisher через OIDC и публично
связывающая опубликованный artifact с repository, workflow и commit. Она не доказывает отсутствие malicious code и
не заменяется локальным receipt, Git tag, checksum в release note или maintainer statement.

Versioned source и release scripts остаются authority над составом candidate. npm `pack --json` — измерение реально
упакованных bytes/files, а не источник product scope.

## 3. Integrity receipt contract

`pnpm pack:release` после сборки:

1. создаёт staging tree только из существующего closed package manifest;
2. до pack рекурсивно принимает только regular files с portable relative paths;
3. разрешает root metadata и закрытые asset roots с ожидаемыми расширениями; symlink, traversal, absolute path,
   control character, database, log, key или неожиданный file type отвергаются;
4. запускает `npm pack --json` через fixed argv и принимает ровно одну запись exact `loomrail@version`;
5. требует exact filename, counts/sizes, SHA-1 и SHA-512 metadata и сверяет file list с staging;
6. вычисляет digest фактического tarball и каждого staging file стандартной библиотекой;
7. пишет `dist-release/loomrail-<version>.receipt.json` атомарным complete write после успешной проверки.

Receipt schema `loomrail.release-integrity.v1` содержит только:

- exact name/version;
- source repository, 40-hex commit и `CLEAN | DIRTY` observation;
- Node/npm/pnpm versions;
- tarball filename, byte size, SHA-1, SHA-256 и SRI SHA-512;
- unpacked size и sorted `{ path, size, sha256 }` для каждого package file.

В нём нет timestamp, runner/username, cwd, абсолютного path, environment, token, registry credential или Git remote
credential. Dirty receipt разрешён для локального pre-commit теста, но CI release gate принимает только `CLEAN`.

## 4. Verification contract

`pnpm test:release` до install:

- строго парсит receipt и отвергает unknown/missing fields, duplicate/unsafe/unsorted files и неверные bounds;
- повторно вычисляет tarball digests/size и exact package identity;
- в CI требует clean source observation;
- только после этого устанавливает exact tarball в empty temporary project;
- рекурсивно сравнивает byte size и SHA-256 всех package-owned installed files с receipt, исключая installed
  dependency tree;
- затем сохраняет существующий runtime/doctor/data-path/Plugin SDK/MCP entrypoint smoke.

Unit tests обязаны мутировать receipt, tarball и installed file и получать typed bounded refusal до успешного пути.

## 5. Dependency policy

- Node и pnpm pin остаются committed; CI использует `pnpm install --frozen-lockfile`.
- Explicit `minimumReleaseAge` работает strict и fail closed при missing registry publication time.
- `trustPolicy: no-downgrade` запрещает незаметное ухудшение publisher trust; исключение допускается только exact
  reviewed selector с причиной в policy/evidence.
- Committed lockfile не объявляется автоматически trusted; pnpm повторно применяет supply-chain checks.
- Exotic transitive Git/tarball dependencies запрещены.
- Dependency lifecycle scripts denied by default; новый script требует exact reviewed `allowBuilds` entry.
- Production dependency audit с уровнем High остаётся отдельным macOS/Windows gate до полного verify.
- Weekly Dependabot предлагает patch/minor updates; major update остаётся отдельным совместимостным срезом.
- Security override должен быть exact, временным, сопровождаться advisory/evidence и удаляться после upstream
  convergence; 24-hour release-age wait можно обойти только exact affected version, когда ожидание оставляет активную
  High/Critical уязвимость.
- GitHub Actions references остаются pinned full commit SHA; dependency PR не объединяется без relevant unit,
  fault, clean-install и audit evidence.

## 6. Publish and update boundary

До первой разрешённой публикации maintainer настраивает npm trusted publisher на exact public repository/workflow,
GitHub-hosted runner и OIDC `id-token: write`; long-lived write token не является default. Publish job собирает и
проверяет candidate в том же job, публикует exact tarball с provenance и никогда не скачивает для publish
неаттестованный artifact из произвольного предыдущего run.

Ни Q6, ни обычный CI не вызывают `npm publish`, не создают tag/release и не меняют dist-tag. Публикация остаётся
отдельным human-authorized terminal action после зелёных macOS/Windows gates и private dogfood.

После публикации maintainer сверяет registry `dist.integrity`, source commit/workflow provenance и
`npm audit signatures`. Owner update остаётся explicit exact-version install с Q4 backup/doctor/mock walkthrough;
rollback требует restore matching pre-upgrade data, а не down-migration или dist-tag mutation.

## 7. Acceptance criteria

1. `npm pack --json` parsing и package file boundary fail closed.
2. Receipt связывает actual tarball SHA-1/SHA-256/SHA-512, source observation, toolchain и каждый installed file.
3. Tarball, receipt или installed-file mutation детерминированно падают.
4. Receipt не содержит absolute/local metadata и явно не называется registry provenance.
5. CI release lane требует clean source и запускает integrity verification на macOS/Windows.
6. pnpm supply-chain settings запрещают trust downgrade, missing publication time, exotic transitives и unreviewed
   install scripts; frozen install остаётся зелёным.
7. EN/RU security/release/operations docs описывают dependency review, trusted publishing, post-publish verification,
   explicit update и restore-based rollback.
8. Existing full typecheck/unit, audit, crash/fault and clean-install gates остаются зелёными вне protected landing.

## 8. Non-goals

- npm publish, tag, GitHub Release или dist-tag mutation;
- claim о reproducible byte-identical build между ОС;
- самоподписанный receipt или собственная PKI;
- SBOM attestation без проверенного generator для двух-document pnpm lockfile;
- automatic/self update, silent background download или down-migration;
- исправление или изменение `apps/landing/**`.

## 9. Primary references

- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm registry signature verification](https://docs.npmjs.com/verifying-registry-signatures/)
- [pnpm supply-chain security](https://pnpm.io/supply-chain-security)
- [pnpm dependency resolution settings](https://pnpm.io/settings/dependency-resolution)
- [pnpm build-script policy](https://pnpm.io/settings/build)
