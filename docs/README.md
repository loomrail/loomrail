# Loomrail documentation

Use the shortest document that matches what you are trying to do.

## Install and use Loomrail

| Goal                                                     | English                                                    | Русский                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Guided setup for a local CLI provider                    | [Quick start](guides/GETTING-STARTED.md)                   | [Быстрый старт](guides/GETTING-STARTED.ru.md)                    |
| Try bundled repositories, task recipes, and roles        | [Samples](guides/SAMPLES.md)                               | [Примеры](guides/SAMPLES.ru.md)                                  |
| Repository, providers, recovery, backup, troubleshooting | [Owner guide](guides/USER-GUIDE.md)                        | [Руководство владельца](guides/USER-GUIDE.ru.md)                 |
| Configure and inspect deterministic browser QA           | [Browser QA](guides/BROWSER-QA.md)                         | [QA в браузере](guides/BROWSER-QA.ru.md)                         |
| Build a local read-only tool plugin                      | [Plugin SDK](guides/PLUGIN-SDK.md)                         | [Plugin SDK](guides/PLUGIN-SDK.ru.md)                            |
| Diagnose, back up, restore, and manage local logs        | [Operations](guides/OPERATIONS.md)                         | [Эксплуатация](guides/OPERATIONS.ru.md)                          |
| Configure supported local CLIs and models                | [Provider compatibility](guides/PROVIDER-COMPATIBILITY.md) | [Совместимость провайдеров](guides/PROVIDER-COMPATIBILITY.ru.md) |
| Verify dependencies, release integrity, and provenance   | [Supply chain](security/SUPPLY-CHAIN.md)                   | [Supply chain](security/SUPPLY-CHAIN.ru.md)                      |

Before a credentialed run, read the [security and trust boundaries](security/THREAT-MODEL.md). The former
full-delivery fixture is retained as an explicit [executor readiness note](examples/full-route/README.md); it is not
currently a runnable acceptance route.

## Understand or contribute to Loomrail

- [Public roadmap](../ROADMAP.md)
- [Structured issue chooser](https://github.com/loomrail/loomrail/issues/new/choose)
- [Architecture overview](architecture/OVERVIEW.md)
- [Product decisions](product/PRODUCT-DECISIONS.ru.md)
- [Master plan](product/MASTER-PLAN.ru.md)
- [Domain vocabulary](domain/CONTEXT.md)
- [Architecture decisions](adr/README.md)
- [Component system](design/COMPONENT-SYSTEM.md)
- [Localization contract](design/LOCALIZATION.md)
- [Release procedure](RELEASE.md)
- [Supply-chain policy](security/SUPPLY-CHAIN.md) · [Supply-chain policy (RU)](security/SUPPLY-CHAIN.ru.md)
- [Current Stable notes](releases/0.1.1.md)
- [Public Beta history](releases/0.1.0-beta.1.md)

Files under [`plans/`](plans/) are versioned implementation records. They explain why a slice was built and how it
was verified, but they are not an installation guide or public roadmap.
