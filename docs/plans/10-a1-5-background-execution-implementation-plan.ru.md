# A1.5 — Фоновое исполнение и канал событий: план реализации

> **Для исполнителей-агентов:** ОБЯЗАТЕЛЬНАЯ ПОД-СКИЛЛ: `superpowers:subagent-driven-development`
> (рекомендуется) или `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).

**Цель:** увести цикл сессий из старта демона и четырёх обработчиков запросов в фоновый исполнитель и
построить канал доставки событий, без которого фоновая работа была бы невидима владельцу.

**Архитектура:** один фоновый исполнитель ведёт очередь и является единственным вызывающим
`runStageAttempt`; обёртка вокруг `execute` публикует по сигналу на каждое зафиксированное событие; сигнал
едет к браузеру по SSE и служит поводом инвалидировать кэш React Query, а не данными. Потеря сигнала
безвредна: при подключении и переподключении клиент инвалидирует всё.

**Технологии:** TypeScript strict, Fastify 5, `node:sqlite` через `@loomrail/persistence-sqlite`, Zod 4,
React 19 + TanStack Query 5, встроенный в браузер `EventSource`, Vitest, Playwright.

**Спек:** [`docs/plans/09-background-execution-and-event-stream-spec.ru.md`](09-background-execution-and-event-stream-spec.ru.md) — читается вместе с планом.

## Глобальные ограничения

Требования проекта, действующие в каждой задаче. Значения скопированы дословно из `AGENTS.md`, `CLAUDE.md` и
спека.

- **Не коммитить и не пушить без явной просьбы человека.** Шаги «Commit» в задачах исполняются только если
  человек дал разрешение на эту сессию; иначе работа остаётся в рабочем дереве.
- **Окружение каждой сессии:** `nvm use` (`.nvmrc` = 24.19.0), затем `corepack enable`. Системный node 22.x
  не подходит; `scripts/check-toolchain.mjs` падает при расхождении.
- **Shell — zsh.** Незакавыченная переменная не разбивается на слова: `git diff -- $PATHS` молча даёт пустой
  результат. Пути в git-командах писать инлайном, никогда через переменную.
- **В репозитории работает параллельная сессия.** Перед каждым коммитом сверять `git status` и добавлять
  файлы поимённо. Никогда `git add .`, `git add -A`, `git add apps`.
- **Никаких новых зависимостей.** Ни одна задача этого плана не добавляет пакет: SSE и `EventSource`
  покрываются стандартной библиотекой и браузером. Это несущее основание решения D4 спека — задача, которой
  понадобилась зависимость, ошиблась в реализации, а не нашла пробел в плане.
- **TypeScript strict, никаких `any`** в продуктовом коде и в публичных тестах. Именованные экспорты.
  `type` для форм данных. Никаких non-null assertions.
- **Форматирование принадлежит committed Prettier config:** двойные кавычки, точки с запятой, висячие
  запятые. `printWidth` — 110.
- **Валидация входа обязательна** на границах HTTP, канала, конфигурации и провайдера — во время исполнения,
  схемой, а не приведением типа.
- **Никаких `console.log` в продуктовых путях** — только структурный логгер с редактированием полей.
- **Не импортировать из `apps/*` в `packages/*`.**
- **Каждый тест сдаётся с доказательством мутацией:** сломать реализацию, убедиться, что тест краснеет,
  восстановить. Отчёт задачи обязан содержать вставленную мутацию и текст падения. Тест, который не может
  упасть при поломке, которую называет, считается не сделанной работой — за прошлую сессию таких приехало
  восемь.
- **После изменений:** `pnpm verify`, затем `pnpm test:e2e`, затем `git diff --check`.
- **При нагрузке машины** (`uptime` показывает load average выше ~20) браузерные тесты запускать как
  `pnpm exec playwright test --workers=1 --timeout=120000`. Флаги через `pnpm test:e2e --` не пробрасываются.
- **Миграции этот план не добавляет.** Задача, которой понадобилась миграция, ошиблась: ни одна вводимая
  величина не является долговечной.

## Порядок работ и почему он такой

Спек оставил этот вопрос открытым (§12, вопрос 2). План решает: **сначала канал, потом исполнитель.**

Обратный порядок создаёт окно, в котором продукт видимо регрессирует: цикл уже в фоне, канала ещё нет, доска
показывает состояние до работы, пока владелец не перезагрузит страницу. Выбранный порядок такого окна не
создаёт вовсе. Пока drain остаётся синхронным, канал строится и проверяется самостоятельно — сигналы просто
доезжают до клиента для работы, которая и так успела завершиться до ответа. Ни один браузерный тест не меняет
поведения до задачи 8, и каждая половина проверяема отдельно.

## Карта файлов

**Создаются:**

| Файл                                                  | Ответственность                                               |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `packages/contracts/src/event-stream.ts`              | схема кадра `EventSignal` — единственный контракт канала      |
| `packages/contracts/test/event-stream.unit.test.ts`         | негативные тесты схемы                                        |
| `apps/daemon/src/event-stream.ts`                     | реестр открытых потоков, запись кадра, закрытие, heartbeat    |
| `apps/daemon/src/session-worker.ts`                   | цикл очереди, признак простоя, остановка                      |
| `apps/daemon/test/event-stream.integration.test.ts`   | маршрут, аутентификация, доставка, закрытие, истечение сессии |
| `apps/daemon/test/session-worker.integration.test.ts` | цикл, сведение `wake`, простой, защита неподвинутой головы    |
| `apps/web/src/eventStream.ts`                         | чистые функции: область сигнала → ключи, сведение окна        |
| `apps/web/src/eventStream.test.ts`                    | тесты этих функций                                            |
| `apps/web/src/useEventStream.ts`                      | подключение `EventSource`, состояние канала                   |

**Изменяются:**

| Файл                                                                                                                                                                                                          | Изменение                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`                                                                                                                                                                             | экспорт нового модуля                                                                                                        |
| `apps/daemon/src/server.ts`                                                                                                                                                                                   | маршрут потока, обёртка `execute`, `wake()` вместо `await drain`, закрытие потоков в `preClose`, `worker.stop()` в `close()` |
| `apps/daemon/test/session.integration.test.ts`                                                                                                                                                                | тест R30 переезжает на `whenIdle()`                                                                                          |
| `apps/web/src/App.tsx`                                                                                                                                                                                        | монтирование хука канала                                                                                                     |
| `apps/web/src/workspace.tsx`                                                                                                                                                                                  | признак мёртвого канала в контекст рабочей области                                                                           |
| `e2e/walking-skeleton.spec.ts`                                                                                                                                                                                | просмотр всех 26 тестов, новый тест доставки без участия владельца                                                           |
| `docs/adr/0002-sqlite-state-and-audit.md`, `docs/adr/0003-loopback-session-security.md`, `docs/design/COMPONENT-SYSTEM.md`, `docs/security/THREAT-MODEL.md`, `docs/plans/06-post-phase-0-decomposition.ru.md` | дельты §10 спека                                                                                                             |

## Именованные константы

Спек §12 вопрос 1. Все живут в одном месте — вверху `apps/daemon/src/event-stream.ts`, кроме окна сведения,
которое принадлежит клиенту и живёт вверху `apps/web/src/eventStream.ts`.

```ts
const HEARTBEAT_INTERVAL_MS = 15_000; // кадр-комментарий: держит соединение и ловит полуоткрытый сокет
const MAX_OPEN_STREAMS = 8; // локальный однопользовательский демон; браузер и сам держит ~6
const SIGNAL_PAGE_LIMIT = 500; // потолок LIST_EVENTS; читаем страницами до исчерпания
const COALESCE_WINDOW_MS = 50; // клиент: окно сведения сигналов перед одной инвалидацией
const DISPATCH_CYCLE_LIMIT = 20; // существующий предел циклов, переезжает в исполнитель без изменения
```

---

### Задача 1: контракт кадра `EventSignal`

**Файлы:**

- Создать: `packages/contracts/src/event-stream.ts`
- Создать: `packages/contracts/test/event-stream.unit.test.ts`
- Изменить: `packages/contracts/src/index.ts`

**Интерфейсы:**

- Потребляет: `opaqueIdSchema` из `./shared.js`
- Производит: `eventSignalSchema`, тип `EventSignal` — используются задачами 2, 4, 5, 6

**Почему поля именно такие.** Спек §5.2: кадр несёт три непрозрачных идентификатора и ничего больше. Ни
`type` (клиент не разветвляется по типу, значит новый тип события не требует правки клиента), ни `data`
(содержания в канале нет по построению, а не по осторожности), ни `sequence` (воспроизведения нет, и поле,
намекающее на него, ввело бы в заблуждение). `.strict()` здесь несущий: без него будущее поле проехало бы
невалидированным.

- [ ] **Шаг 1: написать падающий тест**

```ts
// packages/contracts/test/event-stream.unit.test.ts
import { describe, expect, it } from "vitest";

import { eventSignalSchema } from "../src/event-stream.js";

const validSignal = {
  projectId: "01JB0000000000000000000000",
  aggregateType: "WORK_ITEM",
  aggregateId: "01JB0000000000000000000001",
} as const;

describe("eventSignalSchema", () => {
  it("accepts a signal carrying exactly the three identifiers", () => {
    expect(eventSignalSchema.parse(validSignal)).toEqual(validSignal);
  });

  // Each negative case mutates exactly one field of the proven-valid fixture, so a failure
  // identifies the rule that broke rather than "something in this object is wrong".
  it("rejects an unknown aggregate type", () => {
    expect(() => eventSignalSchema.parse({ ...validSignal, aggregateType: "STAGE_ATTEMPT" })).toThrow();
  });

  it("rejects a missing project", () => {
    const { projectId: _omitted, ...withoutProject } = validSignal;
    expect(() => eventSignalSchema.parse(withoutProject)).toThrow();
  });

  // The load-bearing one: spec §5.2 says the frame carries no content. Without .strict() a field
  // added later would ride along unvalidated, and the "no content in the channel" claim would
  // quietly stop being true while every other test stayed green.
  it("rejects any field beyond the three, so content cannot be added by accident", () => {
    expect(() => eventSignalSchema.parse({ ...validSignal, title: "Ship the billing page" })).toThrow();
  });
});
```

- [ ] **Шаг 2: запустить и убедиться, что падает**

Команда: `pnpm --filter @loomrail/contracts test -- event-stream`
Ожидается: FAIL — модуль `./event-stream.js` не существует.

- [ ] **Шаг 3: минимальная реализация**

```ts
// packages/contracts/src/event-stream.ts
import { z } from "zod";

import { opaqueIdSchema } from "./shared.js";

/**
 * One frame of the event channel.
 *
 * Spec §5.2: three opaque identifiers, nothing else. The client learns *that* something changed at
 * a scope, never *what* changed -- so the channel carries no WorkItem text and no provider output,
 * and therefore cannot widen the untrusted-checkpoint threat A1 §8 records. `.strict()` is what
 * keeps that true over time: a field added later fails to parse instead of riding along.
 */
