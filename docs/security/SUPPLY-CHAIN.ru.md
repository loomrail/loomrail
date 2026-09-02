# Supply-chain policy Loomrail

> Public pre-alpha · [English](SUPPLY-CHAIN.md) · [Threat model](THREAT-MODEL.md)

Эта policy описывает repository dependencies, build inputs, integrity release candidate, publish authority и
post-publication verification. Она не утверждает, что dependency, build или provenance statement безопасны сами по
себе.

## Dependency intake

Repository использует public npm registry, committed `pnpm-lock.yaml`, exact pins Node/pnpm и full-commit references
для GitHub Actions. CI устанавливает через `pnpm install --frozen-lockfile`; dependency graph не меняется без
reviewed lockfile diff.

Committed pnpm policy применяет к direct и transitive packages:

- минимум 24 часа с момента публикации, strict refusal без eligible version или registry publication time;
- запрет downgrade publisher trust от trusted publishing к более слабому evidence;
- повторную проверку committed lockfile вместо автоматического объявления его trust root;
- запрет transitive Git/direct-tarball sources;
- запрет dependency lifecycle scripts без exact reviewed `allowBuilds` entry;
- только exact или caret semver registry ranges для runtime dependencies публикуемого `loomrail`.

`pnpm audit --prod --audit-level high` запускается на macOS и Windows. Release tarball отдельно устанавливается npm в
empty project; его consumer dependency graph проходит собственный production High-severity audit.

Эти меры снижают риск, но не доказывают безопасность старого, signed или свободного от известных уязвимостей package.

## Review обновлений

Dependabot еженедельно предлагает patch/minor npm updates. Major update — отдельное compatibility change. Каждое
dependency изменение требует:

1. review manifest/lockfile diff, новых maintainers/source/licenses/lifecycle scripts/native code,
   network/process/filesystem behavior и transitives;
2. production audit и tests всех затронутых boundaries;
3. crash/fault и clean-install gates при изменении runtime или packaging;
4. exact documented exception, если release-age или publisher-trust gate нужно обойти.

Активный High/Critical advisory может оправдать bypass 24-hour wait только для exact patched version. Зафиксируйте
advisory, почему ожидание опаснее, и удалите exception после maturation. Wildcard exception и отключение общей policy
запрещены.

### Текущее exact exception

| Selector       | Scope                                    | Причина                                                           | Условие удаления                           |
| -------------- | ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| `semver@6.3.1` | dev-only Babel/ESLint transitive, locked | публикация 2023 года старше сильного trust evidence другой версии | upstream Babel graph больше не выбирает v6 |

Exception не разрешает lifecycle script и не входит в published runtime graph. Production audit сейчас не сообщает
известной уязвимости для него.

## Integrity release candidate

`pnpm pack:release` создаёт два ignored файла в `dist-release/`:

- `loomrail-<version>.tgz` — candidate artifact;
- `loomrail-<version>.receipt.json` — closed unsigned integrity receipt.

Receipt связывает package identity, source commit и clean/dirty observation, версии Node/npm/pnpm, SHA-1/SHA-256/
SHA-512 tarball, а также SHA-256 и размер каждого allowlisted package file. Packaging отвергает unsafe paths,
symlinks, неожиданные file types, bundled dependency tree, inconsistent npm metadata и digest mismatch.

`pnpm test:release` проверяет receipt до install, устанавливает exact tarball, сравнивает каждый package-owned
extracted file, аудитит полученный npm production graph и затем выполняет launcher smoke. CI принимает только receipt
из clean source tree.

Receipt не подписан. Он обнаруживает случайную подмену и даёт trusted workflow exact subject для attestation, но сам
не является npm provenance и не идентифицирует builder.

## Publish authority и provenance

Обычный CI имеет read-only repository permission и никогда не вызывает `npm publish`. Пока stable-release,
cross-platform и private-dogfood gates открыты, publish не разрешён.

До будущего public release maintainer настраивает npm trusted publishing для exact public repository и отдельного
GitHub-hosted workflow. Publish job использует OIDC `id-token: write`, собирает и проверяет artifact в этом trusted
job и публикует exact tarball с provenance. Staged package задаёт `publishConfig.provenance: true`, поэтому
unsupported local/manual publish не может незаметно пропустить provenance. Long-lived npm write token не является
default credential.

npm provenance через Sigstore и transparency log связывает published bytes с source/build instructions. Он не
сертифицирует качество или безопасность кода. Local receipt, checksum в release note, Git tag или заявление
maintainer его не заменяют.

После публикации проверяйте exact version, а не moving dist-tag:

```bash
npm view loomrail@<exact-version> dist.integrity --json
npm install --ignore-scripts loomrail@<exact-version>
npm audit signatures
```

`npm audit signatures` проверяет registry signatures и доступные provenance attestations installed graph. Для local
pre-publication tarball registry attestation ещё не существует.

## Update, rollback и incident response

Loomrail не обновляется сам. Владелец выбирает exact target или явно следует pre-alpha channel `next`, останавливает
daemon, сохраняет whole data directory, устанавливает version, запускает `doctor` и Mock walkthrough. Database
rollback основан на restore: нужно установить version, соответствующую pre-upgrade whole-directory backup. Контракта
down-migration или silent dist-tag rollback нет.

При подозрении на compromise dependency/release:

1. остановите publish и не переиспользуйте candidate;
2. сравните registry integrity/provenance с trusted workflow и source commit;
3. определите affected exact versions и dependency paths;
4. подготовьте reviewed patch либо exact temporary override и повторите все release gates;
5. пометьте affected registry versions deprecated и согласуйте disclosure; unpublish допустим только по правилам npm
   и после оценки impact;
6. rotate/revoke потенциально раскрытый credential и сохраните incident evidence без user data.

Owner backup/update/rollback/uninstall описаны в [operations guide](../guides/OPERATIONS.ru.md), maintainer artifact
gates — в [release guide](../RELEASE.md).

## Primary references

- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm registry signature verification](https://docs.npmjs.com/verifying-registry-signatures/)
- [pnpm supply-chain security](https://pnpm.io/supply-chain-security)
- [pnpm dependency policy](https://pnpm.io/settings/dependency-resolution)
- [pnpm lifecycle-script policy](https://pnpm.io/settings/build)
