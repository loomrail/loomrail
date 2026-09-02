# QA в браузере

> [English version](BROWSER-QA.md) · [Руководство владельца](USER-GUIDE.ru.md)

Результат QA определяет Loomrail, а не выбранный ИИ-провайдер. На стадии QA локальный daemon открывает новый
изолированный Chromium-контекст, выполняет ограниченный декларативный план и сохраняет точное Git-дерево, среду
браузера, результаты сценариев, снимки экрана, трассировки, наблюдения консоли и сети, а также дефекты. Сообщение
провайдера «страница работает» не может перевести процесс к приёмке.

## Встроенный demo-проект

После однократного `npx playwright install chromium` для **Fixture web application** не нужна дополнительная команда
запуска target. Его mock-реализация намеренно не меняет приложение,
поэтому встроенный QA-план проверяет публичный readiness endpoint Loomrail на фактическом локальном порту. Так можно
пройти весь маршрут доказательств и приёмки, не запуская Codex, Claude Code или второй dev server.

## Настройка web-репозитория

Для своего проекта запустите приложение на loopback-адресе и добавьте в репозиторий файл
`.loomrail/browser-qa.json`. Loomrail не угадывает и не запускает команды `dev`, `npm` или shell: у проектов разные
команды и порты, а автоматический запуск без отдельно подтверждённого контракта незаметно выдал бы право на исполнение.

Минимальный пример:

```json
{
  "schemaVersion": 1,
  "targetOrigin": "http://127.0.0.1:4173",
  "revision": 1,
  "targets": [
    {
      "id": "desktop-light-en",
      "viewport": { "width": 1280, "height": 800 },
      "locale": "en-US",
      "theme": "LIGHT"
    },
    {
      "id": "mobile-dark-ru",
      "viewport": { "width": 320, "height": 720 },
      "locale": "ru-RU",
      "theme": "DARK"
    }
  ],
  "scenarios": [
    {
      "id": "home",
      "title": "Главная открывается без переполнения",
      "steps": [
        {
          "id": "open-home",
          "title": "Открыть главную",
          "action": { "type": "NAVIGATE", "path": "/" }
        }
      ],
      "assertions": [
        {
          "id": "home-path",
          "title": "Открыт путь главной",
          "rule": { "type": "URL_PATH", "path": "/" }
        },
        {
          "id": "no-overflow",
          "title": "Нет горизонтального переполнения",
          "rule": { "type": "NO_HORIZONTAL_OVERFLOW" }
        }
      ]
    }
  ]
}
```

`targetOrigin` должен быть буквальным локальным HTTP(S) origin: `127.x.x.x`, `localhost` или `[::1]`. Перед запуском
Chromium имя `localhost` обязано разрешаться только в loopback-адреса и на время run закрепляется за одним проверенным
адресом. В `NAVIGATE` указываются только пути; переходы и redirects на внешние origin блокируются. Доступны шаги `NAVIGATE`, `CLICK` и `PRESS` с
семантическим locator, а также `WAIT_FOR_IDLE`. Проверки: `VISIBLE`, `TEXT_CONTAINS`, `URL_PATH`,
`NO_HORIZONTAL_OVERFLOW` и `FOCUSED`. CSS selectors, XPath, произвольный JavaScript, downloads, dialogs, изменяющие
запросы и авторизованный browser profile в этот baseline не входят.

Увеличивайте `revision`, когда меняется смысл плана. Daemon сам вычисляет и сохраняет неизменяемый hash содержимого,
поэтому Task Cockpit показывает, какая точная версия плана создала доказательства.

## Запуск и проверка

1. Запустите проект на указанном loopback origin.
2. Обычным способом запустите или продолжите процесс Loomrail; environment variable провайдера не нужна.
3. После Review откройте задачу. Блок **QA в браузере** показывает проверенное дерево, адрес, browser/runtime, каждую
   пару target/scenario, ошибки, наблюдения, дефекты и файлы проверки.
4. Откройте снимок в браузере или скачайте Playwright trace. Авторизованный маршрут перед отправкой сверяет размер и
   SHA-256 файла и никогда не раскрывает абсолютный путь.

Непройденная проверка или блокирующая ошибка консоли/сети создаёт evidence `FAILED` и долговечный дефект. Отсутствующий
или невалидный config, недоступный target, запрещённый origin, небезопасное действие, timeout или падение driver дают
`ERROR`. Ни один из этих результатов не открывает приёмку. Исправьте указанную причину, оставьте target запущенным и
используйте предложенное повторное действие.

Тяжёлые файлы хранятся в data directory Loomrail, вне репозитория и SQLite. Loomrail сохраняет retention class
`STANDARD_30_DAYS` и удаляет screenshot/trace через 30 дней после последнего перехода работы в
`DONE` или `CANCELLED`. Очистка идёт bounded batches при запуске daemon, записывает append-only результат и удаляет
только точные пути из durable attachment refs. Она не делает recursive delete, не следует symlink, не трогает run с
recovery marker и сохраняет неизвестные соседние файлы. Пользовательского экрана retention/cleanup в этой pre-alpha
пока нет.
