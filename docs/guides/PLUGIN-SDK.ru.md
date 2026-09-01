# Loomrail Plugin SDK v1

> Только read-only tools · [English version](PLUGIN-SDK.md)

Первый Plugin SDK намеренно узкий. Он помогает автору собрать отдельный MCP stdio process с типизированным input,
строгим manifest, фиксированными read-only annotations, ограниченным result и безопасной обработкой ошибок. В нём нет
workflow hooks, установки packages, marketplace, secrets, shell/Git и side-effect tools.

SDK публикуется внутри основного пакета:

```bash
npm install loomrail@next zod
```

Импортируйте его через `loomrail/plugin-sdk`. Не импортируйте daemon, domain или persistence packages Loomrail.

## Минимальный плагин

```ts
import {
  defineReadonlyPluginManifest,
  defineReadonlyTool,
  serveReadonlyToolPlugin,
} from "loomrail/plugin-sdk";
import { z } from "zod";

const searchDocs = defineReadonlyTool({
  name: "search_docs",
  description: "Ищет в публичной документации Acme.",
  inputSchema: z.object({ query: z.string().min(1).max(500) }),
  run: async ({ query }) => {
    const response = await fetch(`https://docs.example.com/search?q=${encodeURIComponent(query)}`);
    const text = await response.text();
    return { content: [{ type: "text", text: text.slice(0, 32_000) }] };
  },
});

const tools = [searchDocs];

export const manifest = defineReadonlyPluginManifest({
  id: "com.example.docs",
  name: "Acme docs",
  version: "1.0.0",
  description: "Read-only поиск по публичной документации Acme.",
  license: "MIT",
  entrypoint: "dist/index.js",
  permissions: {
    network: { mode: "DECLARED_HOSTS", hosts: ["docs.example.com"] },
  },
  tools,
});

serveReadonlyToolPlugin({ manifest, tools });
```

Список tools в manifest выводится из definitions. Автор не может отдельно заявить один tool, а запустить другой. MCP
annotations принадлежат SDK: каждый v1 tool read-only, non-destructive и idempotent. Network declaration включает
open-world annotation, но остаётся утверждением для проверки владельцем, а не firewall ОС.

Во время сборки запишите `manifest` как JSON и положите рядом с собранным относительным `entrypoint`. Делайте
entrypoint самодостаточным: v1 не запускает downloader или package manager во время работы.

## Проверка совместимости в Loomrail

До отдельного milestone installer/catalog локальная регистрация использует существующий маршрут
**Настройки → MCP-подключения**:

1. Соберите плагин локально и проверьте его исходники и сгенерированный manifest.
2. Создайте Proposal с абсолютным Node executable и абсолютным compiled entrypoint как отдельными argv elements.
3. Подтвердите точную C1-команду и запустите capability probe.
4. Убедитесь, что найденные tools точно совпадают с manifest.
5. Выдайте Grant только нужным Project tools. Snapshot получат новые provider sessions; текущие не изменятся.

Proposal не запускает process. Consent разрешает bounded probe, а отдельный Grant определяет, какие tool names может
вызвать provider. Manifest, успешный probe и read-only annotations не доказывают безопасность стороннего кода.

## Контракт безопасности

- Plugin process работает с полномочиями локального пользователя ОС. Loomrail не обещает OS sandbox.
- Не помещайте credentials в manifest, argv, fixture или tool result. В SDK v1 нет secret interface.
- stdout полностью принадлежит MCP. Bounded diagnostics отправляйте в stderr и самостоятельно удаляйте чувствительные
  значения.
- Exception handler превращается в generic error; raw message и stack не возвращаются клиенту.
- Через SDK плагин не может менять workflow state Loomrail. Будущее доменное расширение потребует отдельного
  validated command contract и решения владельца.
- Registry discovery, downloads, updates, signatures и rollback не входят в v1.

Нормативная граница записана в [C2 Plugin SDK v1](../plans/37-c2-plugin-sdk-spec.ru.md), а security reasoning — в
[ADR-0006](../adr/0006-read-only-tool-plugin-sdk.md) и [модели угроз](../security/THREAT-MODEL.md).
