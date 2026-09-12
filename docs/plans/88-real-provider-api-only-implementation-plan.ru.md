# Q19 — Real-provider-only API execution: implementation plan

**Статус:** superseded by PD-019 / ADR-0015 and plans 89–98; incomplete API-route items are intentionally cancelled

1. Ввести общий bounded JSON transport и strict provider protocol errors. **Done.**
2. Реализовать OpenAI Responses и Anthropic Messages adapters с native output cap, usage validation, abort и strict
   stage schemas. **Done для DISCOVERY/PLAN/REVIEW/ACCEPTANCE.**
3. Удалить Mock из registry/preferences/UI/CLI/landing/release manifest; перевести active rows `MOCK -> AUTO` новой
   migration; оставить historical audit readable. **Done.**
4. Перенести deterministic workflow behavior в test-only double с real provider identity. **Done.**
5. Добавить neutral `START_PIPELINE`, сохранив old command parser только для replay. **Done.**
6. Спроектировать и реализовать local workspace tool executor: rooted filesystem handles, no secret paths, bounded
   output/time/process tree, READ_ONLY/READ_WRITE enforcement, network policy, cancellation and Windows parity.
   **Pending; отдельный security review обязателен.**
7. После executor включить IMPLEMENT/QA обоим adapters и проверить реальные file diff, tests, Review/QA evidence и
   recovery. **Pending.**
8. Выполнить credentialed macOS/Windows dogfood и обновить stable gates. **Pending; credentials не предоставлены.**
