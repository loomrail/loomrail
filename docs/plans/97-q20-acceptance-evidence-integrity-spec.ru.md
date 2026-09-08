# Q20.4 — Целостность evidence в Acceptance: спецификация

**Статус:** approved

**Основание:** PD-020, ADR-0017, Q1, Q3, Q17, Threat Model T63

## Outcome

Новый AcceptancePackage не может представить provider-authored пересказ как факт measured Browser QA или Project
verification. Владелец видит ровно тот bounded evaluator vocabulary, который Loomrail вывел из durable QARun,
QAEvidenceBundle и VerificationRun на одном implementation tree.

## Архитектурная граница

Один глубокий domain module принимает WorkItem, provider criterion claims, current Review artifact, measured QARun
и QAEvidenceBundle, а также optional current Project verification evidence. На выходе он возвращает либо полностью
связанные criterion rows и domain-owned package narrative, либо typed invalid result.

Provider сохраняет только две роли:

- объяснить реализацию criterion;
- выбрать exact check из закрытого списка, переданного adapter schema.

Provider не владеет artifact/run/tree/status, measured QA check vocabulary, итоговым verification status,
authoritative release note, owner verification instructions или known-risk status.

## Контракт measured QA projection

- источник — exact QARun plan плюс matching PASSED QAEvidenceBundle;
- один check на scenario, максимум 20;
- check содержит portable scenario ID, bounded title, число прошедших target executions и assertions;
- отсутствующая/повторная cell, failed assertion, чужой run/tree/stage или несовпадающий plan блокируют projection;
- порядок совпадает с locked plan и не зависит от locale/platform sort;
- raw console/network/provider output, paths, cookies, tokens и attachment storage keys не входят в check.

## Контракт Acceptance narrative

- top-level release note сообщает только domain-known Review/QA/Project-verification facts;
- per-criterion owner verification перечисляет выбранные exact Review/QA checks и число required Project checks;
- known risk выводится только из typed optional Project verification failures; при их отсутствии — `null`;
- provider advisory `releaseNote`, `verifyInstructions`, `ownerVerification` и `knownRisk` не становятся authority;
- implementation explanation остаётся provider-authored data и экранируется как раньше.

## Context

QA и Acceptance получают bounded measured plan/scenario/assertion identities и actual execution status. Acceptance
дополнительно получает current Project verification run, plan revision, tree и ordered check statuses. Данные
помечены как evidence, не как инструкции; repository-authored titles остаются untrusted text.

## Non-goals

- semantic inference, что произвольный scenario действительно доказывает criterion;
- автоматическая final acceptance;
- изменение Browser QA plan adoption/lifecycle;
- переписывание historical artifacts/packages;
- provider API, ключи или direct HTTP fallback.

## Acceptance

1. Invented provider QA check отсутствует в новом EvidenceArtifact и не может быть выбран Acceptance schema.
2. Contradictory provider prose не меняет domain-owned passing verification narrative или risk.
3. Acceptance context показывает actual Browser QA scenarios/assertions и Project verification result.
4. Stale/foreign/incomplete measured inputs отклоняются typed error до state change.
5. Existing Q3 release export остаётся совместимым и показывает authoritative fields.
6. Focused tests, integration/E2E и полный `pnpm verify` проходят.
