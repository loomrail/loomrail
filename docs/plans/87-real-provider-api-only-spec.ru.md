# Q19 — Real-provider-only API execution: спецификация

**Статус:** approved; core adapter slice implemented; workspace execution pending

## Цель

Удалить Mock из активного продукта и направлять новые сессии только в OpenAI Responses API или Anthropic Messages
API. Не выдавать test doubles, recorded fixtures или provider prose за реальную работу.

## Acceptance

- [x] active Project preference, AUTO registry, CLI setup, Workbench и landing содержат только два реальных API;
- [x] без API key, при unknown override и при недостаточном token remainder dispatch fail closed;
- [x] OpenAI request содержит `max_output_tokens`, Anthropic request — `max_tokens` до отправки;
- [x] provider response, stage result и actual usage проходят runtime validation;
- [x] production package `provider-mock` удалён; doubles находятся только в test tree;
- [x] новые старты записываются как `START_PIPELINE`, historical discriminant остаётся readable;
- [ ] IMPLEMENT и QA выполняют реальную работу через отдельно принятый secure workspace tool executor;
- [ ] credentialed macOS/Windows evidence подтверждает оба API без secrets и с provider-side stop;
- [ ] stable release gates привязаны к fixed commit и зелёной cross-platform verification.

## Не входит в completed slice

Произвольное выполнение shell из model output, permission bypass, хранение ключей, automatic commit/push/merge/deploy,
подмена live evidence transport double и переписывание append-only истории.