export const eventSignalSchema = z
  .object({
    projectId: opaqueIdSchema,
    aggregateType: z.enum(["PROJECT", "WORK_ITEM"]),
    aggregateId: opaqueIdSchema,
  })
  .strict();

export type EventSignal = z.infer<typeof eventSignalSchema>;
```

```ts
// packages/contracts/src/index.ts -- добавить строку, сохранив алфавитный порядок
export * from "./event-stream.js";
```

- [ ] **Шаг 4: запустить и убедиться, что проходит**

Команда: `pnpm --filter @loomrail/contracts test -- event-stream`
Ожидается: PASS, четыре теста.

- [ ] **Шаг 5: доказательство мутацией**

Убрать `.strict()` из схемы, запустить снова. Ожидается: падает ровно тест «rejects any field beyond the
three». Вернуть `.strict()`, убедиться, что снова зелено. Текст падения вставить в отчёт задачи.

- [ ] **Шаг 6: Commit** (только при наличии разрешения — см. глобальные ограничения)

```bash
git add packages/contracts/src/event-stream.ts packages/contracts/test/event-stream.unit.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add the event-channel signal frame"
```

---

### Задача 2: реестр потоков, маршрут SSE, закрытие демона

**Файлы:**

- Создать: `apps/daemon/src/event-stream.ts`
- Создать: `apps/daemon/test/event-stream.integration.test.ts`
- Изменить: `apps/daemon/src/server.ts` (маршрут; хук `preClose`)

**Интерфейсы:**

- Потребляет: `EventSignal` (задача 1); `requireSession`, `sessionForRequest`, `allowedOrigin`,
  `createError`, `requestCorrelationId` — уже существуют в `server.ts`
- Производит:
  ```ts
  createEventStreamRegistry(options: { logger: FastifyBaseLogger }): EventStreamRegistry
  type EventStreamRegistry = {
    open: (subscriber: EventStreamSubscriber) => (() => void) | null;  // null — предел достигнут
    publish: (signal: EventSignal) => void;
    tick: () => void;          // один такт heartbeat; задача 3 наполняет его смыслом
    closeAll: () => void;
    openCount: () => number;
  };
  type EventStreamSubscriber = { response: ServerResponse; isAuthorized: () => boolean };
  ```
  `publish` потребляется задачей 4, `closeAll` — хуком `preClose`, `tick` — задачей 3.

**Порядок проверок в маршруте несущий.** Предел соединений проверяется **до** `reply.hijack()`: после
перехвата ответа код 503 отправить уже нечем. Первым кадром пишется комментарий `: open`, чтобы заголовки
ушли сразу и у клиента сработало событие `open`, а не через неопределённое время.

**Почему закрытие потоков в `preClose` — не аккуратность.** Открытое SSE-соединение является долгоживущим
ответом без периода простоя, то есть ровно тем случаем, из-за которого `app.close()` не разрешается никогда.
Этот файл уже решает ту же задачу для спекулятивных keep-alive сокетов (`server.ts:158`), и решает потому,
что без этого `loomrail` зависал на Ctrl+C. Без `closeAll()` поломка вернётся с другой стороны.

- [ ] **Шаг 1: написать падающие тесты**

```ts
// apps/daemon/test/event-stream.integration.test.ts
// Читает тело SSE-ответа до первого кадра данных. Ограничение по числу кадров, а не по времени:
// «не пришло» здесь всегда означает «поток закрылся или молчит», и таймер это не различает.
const readFirstSignal = async (body: ReadableStream<Uint8Array>): Promise<unknown> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (let chunk = 0; chunk < 32; chunk += 1) {
    const { done, value } = await reader.read();
    if (done) throw new Error("The stream ended before a data frame arrived");
    buffered += decoder.decode(value, { stream: true });
    for (const frame of buffered.split("\n\n")) {
      const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (line) return JSON.parse(line.slice("data: ".length));
    }
  }
  throw new Error("No data frame arrived within the frame budget");
};

it("refuses a stream to a caller without a session", async () => {
  const response = await fetch(`${daemon.baseUrl}/api/v1/stream`);
  expect(response.status).toBe(401);
  await response.body?.cancel();
});

it("refuses a stream when an Origin is sent and does not match", async () => {
  const session = await authenticate(daemon, token);
  const response = await fetch(`${daemon.baseUrl}/api/v1/stream`, {
    headers: { cookie: session.cookie, origin: "http://evil.example" },
  });
  expect(response.status).toBe(403);
  await response.body?.cancel();
});

it("opens a stream for a session and delivers a signal for a committed event", async () => {
  const session = await authenticate(daemon, token);
  const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  if (!stream.body) throw new Error("The stream carried no body");

  const signalArrived = readFirstSignal(stream.body);
  const created = await createWorkItem(daemon, session, { title: "Ship the billing page" });
  await expect(signalArrived).resolves.toEqual({
    projectId: created.projectId,
    aggregateType: "WORK_ITEM",
    aggregateId: created.id,
  });
  await stream.body.cancel();
});

// Spec §7, last row: the frame carries opaque identifiers and no content. Asserted on the bytes,
// because "we did not add a text field" is a claim about intent and this is a claim about the wire.
it("carries no work item text on the wire", async () => {
  const session = await authenticate(daemon, token);
  const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });
  if (!stream.body) throw new Error("The stream carried no body");
  const frames = readRawFrames(stream.body, 1);
  await createWorkItem(daemon, session, { title: "Ship the billing page" });
  expect(await frames).not.toContain("Ship the billing page");
  await stream.body.cancel();
});

// Without closeAll() in preClose this never resolves: the held response has no idle period, so the
// server waits for a request that will never arrive. Any finite budget discriminates, because the
// failure is an unbounded wait rather than a slow one.
it("closes while a stream is still open", async () => {
  const session = await authenticate(daemon, token);
  const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });
  expect(stream.status).toBe(200);
  const closed = daemon.close().then(() => "closed" as const);
  const timedOut = new Promise<"hung">((resolve) =>
    setTimeout(() => {
      resolve("hung");
    }, 5_000),
  );
  await expect(Promise.race([closed, timedOut])).resolves.toBe("closed");
  await stream.body?.cancel();
});
```

- [ ] **Шаг 2: запустить и убедиться, что падают**

Команда: `pnpm --filter @loomrail/daemon test -- event-stream`
Ожидается: FAIL — маршрут `/api/v1/stream` отсутствует, все запросы дают 404.

- [ ] **Шаг 3: реализовать реестр**

```ts
// apps/daemon/src/event-stream.ts
import type { ServerResponse } from "node:http";

import type { EventSignal } from "@loomrail/contracts";
import type { FastifyBaseLogger } from "fastify";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const MAX_OPEN_STREAMS = 8;

export type EventStreamSubscriber = {
  response: ServerResponse;
  // Re-read on every heartbeat rather than captured once: a held stream must not outlive the
  // session that opened it, or the channel becomes a way to hold authenticated access forever.
  isAuthorized: () => boolean;
};

export type EventStreamRegistry = {
  open: (subscriber: EventStreamSubscriber) => (() => void) | null;
  publish: (signal: EventSignal) => void;
  tick: () => void;
  closeAll: () => void;
  openCount: () => number;
};

export const createEventStreamRegistry = (options: { logger: FastifyBaseLogger }): EventStreamRegistry => {
  const subscribers = new Set<EventStreamSubscriber>();

  const drop = (subscriber: EventStreamSubscriber): void => {
    subscribers.delete(subscriber);
    subscriber.response.end();
  };

  const write = (subscriber: EventStreamSubscriber, frame: string): void => {
    try {
      subscriber.response.write(frame);
    } catch (error: unknown) {
      // A dead socket is the ordinary end of a stream, not a daemon fault: drop it and carry on
      // rather than letting one closed browser tab throw into the caller of `execute`.
      options.logger.debug(
        { error: error instanceof Error ? error.name : "unknown" },
        "An event stream could not be written to and was dropped",
      );
      drop(subscriber);
    }
  };

  return {
    open: (subscriber) => {
      if (subscribers.size >= MAX_OPEN_STREAMS) return null;
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    publish: (signal) => {
      const frame = `data: ${JSON.stringify(signal)}\n\n`;
      for (const subscriber of [...subscribers]) write(subscriber, frame);
    },
    tick: () => {
      for (const subscriber of [...subscribers]) {
        if (!subscriber.isAuthorized()) {
          drop(subscriber);
          continue;
        }
        write(subscriber, ": ping\n\n");
      }
    },
    closeAll: () => {
      for (const subscriber of [...subscribers]) drop(subscriber);
      subscribers.clear();
    },
    openCount: () => subscribers.size,
  };
};
```

- [ ] **Шаг 4: подключить маршрут в `server.ts`**

Рядом с созданием `localState`:

```ts
const eventStreams = createEventStreamRegistry({ logger: app.log });
```

В существующий хук `preClose` (`server.ts:166`), первой строкой тела:

```ts
app.addHook("preClose", (done) => {
  eventStreams.closeAll();
  for (const socket of unusedConnections) socket.destroy();
  unusedConnections.clear();
  done();
});
```

Маршрут — рядом с остальными `/api/v1` GET:

```ts
app.get("/api/v1/stream", (request, reply) => {
  const correlationId = requestCorrelationId(request);
  const session = requireSession(request, reply, correlationId);
  if (!session) return;
  // Checked when it is sent and not pretended to be checked when it is not: a same-origin GET
  // carries no Origin at all, so `sameSite: "strict"` plus the session is the actual defence --
  // the same footing every other GET on this daemon already stands on.
  const { origin } = request.headers;
  if (origin !== undefined && origin !== allowedOrigin) {
    return reply
      .code(403)
      .send(createError("ORIGIN_REJECTED", "The request origin is not allowed", correlationId));
  }
  // Before `hijack()`, because after it there is no reply left to send a status on.
  if (eventStreams.openCount() >= MAX_OPEN_STREAMS) {
    return reply
      .code(503)
      .send(createError("STREAM_LIMIT_REACHED", "Too many open event streams", correlationId));
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  // Flushes the headers now, so the client's `open` fires immediately instead of whenever the
  // first real signal happens to arrive.
  reply.raw.write(": open\n\n");

  const release = eventStreams.open({
    response: reply.raw,
    isAuthorized: () => sessionForRequest(request) !== undefined,
  });
  if (!release) {
    reply.raw.end();
    return;
  }
  request.raw.on("close", release);
});
```

- [ ] **Шаг 5: запустить и убедиться, что проходят**

Команда: `pnpm --filter @loomrail/daemon test -- event-stream`
Ожидается: PASS.

- [ ] **Шаг 6: доказательства мутацией**

Три отдельные мутации, каждая должна ронять свой и только свой тест:

1. Убрать `eventStreams.closeAll()` из `preClose` → падает «closes while a stream is still open».
2. Заменить проверку Origin на `if (false)` → падает «refuses a stream when an Origin is sent and does
   not match».
3. Убрать `requireSession` из маршрута → падает «refuses a stream to a caller without a session».

Каждый текст падения вставить в отчёт.

- [ ] **Шаг 7: Commit** (при наличии разрешения)

```bash
git add apps/daemon/src/event-stream.ts apps/daemon/src/server.ts apps/daemon/test/event-stream.integration.test.ts
git commit -m "feat(daemon): deliver committed events over an authenticated SSE stream"
```

---

### Задача 3: heartbeat, истечение сессии, предел соединений

**Файлы:**

- Изменить: `apps/daemon/src/event-stream.ts` (запуск такта по таймеру)
- Изменить: `apps/daemon/src/server.ts` (остановка таймера при закрытии)
- Изменить: `apps/daemon/test/event-stream.integration.test.ts`

**Интерфейсы:**

- Потребляет: `createEventStreamRegistry`, `tick`, `MAX_OPEN_STREAMS` (задача 2)
- Производит: `EventStreamRegistry` дополняется `stopHeartbeat: () => void`

**Почему такт вынесен в метод, а не спрятан в таймере.** Тест, ждущий реального интервала, проверяет
планировщик ОС, а на машине под нагрузкой становится неотличим от поломки — владелец отдельно предупреждает
об этом в описании окружения. `tick()` вызывается тестом напрямую и детерминирован; таймер в продукте не
делает ничего, кроме вызова `tick()`, поэтому расхождение между проверенным и работающим — одна строка.

- [ ] **Шаг 1: написать падающие тесты**

```ts
// Держать поток дольше сессии значит превратить канал в способ иметь бессрочный аутентифицированный
// доступ. Проверяется через `tick()`, а не ожиданием: разница между «проверено» и «работает» -- одна
// строка таймера.
it("closes an open stream once its session has expired", async () => {
  const registry = createEventStreamRegistry({ logger: silentLogger });
  const written: string[] = [];
  let authorized = true;
  const response = fakeResponse(written);
  registry.open({ response, isAuthorized: () => authorized });

  registry.tick();
  expect(written.at(-1)).toBe(": ping\n\n");
  expect(registry.openCount()).toBe(1);

  authorized = false;
  registry.tick();
  expect(registry.openCount()).toBe(0);
  expect(response.ended).toBe(true);
});

it("refuses to open more streams than the limit and leaves the open ones alone", () => {
  const registry = createEventStreamRegistry({ logger: silentLogger });
  const releases = Array.from({ length: MAX_OPEN_STREAMS }, () =>
    registry.open({ response: fakeResponse([]), isAuthorized: () => true }),
  );
  expect(releases.every((release) => release !== null)).toBe(true);
  expect(registry.open({ response: fakeResponse([]), isAuthorized: () => true })).toBeNull();
  expect(registry.openCount()).toBe(MAX_OPEN_STREAMS);
});

it("answers a stream request over the limit with a status rather than an opened stream", async () => {
  const session = await authenticate(daemon, token);
  const held = await Promise.all(
    Array.from({ length: MAX_OPEN_STREAMS }, () =>
      fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } }),
    ),
  );
  const refused = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });
  expect(refused.status).toBe(503);
  await refused.body?.cancel();
  await Promise.all(held.map((response) => response.body?.cancel()));
});
```

`fakeResponse` — минимальный двойник, записывающий кадры и помнящий, что его закрыли:

```ts
const fakeResponse = (written: string[]) => {
  const response = {
    ended: false,
    write: (frame: string) => {
      written.push(frame);
      return true;
    },
    end: () => {
      response.ended = true;
    },
  };
  return response as unknown as ServerResponse & { ended: boolean };
};
```

- [ ] **Шаг 2: запустить и убедиться, что падают**

Команда: `pnpm --filter @loomrail/daemon test -- event-stream`
Ожидается: FAIL — `stopHeartbeat` отсутствует и таймер не заведён; тест предела проходит уже сейчас
(предел построен в задаче 2), тест истечения сессии падает на закрытии.

- [ ] **Шаг 3: завести таймер**

В `createEventStreamRegistry`, перед `return`:

```ts
// The timer does nothing but call `tick`, which is what the tests drive directly. `unref` keeps
// an idle daemon from being held alive by its own heartbeat.
const heartbeat = setInterval(() => {
  registry.tick();
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();
```

и добавить в возвращаемый объект `stopHeartbeat: () => { clearInterval(heartbeat); }`. В `close()` демона
вызвать `eventStreams.stopHeartbeat()` рядом с `eventStreams.closeAll()`.

- [ ] **Шаг 4: запустить и убедиться, что проходят**

Команда: `pnpm --filter @loomrail/daemon test -- event-stream`
Ожидается: PASS.

- [ ] **Шаг 5: доказательство мутацией**

Убрать в `tick` ветку `if (!subscriber.isAuthorized())` → падает «closes an open stream once its session has
expired». Понизить `MAX_OPEN_STREAMS` до `Number.POSITIVE_INFINITY` → падают оба теста предела. Восстановить.

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add apps/daemon/src/event-stream.ts apps/daemon/src/server.ts apps/daemon/test/event-stream.integration.test.ts
git commit -m "feat(daemon): keep event streams within their session and their limit"
```

---

### Задача 4: публикация — обёртка `execute`

**Файлы:**

- Создать: `apps/daemon/src/broadcasting-state.ts`
- Создать: `apps/daemon/test/broadcasting-state.integration.test.ts`
- Изменить: `apps/daemon/src/server.ts` (обернуть `localState` один раз)

**Интерфейсы:**

- Потребляет: `LocalState` из `@loomrail/persistence-sqlite`; `EventSignal` (задача 1); `publish` из
  реестра (задача 2)
- Производит: `broadcastingState(state, publish, logger): LocalState` — используется задачами 7 и 8, потому
  что `runStageAttempt` получает `state` зависимостью и обязан получить именно обёрнутый

**Почему шов один и почему он здесь.** Обёртка ставится один раз, и всё, что ниже, получает обёрнутый
`state`: обработчики и `runStageAttempt`. Ни один путь не может быть забыт, потому что путь один. Шов
синхронен — `node:sqlite` синхронен, — значит новых точек ожидания и нового чередования не появляется.

**Три свойства, которые обязаны выполняться по построению, а не по внимательности:**

- `execute` бросил → транзакция откатилась → публиковать нечего;
- идемпотентный повтор → новых событий в таблице нет → запрос вернёт пусто;
- `lastSequence` инициализируется максимумом при старте → первый `execute` не рассылает историю.

**Отказ публикации не откатывает состояние** — это уже зафиксировано в ADR-0002. Ошибка ловится и пишется,
команда остаётся применённой; владелец увидит изменение при следующем сигнале или при переподключении. Здесь
это не теория: `LIST_EVENTS` разбирает строки через `domainEventSchema`, и именно эта операция была причиной
CRITICAL финального ревью A1 на настоящей базе владельца. Незакрытый бросок отсюда превратил бы любую будущую
нечитаемую запись в отказ команды.

- [ ] **Шаг 1: написать падающие тесты**

```ts
// apps/daemon/test/broadcasting-state.integration.test.ts
it("publishes one signal per committed event, carrying its scope", async () => {
  const published: EventSignal[] = [];
  const state = broadcastingState(await openTemp(), (signal) => published.push(signal), silentLogger);
  const project = registerProject(state);
  published.length = 0;

  const created = createWorkItem(state, project.id, "Ship the billing page");

  expect(published).toEqual([{ projectId: project.id, aggregateType: "WORK_ITEM", aggregateId: created.id }]);
});

it("publishes nothing when the command was rolled back", async () => {
  const published: EventSignal[] = [];
  const state = broadcastingState(await openTemp(), (signal) => published.push(signal), silentLogger);
  const project = registerProject(state);
  published.length = 0;

  expect(() => createWorkItem(state, project.id, "", { invalidOnPurpose: true })).toThrow();

  expect(published).toEqual([]);
});

// The replay path writes no new event, so the cursor must not move and nothing must be published.
// A cumulative "read everything since the last publish" implementation passes the first test and
// fails this one.
it("publishes nothing for an idempotent replay of the same command", async () => {
  const published: EventSignal[] = [];
  const state = broadcastingState(await openTemp(), (signal) => published.push(signal), silentLogger);
  const project = registerProject(state);
  const command = createWorkItemCommand(project.id, "Ship the billing page");
  state.execute(command);
  published.length = 0;

  state.execute(command);

  expect(published).toEqual([]);
});

// Without seeding lastSequence from the table, opening a database with history would broadcast the
// entire history on the first command -- invisible on the empty databases every other test uses.
it("does not replay existing history when it wraps a database that already has some", async () => {
  const databasePath = await tempDatabasePath();
  const seeded = await openTemp(databasePath);
  const project = registerProject(seeded);
  createWorkItem(seeded, project.id, "Older work");
  seeded.close();

  const published: EventSignal[] = [];
  const state = broadcastingState(
    await openTemp(databasePath),
    (signal) => published.push(signal),
    silentLogger,
  );
  const created = createWorkItem(state, project.id, "Newer work");

  expect(published).toEqual([{ projectId: project.id, aggregateType: "WORK_ITEM", aggregateId: created.id }]);
});

// ADR-0002: a publication failure does not roll the state back. A throw from the channel must not
// become a failed command for the owner.
it("keeps the command applied when publication throws", async () => {
  const state = broadcastingState(
    await openTemp(),
    () => {
      throw new Error("channel is gone");
    },
    silentLogger,
  );
  const project = registerProject(state);

  const created = createWorkItem(state, project.id, "Ship the billing page");

  expect(readWorkItem(state, created.id).title).toBe("Ship the billing page");
});
```

- [ ] **Шаг 2: запустить и убедиться, что падают**

Команда: `pnpm --filter @loomrail/daemon test -- broadcasting-state`
Ожидается: FAIL — модуль отсутствует.

- [ ] **Шаг 3: реализовать обёртку**

```ts
// apps/daemon/src/broadcasting-state.ts
import type { EventSignal } from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";
import type { FastifyBaseLogger } from "fastify";

export const SIGNAL_PAGE_LIMIT = 500;

const newestSequence = (state: LocalState): number => {
  const page = state.query({ type: "LIST_EVENTS", direction: "DESC", limit: 1 });
  return page.type === "EVENTS" ? (page.events[0]?.sequence ?? 0) : 0;
};

/**
 * The single seam through which committed events reach the channel.
 *
 * Wrapping `execute` once means every writer downstream -- the request handlers and
 * `runStageAttempt`, which takes `state` as a dependency -- publishes without knowing it does.
 * There is no path to forget, because there is one path. Synchronous throughout: `node:sqlite` is
 * synchronous, so this introduces no new yield point and therefore no new interleaving.
 */
export const broadcastingState = (
  state: LocalState,
  publish: (signal: EventSignal) => void,
  logger: FastifyBaseLogger,
): LocalState => {
  // Seeded from the table, not from zero: otherwise the first command against a database with
  // history would broadcast all of it.
  let lastSequence = newestSequence(state);

  const publishCommitted = (): void => {
    for (;;) {
      const page = state.query({
        type: "LIST_EVENTS",
        direction: "ASC",
        afterSequence: lastSequence,
        limit: SIGNAL_PAGE_LIMIT,
      });
      if (page.type !== "EVENTS" || page.events.length === 0) return;
      for (const event of page.events) {
        publish({
          projectId: event.projectId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
        });
        lastSequence = event.sequence;
      }
      if (!page.hasMore) return;
    }
  };

  return {
    ...state,
    execute: (command) => {
      // A throw here rolls the transaction back, so nothing was committed and nothing is published
      // -- the ordering is the whole guarantee, not a convenience.
      const result = state.execute(command);
      try {
        publishCommitted();
      } catch (error: unknown) {
        // ADR-0002: publication failure does not roll state back. The owner sees the change on the
        // next signal or on reconnect; the command stays applied either way.
        logger.warn(
          { error: error instanceof Error ? error.name : "unknown" },
          "Committed events could not be published to the event channel",
        );
      }
      return result;
    },
  };
};
```

- [ ] **Шаг 4: подключить в `server.ts`**

Сразу после `openLocalState` и создания реестра:

```ts
const localState = broadcastingState(
  await openLocalState({ databasePath: options.stateDatabasePath ?? ":memory:", now }),
  eventStreams.publish,
  app.log,
);
```

Имя `localState` сохраняется намеренно: ни одна из ~40 существующих точек использования не меняется, а
обёрнутым оказывается всё, включая `runStageAttempt`.

- [ ] **Шаг 5: запустить и убедиться, что проходят**

Команды: `pnpm --filter @loomrail/daemon test -- broadcasting-state`, затем `pnpm --filter @loomrail/daemon test`
Ожидается: PASS, существующие тесты демона не затронуты.

- [ ] **Шаг 6: доказательства мутацией**

1. Перенести `publishCommitted()` **перед** `state.execute(command)` → падает «publishes nothing when the
   command was rolled back».
2. Заменить `let lastSequence = newestSequence(state)` на `= 0` → падает «does not replay existing history».
3. Убрать `try/catch` вокруг `publishCommitted()` → падает «keeps the command applied when publication
   throws».

- [ ] **Шаг 7: Commit** (при наличии разрешения)

```bash
git add apps/daemon/src/broadcasting-state.ts apps/daemon/src/server.ts apps/daemon/test/broadcasting-state.integration.test.ts
git commit -m "feat(daemon): publish committed events through one execute seam"
```

---

### Задача 5: клиент — область сигнала и сведение

**Файлы:**

- Создать: `apps/web/src/eventStream.ts`
- Создать: `apps/web/src/eventStream.test.ts`

**Интерфейсы:**

- Потребляет: `eventSignalSchema`, `EventSignal` (задача 1)
- Производит:
  ```ts
  scopesForSignal(signal: EventSignal): readonly (readonly string[])[]
  createSignalCoalescer(flush: (keys: readonly (readonly string[])[]) => void, windowMs: number): {
    push: (signal: EventSignal) => void;
    dispose: () => void;
  }
  ```
  потребляются задачей 6

**Почему эти функции отделены от хука.** Отображение области и сведение — чистая логика, проверяемая без DOM
и без сети; хук — подключение и жизненный цикл. Разделение позволяет тестам задачи 5 быть детерминированными
без притворного `EventSource`.

**Ключи React Query префиксные** (`apps/web/src/workspace.tsx:39-48`), поэтому одна инвалидация по
`["projects", projectId]` покрывает и доску проекта, и его открытые Human Requests, и события задач. Идентификатора попытки в
событиях нет, поэтому область сессий инвалидируется целиком: клиент держит в кэше одну-две попытки.

- [ ] **Шаг 1: написать падающие тесты**

```ts
// apps/web/src/eventStream.test.ts
import { describe, expect, it, vi } from "vitest";

import { createSignalCoalescer, scopesForSignal } from "./eventStream";

const workItemSignal = {
  projectId: "p1",
  aggregateType: "WORK_ITEM",
  aggregateId: "w1",
} as const;

describe("scopesForSignal", () => {
  it("invalidates the project scope and the work item's own workflow", () => {
    expect(scopesForSignal(workItemSignal)).toEqual([
      ["projects", "p1"],
      ["work-items", "w1"],
      ["stage-attempts"],
    ]);
  });

  it("invalidates the project list for a project-scoped signal, without a work item scope", () => {
    expect(scopesForSignal({ projectId: "p1", aggregateType: "PROJECT", aggregateId: "p1" })).toEqual([
      ["projects", "p1"],
      ["projects"],
    ]);
  });
});

describe("createSignalCoalescer", () => {
  it("flushes a burst as one call with each scope present once", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const coalescer = createSignalCoalescer(flush, 50);

    coalescer.push(workItemSignal);
    coalescer.push(workItemSignal);
    coalescer.push({ ...workItemSignal, aggregateId: "w2" });
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]?.[0]).toEqual([
      ["projects", "p1"],
      ["work-items", "w1"],
      ["stage-attempts"],
      ["work-items", "w2"],
    ]);
    vi.useRealTimers();
  });

  // Without this, a stage that publishes steadily would keep pushing the deadline out and the board
  // would never refresh while anything was happening -- the exact opposite of the point.
  it("does not postpone a pending flush when more signals arrive inside the window", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const coalescer = createSignalCoalescer(flush, 50);

    coalescer.push(workItemSignal);
    vi.advanceTimersByTime(40);
    coalescer.push({ ...workItemSignal, aggregateId: "w2" });
    vi.advanceTimersByTime(10);

    expect(flush).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("drops a pending flush when disposed", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const coalescer = createSignalCoalescer(flush, 50);
    coalescer.push(workItemSignal);
    coalescer.dispose();
    vi.advanceTimersByTime(50);
    expect(flush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

- [ ] **Шаг 2: запустить и убедиться, что падают**

Команда: `pnpm --filter @loomrail/web test -- eventStream`
Ожидается: FAIL — модуль отсутствует.

- [ ] **Шаг 3: реализовать**

```ts
// apps/web/src/eventStream.ts
import type { EventSignal } from "@loomrail/contracts";

export const COALESCE_WINDOW_MS = 50;

type QueryScope = readonly string[];

/**
 * Which cached scopes a signal makes stale.
 *
 * Query keys are prefix-shaped (workspace.tsx:39-48), so one entry per scope covers everything
 * nested under it. The stage-attempt scope is invalidated whole because events carry no attempt
 * id -- the client holds one or two attempts, so the cost is one refetch.
 */
export const scopesForSignal = (signal: EventSignal): readonly QueryScope[] =>
  signal.aggregateType === "WORK_ITEM"
    ? [["projects", signal.projectId], ["work-items", signal.aggregateId], ["stage-attempts"]]
    : [["projects", signal.projectId], ["projects"]];

/**
 * Collects signals arriving inside one window and flushes their union once.
 *
 * A running stage publishes in bursts -- session started, checkpoint, wind-down asked, session
 * ended -- and invalidating per signal would mean a refetch storm and a jumpy board. The deadline
 * is set by the first signal of a burst and never postponed by later ones, so a steadily
 * publishing stage still refreshes on schedule instead of starving.
 */
export const createSignalCoalescer = (
  flush: (scopes: readonly QueryScope[]) => void,
  windowMs: number = COALESCE_WINDOW_MS,
): { push: (signal: EventSignal) => void; dispose: () => void } => {
  const pending = new Map<string, QueryScope>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (): void => {
    timer = undefined;
    const scopes = [...pending.values()];
    pending.clear();
    if (scopes.length > 0) flush(scopes);
  };

  return {
    push: (signal) => {
      for (const scope of scopesForSignal(signal)) pending.set(scope.join("/"), scope);
      timer ??= setTimeout(run, windowMs);
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
};
```

- [ ] **Шаг 4: запустить и убедиться, что проходят**

Команда: `pnpm --filter @loomrail/web test -- eventStream`
Ожидается: PASS, семь тестов.

- [ ] **Шаг 5: доказательства мутацией**

1. Заменить `timer ??= setTimeout(run, windowMs)` на безусловное пересоздание таймера
   (`clearTimeout(timer); timer = setTimeout(run, windowMs)`) → падает «does not postpone a pending flush».
2. Заменить `Map` на массив без ключа → падает «flushes a burst as one call with each scope present once».

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add apps/web/src/eventStream.ts apps/web/src/eventStream.test.ts
git commit -m "feat(web): map channel signals to the cache scopes they make stale"
```

---

### Задача 6: клиент — подключение и состояние канала

**Файлы:**

- Изменить: `apps/web/src/eventStream.ts` (добавить `connectEventStream`)
- Изменить: `apps/web/src/eventStream.test.ts`
- Создать: `apps/web/src/useEventStream.ts`
- Изменить: `apps/web/src/App.tsx` (монтирование), `apps/web/src/workspace.tsx` (признак в контекст)

**Интерфейсы:**

- Потребляет: `createSignalCoalescer`, `scopesForSignal` (задача 5); `eventSignalSchema` (задача 1)
- Производит:
  ```ts
  type EventChannelStatus = "connecting" | "live" | "closed";
  type EventSourceLike = {
    readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    close: () => void;
  };
  connectEventStream(options: {
    source: EventSourceLike;
    invalidateAll: () => void;
    invalidateScopes: (scopes: readonly (readonly string[])[]) => void;
    onStatus: (status: EventChannelStatus) => void;
    windowMs?: number;
  }): () => void
  useEventStream(enabled: boolean): EventChannelStatus
  ```

**Почему логика вынесена из хука.** Проверка React-хука потребовала бы `@testing-library/react`, а глобальные
ограничения запрещают новые зависимости. Вся логика живёт в `connectEventStream`, принимающем двойник
источника; `useEventStream` остаётся десятью строками `useEffect`, в которых нечего ломать. Это не обход
проверки, а перенос её туда, где она детерминирована.

**Две несущие строки.** `invalidateAll()` при каждом `open` — это то, чем D3 делает потерю сигнала
безвредной. И разбор `JSON.parse` внутри `try`: битый кадр обязан быть отброшен, а не уронить обработчик,
после чего канал бы молча замолчал.

- [ ] **Шаг 1: написать падающие тесты**

```ts
// дополнение к apps/web/src/eventStream.test.ts
const fakeSource = () => {
  const source = {
    readyState: 0,
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  return source;
};

describe("connectEventStream", () => {
  it("invalidates everything on open, which is what makes a lost signal harmless", () => {
    const invalidateAll = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll, invalidateScopes: vi.fn(), onStatus: vi.fn() });

    source.onopen?.({});

    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates everything again on every reconnect, not only the first connection", () => {
    const invalidateAll = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll, invalidateScopes: vi.fn(), onStatus: vi.fn() });

    source.onopen?.({});
    source.onerror?.({});
    source.onopen?.({});

    expect(invalidateAll).toHaveBeenCalledTimes(2);
  });

  it("invalidates the signalled scopes once the window closes", () => {
    vi.useFakeTimers();
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll: vi.fn(), invalidateScopes, onStatus: vi.fn(), windowMs: 50 });

    source.onmessage?.({
      data: JSON.stringify({ projectId: "p1", aggregateType: "WORK_ITEM", aggregateId: "w1" }),
    });
    vi.advanceTimersByTime(50);

    expect(invalidateScopes).toHaveBeenCalledWith([
      ["projects", "p1"],
      ["work-items", "w1"],
      ["stage-attempts"],
    ]);
    vi.useRealTimers();
  });

  // A frame that is not JSON, and a frame that is JSON but not a signal, are both provider-adjacent
  // untrusted input. Either one throwing out of the handler would leave the channel silently mute.
  it("drops a malformed frame without throwing and keeps working afterwards", () => {
    vi.useFakeTimers();
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll: vi.fn(), invalidateScopes, onStatus: vi.fn(), windowMs: 50 });

    expect(() => source.onmessage?.({ data: "{not json" })).not.toThrow();
    expect(() => source.onmessage?.({ data: JSON.stringify({ projectId: "p1" }) })).not.toThrow();
    vi.advanceTimersByTime(50);
    expect(invalidateScopes).not.toHaveBeenCalled();

    source.onmessage?.({
      data: JSON.stringify({ projectId: "p1", aggregateType: "WORK_ITEM", aggregateId: "w1" }),
    });
    vi.advanceTimersByTime(50);
    expect(invalidateScopes).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // Per the HTML spec EventSource reconnects itself on a network error but closes permanently on a
  // non-200 response. So CLOSED means "the session is gone", and the UI must not keep looking live.
  it("reports a permanently closed channel apart from a reconnecting one", () => {
    const onStatus = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll: vi.fn(), invalidateScopes: vi.fn(), onStatus });

    source.readyState = 0; // CONNECTING
    source.onerror?.({});
    expect(onStatus).toHaveBeenLastCalledWith("connecting");

    source.readyState = 2; // CLOSED
    source.onerror?.({});
    expect(onStatus).toHaveBeenLastCalledWith("closed");
  });

  it("closes the source and drops pending work when disconnected", () => {
    vi.useFakeTimers();
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    const disconnect = connectEventStream({
      source,
      invalidateAll: vi.fn(),
      invalidateScopes,
      onStatus: vi.fn(),
      windowMs: 50,
    });

    source.onmessage?.({
      data: JSON.stringify({ projectId: "p1", aggregateType: "WORK_ITEM", aggregateId: "w1" }),
    });
    disconnect();
    vi.advanceTimersByTime(50);

    expect(source.closed).toBe(true);
    expect(invalidateScopes).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

- [ ] **Шаг 2: запустить и убедиться, что падают**

Команда: `pnpm --filter @loomrail/web test -- eventStream`
Ожидается: FAIL — `connectEventStream` не экспортируется.

- [ ] **Шаг 3: реализовать `connectEventStream`**

```ts
// дополнение к apps/web/src/eventStream.ts
import { eventSignalSchema } from "@loomrail/contracts";

export type EventChannelStatus = "connecting" | "live" | "closed";

const EVENT_SOURCE_CLOSED = 2;

export type EventSourceLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close: () => void;
};

export const connectEventStream = (options: {
  source: EventSourceLike;
  invalidateAll: () => void;
  invalidateScopes: (scopes: readonly (readonly string[])[]) => void;
  onStatus: (status: EventChannelStatus) => void;
  windowMs?: number;
}): (() => void) => {
  const coalescer = createSignalCoalescer(options.invalidateScopes, options.windowMs);

  options.source.onopen = () => {
    options.onStatus("live");
    // Load-bearing (spec D3): everything done while disconnected is caught up by refetching, which
    // is precisely why the channel needs no replay and a dropped signal costs nothing.
    options.invalidateAll();
  };

  options.source.onmessage = (message) => {
    // The frame is untrusted input on the client's side of the boundary: parsed inside a guard and
    // validated by schema. A throw here would leave the channel silently mute.
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    const signal = eventSignalSchema.safeParse(parsed);
    if (!signal.success) return;
    coalescer.push(signal.data);
  };

  options.source.onerror = () => {
    options.onStatus(options.source.readyState === EVENT_SOURCE_CLOSED ? "closed" : "connecting");
  };

  return () => {
    coalescer.dispose();
    options.source.close();
  };
};
```

- [ ] **Шаг 4: тонкий хук и монтирование**

```ts
// apps/web/src/useEventStream.ts
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { connectEventStream, type EventChannelStatus } from "./eventStream";

export const useEventStream = (enabled: boolean): EventChannelStatus => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EventChannelStatus>("connecting");

  useEffect(() => {
    if (!enabled) return;
    return connectEventStream({
      source: new EventSource("/api/v1/stream"),
      invalidateAll: () => {
        void queryClient.invalidateQueries();
      },
      invalidateScopes: (scopes) => {
        for (const queryKey of scopes) void queryClient.invalidateQueries({ queryKey });
      },
      onStatus: setStatus,
    });
  }, [enabled, queryClient]);

  return status;
};
```

Смонтировать внутри `WorkspaceProvider` (там уже известно, установлена ли сессия) и положить `status` в
контекст рабочей области рядом с существующими полями. При `status === "closed"` показать уже существующую в
продукте подачу «локальный демон недоступен» — ту, что покрыта браузерным тестом «explains how to recover
when the local daemon becomes unavailable», — а не заводить вторую.

- [ ] **Шаг 5: запустить**

Команды: `pnpm --filter @loomrail/web test`, затем `pnpm --filter @loomrail/web typecheck`
Ожидается: PASS.

- [ ] **Шаг 6: доказательства мутацией**

1. Убрать `options.invalidateAll()` из `onopen` → падают «invalidates everything on open» и «…on every
   reconnect».
2. Убрать `try/catch` вокруг `JSON.parse` → падает «drops a malformed frame without throwing».
3. Заменить условие статуса на всегда `"connecting"` → падает «reports a permanently closed channel apart
   from a reconnecting one».

- [ ] **Шаг 7: Commit** (при наличии разрешения)

```bash
git add apps/web/src/eventStream.ts apps/web/src/eventStream.test.ts apps/web/src/useEventStream.ts apps/web/src/App.tsx apps/web/src/workspace.tsx
git commit -m "feat(web): follow the event channel and show when it has gone"
```

---

### Задача 7: фоновый исполнитель — модуль

**Файлы:**

- Создать: `apps/daemon/src/session-worker.ts`
- Создать: `apps/daemon/test/session-worker.integration.test.ts`
- Изменить: `apps/daemon/src/session-loop.ts` (необязательный `onSessionLive` в `RunStageAttemptDeps`)

**Интерфейсы:**

- Потребляет: `runStageAttempt`, `RunStageAttemptDeps` (`session-loop.ts`); `LocalState`; `ProviderAdapter`
- Производит:
  ```ts
  type SessionWorker = { wake: () => void; whenIdle: () => Promise<void>; stop: () => Promise<void> };
  createSessionWorker(deps: {
    state: LocalState; adapter: ProviderAdapter; template: WorkflowTemplate;
    createCommandId: () => string; logger: FastifyBaseLogger;
  }): SessionWorker
  ```
  потребляется задачей 8

**Тело цикла переносится, а не переписывается.** Выбор головы очереди, `MARK_WORKFLOW_DISPATCH_STARTED` и
вызов `runStageAttempt` берутся из `server.ts:274-345` как есть. Меняются ровно два исхода: бросок из
`runOnce` больше не улетает вызывающему, а превышение предела циклов останавливает проход с записью вместо
броска.

**Защита неподвинутой головы (`previousDispatchId`) переносится и сохраняет тест `796e24c`.** Она больше не
ловит второй конкурентный drain — таких нет по построению, — но продолжает ловить голову, которую исполнитель
сдвинуть не может: `runStageAttempt` в этом случае возвращается молча, и без защиты цикл крутил бы одну и ту
же запись до предела.

**`onSessionLive` — не спекуляция.** `stop()` обязан позвать `abortSession` для идущей сессии (спек D5), а
идентификатор сессии знает только `runStageAttempt`. Необязательный обратный вызов — тот же вид шва, что уже
принят рядом (`scheduleHandoffDeadline`, `session-loop.ts:93`).

- [ ] **Шаг 1: добавить шов в `session-loop.ts`**

В `RunStageAttemptDeps`:

```ts
  /**
   * Called with the live session's id when one opens and with `null` when it closes.
   *
   * `stop()` has to reach the running session to abort it (spec D5) and only this loop knows which
   * one that is. Optional and side-effect free, like `scheduleHandoffDeadline` above it.
   */
  onSessionLive?: (providerSessionId: string | null) => void;
```

Вызвать `deps.onSessionLive?.(providerSession.id)` сразу после успешного `START_PROVIDER_SESSION` и
`deps.onSessionLive?.(null)` в том месте, где сессия помечается завершённой (`live.closed = true`).

- [ ] **Шаг 2: написать падающие тесты**

```ts
// apps/daemon/test/session-worker.integration.test.ts

// An adapter whose start() does not resolve until the test lets it. Every test below and every
// test in Task 8 is deterministic because of this: nothing ever waits on a duration, only on a
// gate the test itself opens. Shared by both tasks -- put it in apps/daemon/test/gated-adapter.ts
// and import it, rather than writing it twice.
export type GatedAdapter = ProviderAdapter & {
  started: Promise<void>;
  release: () => void;
  startCallCount: number;
  releasedCount: number;
  abortedSessions: readonly string[];
};

export const gatedAdapter = (contextWindowTokens = 200_000): GatedAdapter => {
  let announceStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const aborted: string[] = [];

  const adapter: GatedAdapter = {
    started,
    startCallCount: 0,
    releasedCount: 0,
    get abortedSessions() {
      return aborted;
    },
    release: () => {
      adapter.releasedCount += 1;
      openGate();
    },
    capabilities: () => ({
      provider: "MOCK",
      start: true,
      interrupt: false,
      eventStream: false,
      usageReporting: false,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens,
    }),
    start: async (invocation) => {
      adapter.startCallCount += 1;
      announceStarted();
      await gate;
      return {
        type: "COMPLETED",
        providerSessionId: invocation.session.id,
        checkpoint: {
          summary: "Held until the test released it",
          completed: ["the gated turn"],
          remaining: [],
          deadEnds: [],
          openQuestions: [],
        },
      };
    },
    requestHandoff: async () => undefined,
    abortSession: async (sessionId) => {
      aborted.push(sessionId);
    },
  };
  return adapter;
};

it("runs one attempt at a time and does not start a second on a wake mid-flight", async () => {
  const adapter = gatedAdapter();
  const worker = createSessionWorker({ state, adapter, template, createCommandId, logger });
  seedQueuedAttempt(state);

  worker.wake();
  await adapter.started;
  worker.wake();
  worker.wake();

  expect(adapter.startCallCount).toBe(1);
  adapter.release();
  await worker.whenIdle();
});

// The wake that arrived mid-attempt has to be honoured after it, or a dispatch created by a request
// while a stage was running would sit in the queue until something unrelated woke the worker.
it("takes another pass for a wake that arrived while it was busy", async () => {
  const adapter = gatedAdapter();
  const worker = createSessionWorker({ state, adapter, template, createCommandId, logger });
  seedQueuedAttempt(state, { count: 1 });

  worker.wake();
  await adapter.started;
  seedQueuedAttempt(state, { count: 1 });
  worker.wake();
  adapter.release();
  await worker.whenIdle();

  expect(pendingDispatchModes(state)).toEqual([]);
});

it("resolves whenIdle only once the queue is empty", async () => {
  const adapter = gatedAdapter();
  const worker = createSessionWorker({ state, adapter, template, createCommandId, logger });
  seedQueuedAttempt(state);
  worker.wake();
  await adapter.started;

  let settled = false;
  void worker.whenIdle().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  adapter.release();
  await worker.whenIdle();
  expect(settled).toBe(true);
});

// The guard that used to catch a second concurrent drain now catches an unmovable head. Without it
// the loop would spin on the same row to the cycle limit.
it("stops the pass when the head of the queue did not move", async () => {
  const worker = createSessionWorker({
    state,
    adapter: adapterThatDoesNothing(),
    template,
    createCommandId,
    logger,
  });
  seedUnmovableDispatch(state);

  worker.wake();
  await worker.whenIdle();

  expect(logger.records.map(({ msg }) => msg)).toContain(
    "The pending workflow dispatch is already being run elsewhere; this drain stops",
  );
});

// The background loop has no caller to hand a 500 to. A throw must stay inside it, and must not
// leave the worker permanently busy -- which is what would make every later wake a no-op.
it("keeps a throw inside the loop and stays able to run again", async () => {
  const worker = createSessionWorker({
    state,
    adapter: adapterThatThrows(),
    template,
    createCommandId,
    logger,
  });
  seedQueuedAttempt(state);

  worker.wake();
  await expect(worker.whenIdle()).resolves.toBeUndefined();

  const healthy = createSessionWorker({
    state,
    adapter: createMockProvider(),
    template,
    createCommandId,
    logger,
  });
  healthy.wake();
  await healthy.whenIdle();
  expect(snapshotOf(state).run?.status).not.toBe("RUNNING");
});

it("asks the live session to abort when stopped", async () => {
  const adapter = gatedAdapter();
  const worker = createSessionWorker({ state, adapter, template, createCommandId, logger });
  seedQueuedAttempt(state);
  worker.wake();
  await adapter.started;

  await worker.stop();

  expect(adapter.abortedSessions).toHaveLength(1);
  adapter.release();
});
```

- [ ] **Шаг 3: запустить и убедиться, что падают**

Команда: `pnpm --filter @loomrail/daemon test -- session-worker`
Ожидается: FAIL — модуль отсутствует.

- [ ] **Шаг 4: реализовать**

```ts
// apps/daemon/src/session-worker.ts
export const DISPATCH_CYCLE_LIMIT = 20;

export type SessionWorker = {
  wake: () => void;
  whenIdle: () => Promise<void>;
  stop: () => Promise<void>;
};

export type SessionWorkerDeps = {
  state: LocalState;
  adapter: ProviderAdapter;
  template: WorkflowTemplate;
  createCommandId: () => string;
  logger: FastifyBaseLogger;
};

export const createSessionWorker = (deps: SessionWorkerDeps): SessionWorker => {
  let running = false;
  let pending = false;
  let stopping = false;
  let liveSessionId: string | null = null;
  const idleWaiters: (() => void)[] = [];

  const settleIdle = (): void => {
    for (const waiter of idleWaiters.splice(0)) waiter();
  };

  // The body moved from server.ts:274-345 unchanged, except for the two outcomes noted below.
  const runOnce = async (): Promise<void> => {
    // The body of drainProviderDispatches, server.ts:274-345, moved verbatim: the head-of-queue
    // read, the unmoved-head guard and its log line, MARK_WORKFLOW_DISPATCH_STARTED, and the
    // runStageAttempt call. Two outcomes change and nothing else does:
    //   * exceeding DISPATCH_CYCLE_LIMIT logs and returns instead of throwing StateStoreError,
    //     because there is no caller left to turn that throw into a 500;
    //   * runStageAttempt is passed `onSessionLive: (id) => { liveSessionId = id; }` so `stop()`
    //     can reach the live session.
    // Everything else is a copy. A rewrite here would be a second implementation of a loop that
    // took two fix rounds and a throwaway-database probe to get right in A1.
  };

  const pump = async (): Promise<void> => {
    // A wake arriving mid-pass leaves `pending` set; the loop below picks it up rather than
    // starting a second, concurrent attempt.
    if (running) return;
    running = true;
    try {
      while (pending && !stopping) {
        pending = false;
        try {
          await runOnce();
        } catch (error: unknown) {
          // There is no caller to hand a 500 to any more. The durable consequences of a failed
          // session already live on the StageAttempt (A1 spec §6.5), and a throw leaves a bounded
          // state that RECONCILE_WORKFLOWS repairs on the next start.
          deps.logger.error(
            { error: error instanceof Error ? error.name : "unknown" },
            "The background session worker could not finish a pass",
          );
        }
      }
    } finally {
      running = false;
      if (!pending || stopping) settleIdle();
    }
  };

  return {
    wake: () => {
      if (stopping) return;
      pending = true;
      void pump();
    },
    whenIdle: () =>
      !running && !pending
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
    stop: async () => {
      stopping = true;
      pending = false;
      // Spec D5: the provider is told to stop, and we do not wait to be told it did. `abortSession`
      // resolving is not proof the run ended -- that gap is A2's, where there will finally be an
      // adapter capable of failing to stop.
      if (liveSessionId !== null) {
        await deps.adapter.abortSession(liveSessionId).catch(() => undefined);
      }
      settleIdle();
    },
  };
};
```

`liveSessionId` присваивается из `onSessionLive`, передаваемого в `runStageAttempt` внутри `runOnce`.

**Два изменённых исхода внутри `runOnce`:** превышение `DISPATCH_CYCLE_LIMIT` больше не бросает
`StateStoreError`, а пишет `deps.logger.error` и возвращается; защита неподвинутой головы сохраняет и текст
записи, и поведение «этот проход останавливается».

- [ ] **Шаг 5: запустить и убедиться, что проходят**

Команда: `pnpm --filter @loomrail/daemon test -- session-worker`

- [ ] **Шаг 6: доказательства мутацией**

1. Убрать `if (running) return;` из `pump` → падает «runs one attempt at a time».
2. Заменить `while (pending && !stopping)` на однократный `if` → падает «takes another pass for a wake that
   arrived while it was busy».
3. Вызвать `settleIdle()` в начале `pump`, а не в `finally` → падает «resolves whenIdle only once the queue
   is empty».
4. Убрать перенесённую защиту `previousDispatchId` → падает «stops the pass when the head of the queue did
   not move».
5. Убрать `try/catch` вокруг `runOnce()` → падает «keeps a throw inside the loop».

- [ ] **Шаг 7: Commit** (при наличии разрешения)

```bash
git add apps/daemon/src/session-worker.ts apps/daemon/src/session-loop.ts apps/daemon/test/session-worker.integration.test.ts
git commit -m "feat(daemon): run the stage-attempt queue in a single background worker"
```

---

### Задача 8: подключение исполнителя к демону

**Файлы:**

- Изменить: `apps/daemon/src/server.ts` (старт, четыре обработчика, `close`, тип `RunningDaemon`)
- Изменить: `apps/daemon/test/session.integration.test.ts` (переезд теста R30)
- Изменить: `apps/daemon/test/server.integration.test.ts` (новые тесты неблокирующего старта)

**Интерфейсы:**

- Потребляет: `createSessionWorker`, `SessionWorker` (задача 7)
- Производит: `RunningDaemon` дополняется `whenIdle: () => Promise<void>` — потребляется задачей 9 и всеми
  существующими тестами демона, драйвящими стадию через HTTP

**Это задача, в которой поведение продукта меняется.** До неё канал уже работает и доска обновляется сама;
после неё цикл уходит в фон. Порядок выбран так, чтобы окна регрессии не возникло вовсе.

**`whenIdle` на публичном типе — принятая цена D6.** Шов существует ради проверок и той же породы, что уже
принятые в этом файле: инъекция `providerAdapter` (`server.ts:78`) и test-only snapshot hook задачи 7 A1.
Альтернатива — опрос API с таймаутом в каждом тесте — на машине под нагрузкой делает поломку неотличимой от
нагрузки, о чём владелец предупреждает отдельно.

- [ ] **Шаг 1: написать падающие тесты**

```ts
// apps/daemon/test/server.integration.test.ts

// The point of the whole task, asserted without a timer: the adapter is held, so the attempt is
// provably still in flight when the daemon answers. Before the change `startDaemon` itself would
// not have returned, and this test cannot reach its first line.
it("listens while a resumed attempt is still running", async () => {
  const adapter = gatedAdapter();
  const seeded = await seedQueuedAttemptOnDisk(databasePath);

  const daemon = await startDaemon({
    bootstrapToken: token,
    stateDatabasePath: databasePath,
    logger: false,
    providerAdapter: adapter,
  });
  try {
    await adapter.started;
    const health = await fetch(`${daemon.baseUrl}/health/ready`);
    expect(health.status).toBe(200);
    expect(sessionRows(databasePath, seeded.stageAttemptId).sessions).toHaveLength(1);
  } finally {
    adapter.release();
    await daemon.whenIdle();
    await daemon.close();
  }
});

// The other half: a request that starts a stage must answer before the stage ends, or "answer a
// Human Request" holds the response open for the whole stage with a live adapter.
it("answers a pipeline start before the stage has finished", async () => {
  const adapter = gatedAdapter();
  const daemon = await startDaemon({
    bootstrapToken: token,
    stateDatabasePath: databasePath,
    logger: false,
    providerAdapter: adapter,
  });
  try {
    const session = await authenticate(daemon, token);
    const response = await startPipeline(daemon, session, workItemId);

    expect(response.status).toBe(200);
    const snapshot = workflowSnapshotSchema.parse(await response.json());
    expect(snapshot.run?.status).toBe("RUNNING");
    expect(adapter.releasedCount).toBe(0);
  } finally {
    adapter.release();
    await daemon.whenIdle();
    await daemon.close();
  }
});

// Spec §9 names all four handlers, not one. They receive the identical one-line change, so the
// cheap mistake is changing three and missing the fourth -- which no other test would notice,
// because a handler that still awaits the drain simply answers later and answers correctly.
it.each([
  ["pipeline start", startPipeline],
  ["pipeline resume", resumePipeline],
  ["budget override", approveBudgetOverride],
  ["human request answer", answerOpenRequest],
])("answers %s before the stage it triggers has finished", async (_name, act) => {
  const adapter = gatedAdapter();
  const daemon = await startDaemon({
    bootstrapToken: token,
    stateDatabasePath: databasePath,
    logger: false,
    providerAdapter: adapter,
  });
  try {
    const session = await authenticate(daemon, token);
    const response = await act(daemon, session);
    expect(response.status).toBe(200);
    expect(adapter.releasedCount).toBe(0);
  } finally {
    adapter.release();
    await daemon.whenIdle();
    await daemon.close();
  }
});

it("closes while an attempt is still in flight and asks it to abort", async () => {
  const adapter = gatedAdapter();
  const daemon = await startDaemon({
    bootstrapToken: token,
    stateDatabasePath: databasePath,
    logger: false,
    providerAdapter: adapter,
  });
  const session = await authenticate(daemon, token);
  await startPipeline(daemon, session, workItemId);
  await adapter.started;

  const closed = daemon.close().then(() => "closed" as const);
  const timedOut = new Promise<"hung">((resolve) =>
    setTimeout(() => {
      resolve("hung");
    }, 5_000),
  );
  await expect(Promise.race([closed, timedOut])).resolves.toBe("closed");
  expect(adapter.abortedSessions).toHaveLength(1);
  adapter.release();
});
```

**Переезд теста R30** в `session.integration.test.ts:994-1046`. Его комментарий «Reaching here at all is half
the assertion: … `startDaemon` rejects … before ever returning» перестаёт быть верным: `startDaemon` больше не
отвергает. Утверждение обязано сохранить зубы, а не раствориться. Новая форма:

```ts
const daemon = await startDaemon({/* … как было … */});
try {
  // The boot pass now runs in the background, so the assertion moves from "startDaemon returned"
  // to "the background pass finished without leaving a standing instruction behind". Both halves
  // of the original jam are still asserted: the hard pause is reachable through HTTP, and the
  // answer really puts the stage back to work instead of wedging the queue.
  await daemon.whenIdle();
  const session = await authenticate(daemon, token);
  /* … остальная часть теста без изменений … */
  expect(answerResponse.status).toBe(200);
  await daemon.whenIdle();
} finally {
  await daemon.close();
}
```

Хвостовые утверждения теста (`pendingDispatchModes(after)` пуст, три сессии, `HARD_PAUSED`, `OPEN` + `RESOLVED`)
остаются дословно: именно они и ловят заклинивание, и именно они обязаны краснеть при мутации.

- [ ] **Шаг 2: запустить и убедиться, что падают**

Команда: `pnpm --filter @loomrail/daemon test`
Ожидается: FAIL — `daemon.whenIdle` отсутствует; тест «listens while a resumed attempt is still running»
не доходит до первой строки, потому что `startDaemon` блокируется на удержанном адаптере.

- [ ] **Шаг 3: подключить**

```ts
// вместо блока reconcile + await drainProviderDispatches() на server.ts:337-346
const worker = createSessionWorker({
  state: localState,
  adapter: providerAdapter,
  template: mockDeliveryTemplate,
  createCommandId: () => `session-${randomUUID()}`,
  logger: app.log,
});

localState.execute({/* RECONCILE_WORKFLOWS — без изменений */});
worker.wake();
```

В каждом из четырёх обработчиков `await drainProviderDispatches();` → `worker.wake();`
(`server.ts:773`, `:848`, `:924`, `:959`). Функция `drainProviderDispatches` удаляется из `server.ts` целиком.

В возвращаемом объекте:

```ts
    // Exposed for tests (spec D6): the alternative is a wait loop with a timeout in every test, and
    // on a loaded machine a timeout is indistinguishable from a defect.
    whenIdle: () => worker.whenIdle(),
    close: async () => {
      if (closing) return;
      closing = true;
      try {
        await worker.stop();
        await app.close();
      } finally {
        localState.close();
      }
    },
```

`worker.stop()` до `app.close()`: живая сессия должна получить просьбу остановиться прежде, чем сервер начнёт
закрывать соединения.

- [ ] **Шаг 4: пройти по всем существующим тестам демона**

Каждый тест, который сегодня драйвит стадию через HTTP и затем читает состояние, получает `await
daemon.whenIdle()` между мутацией и чтением. Найти их: `grep -n "pipeline/start\|pipeline/resume\|budget-override\|/answer" apps/daemon/test/*.test.ts` — девять мест.

**Это ровно тот момент, где рождается пустой тест.** Тест, у которого забыли `whenIdle()`, читает состояние до
работы и проходит «потому что ничего не изменилось». Поэтому после расстановки — обязательная проверка: сломать
`runStageAttempt` (например, сделать первым оператором `return`) и убедиться, что **каждый** из девяти
краснеет. Тот, что остался зелёным, ничего не проверяет.

- [ ] **Шаг 5: запустить всё**

Команды: `pnpm --filter @loomrail/daemon test`, затем `pnpm verify`
Ожидается: PASS.

- [ ] **Шаг 6: доказательства мутацией**

1. Вернуть `await` перед проходом исполнителя на старте → падает «listens while a resumed attempt is still
   running».
2. Вернуть `await` в обработчик старта пайплайна → падает «answers a pipeline start before the stage has
   finished».
3. Убрать `await worker.stop()` из `close()` → падает «closes while an attempt is still in flight and asks it
   to abort».
4. Сломать `runStageAttempt` первым `return` → краснеют все девять переведённых тестов (список падений — в
   отчёт).

- [ ] **Шаг 7: Commit** (при наличии разрешения)

```bash
git add apps/daemon/src/server.ts apps/daemon/test/server.integration.test.ts apps/daemon/test/session.integration.test.ts
git commit -m "feat(daemon): stop holding the startup path and HTTP replies for a whole stage"
```

---

### Задача 9: браузерные тесты

**Файлы:**

- Изменить: `e2e/walking-skeleton.spec.ts`

**Интерфейсы:** потребляет всё построенное выше; ничего не производит.

**Почему это отдельная задача, а не хвост задачи 8.** Спек §9 требует просмотра **всех 26** тестов, а не
починки упавших. Все 26 сегодня проходят из-за синхронного ответа; после задачи 8 утверждения вида «кликнули и
сразу проверили» начнут проходить преждевременно, оставаясь зелёными. Журнал A1 зафиксировал этот вид ошибки
восемь раз и отдельно (R31) назвал его повторяющимся, а не случайным. Ревьюер обязан иметь возможность
отклонить эту работу отдельно от предыдущей.

- [ ] **Шаг 1: просмотреть все 26 тестов**

Для каждого выписать в отчёт: (а) ждёт ли он состояния после стадии; (б) если да, то чем — авто-ожиданием
Playwright (`expect(locator).toBeVisible()`, `toHaveText`) или утверждением, проходящим на пустой странице
(`toHaveCount(0)`, `not.toBeVisible()`, `toBeNull`). Вторая категория — подозреваемые: они проходят до того,
как что-либо отрисовалось. Особое внимание — тесту на 991 строке («shows the sessions inside a running stage
attempt…») и на 1094 («explains a non-budget hard pause…»): именно там R31 нашёл утверждение, проходившее
на пустой секции.

- [ ] **Шаг 2: исправить подозреваемых**

Каждому предпослать позитивное утверждение, устанавливающее, что панель отрисовалась, и только затем
проверять отсутствие. Формулировка правила для отчёта: **утверждение об отсутствии допустимо только после
утверждения о присутствии в том же скоупе.**

- [ ] **Шаг 3: новый тест доставки**

```ts
// Спек §9, строка e2e: работа доезжает до владельца без его участия. Ничего не кликается после
// старта -- если бы доска обновлялась только по инвалидации от мутации, тест бы не прошёл.
test("brings a finished stage to the board without the owner touching anything", async ({ page }) => {
  await openWorkbench(page);
  await startDelivery(page);

  // No reload, no second click: the only thing that can move this text is the channel.
  await expect(page.getByRole("status", { name: /stage/i })).toHaveText(/REVIEW/, { timeout: 15_000 });
});
```

- [ ] **Шаг 4: тест «потеря сигнала безвредна»**

Спек §9 требует его отдельно, и задача 6 его не закрывает: там доказан механизм (`invalidateAll` при
переподключении), а не сходимость. Здесь доказывается сходимость.

```ts
// Спек D3: канал не воспроизводит пропущенное -- он рассчитывает на то, что переподключение
// перезапросит всё. Значит потеря сигналов обязана быть неотличима от их доставки, и проверять это
// надо потерей, а не рассуждением.
test("catches up on work done while the channel was down", async ({ page, context }) => {
  await openWorkbench(page);

  // Every signal emitted from here on is dropped on the floor.
  await context.route("**/api/v1/stream", async (route) => {
    await route.abort();
  });
  await startDelivery(page);
  await expect(page.getByRole("status", { name: /stage/i })).not.toHaveText(/REVIEW/);

  // The channel comes back; nothing else is clicked and nothing is reloaded.
  await context.unroute("**/api/v1/stream");
  await expect(page.getByRole("status", { name: /stage/i })).toHaveText(/REVIEW/, { timeout: 20_000 });
});
```

- [ ] **Шаг 5: запустить**

Проверить `uptime`. При load average выше ~20:
`pnpm exec playwright test --workers=1 --timeout=120000`
иначе `pnpm test:e2e`.

- [ ] **Шаг 6: доказательство мутацией**

Отключить монтирование `useEventStream` в `App.tsx` → падают «brings a finished stage to the board without
the owner touching anything» и «catches up on work done while the channel was down», и **не падает** ничего
другого. Если падает что-то ещё, значит этот тест не
единственный, кто зависит от канала, и отчёт обязан это назвать.

- [ ] **Шаг 7: Commit** (при наличии разрешения)

```bash
git add e2e/walking-skeleton.spec.ts
git commit -m "test(e2e): assert the board follows background work through the channel"
```

---

### Задача 10: документы

**Файлы:**

- Изменить: `docs/adr/0002-sqlite-state-and-audit.md`, `docs/adr/0003-loopback-session-security.md`,
  `docs/design/COMPONENT-SYSTEM.md`, `docs/security/THREAT-MODEL.md`,
  `docs/plans/06-post-phase-0-decomposition.ru.md`

**Интерфейсы:** ничего не потребляет и не производит в коде.

Дельты §10 спека, дословно:

- [ ] **Шаг 1: ADR-0002.** Строку 52 («reconnect replays from `events.sequence`») заменить на: канал везёт
      сигнал инвалидации; при подключении и переподключении клиент инвалидирует всё, чем догоняет любую работу,
      сделанную без связи; воспроизведения по `sequence` нет и оно не требуется. Оставить без изменений
      утверждение, что отказ публикации не откатывает состояние, — оно реализовано в задаче 4.

- [ ] **Шаг 2: ADR-0003.** Строки 41, 61, 75 про WebSocket upgrade перевести на SSE. Зафиксировать честно:
      same-origin GET не несёт `Origin`, поэтому защитой от чужой страницы является `sameSite: "strict"` плюс
      сессия, а сверка `Origin` выполняется, когда заголовок прислан. Добавить, что поток закрывается по
      истечении сессии.

- [ ] **Шаг 3: `COMPONENT-SYSTEM.md`.** Строки 221, 239, 243 — WebSocket → SSE; пункт «delivers only committed
      events» усилить до «кадр несёт три идентификатора и не несёт содержания».

- [ ] **Шаг 4: `THREAT-MODEL.md`.** Новая строка про поверхность канала с пятью смягчениями из §7 спека и
      ссылками на тесты, которые их проверяют (задачи 2, 3). Отдельно записать, что канал **не расширяет** угрозу
      недоверенного checkpoint, потому что текста в кадре нет по схеме, и назвать тест «carries no work item text
      on the wire» как проверку этого.

- [ ] **Шаг 5: `06-post-phase-0-decomposition.ru.md`.** Внести A1.5 в таблицу трека A и в строку порядка:
      `M7 → A1 → A1.5 → A2 → E1 → B5 + B1 → B3 + B2 → C1 → C3 → C2 → B4`. Записать, что канал доставки был
      запланирован пунктом 5 в M3 (`00-phase-0-implementation-plan.ru.md:608`), не построен, не имеет
      evidence-файла и не был закреплён ни за одним пунктом декомпозиции — то есть был потерян, а не отложен.

- [ ] **Шаг 6: проверить**

Команда: `pnpm verify` (включает `prettier --check .`, который читает и Markdown).

- [ ] **Шаг 7: Commit** (при наличии разрешения)

```bash
git add docs/adr/0002-sqlite-state-and-audit.md docs/adr/0003-loopback-session-security.md docs/design/COMPONENT-SYSTEM.md docs/security/THREAT-MODEL.md docs/plans/06-post-phase-0-decomposition.ru.md
git commit -m "docs: move the delivery channel from WebSocket to SSE and record A1.5"
```

---

## Финальная проверка перед сдачей

- [ ] `pnpm verify` зелёный
- [ ] `pnpm test:e2e` зелёный (при нагрузке — `pnpm exec playwright test --workers=1 --timeout=120000`)
- [ ] `git diff --check` чистый
- [ ] `pnpm pack:release && pnpm test:release` — **обязательно**: задача 2 добавляет маршрут, а задача 6
      обращается к нему из собранного веб-бандла; обычный `verify` не ловит расхождения путей в релизной сборке
- [ ] Каждая задача сдана с доказательством мутацией; отчёт содержит вставленную мутацию и текст падения
- [ ] `git status` сверен: изменения параллельной сессии в `apps/web/src/shell/AppFrame.tsx` и
      `apps/web/src/styles.css` не тронуты и не застейджены
