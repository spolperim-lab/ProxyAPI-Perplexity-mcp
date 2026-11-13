*Русский · [English](README.en.md)*

# perplexity-proxyapi-mcp

MCP-сервер для Claude (Claude Code и Claude Desktop): поиск в интернете и Deep Research через **Perplexity** (модели Sonar) по API **[ProxyAPI](https://proxyapi.ru)** — оплата в рублях российской картой или СБП, без VPN.

Каждый ответ приходит со ссылками на источники и строкой о стоимости:

```
💰 Запрос: 0,42 ₽ (точно, по балансу) · модель perplexity/sonar, токены 512 → 830, 6 с · за сегодня 3,10 ₽ из 200,00 ₽ · остаток баланса 296,90 ₽
```

## Инструменты

| Инструмент | Модель | Когда | Цена (оценка) |
|---|---|---|---|
| `perplexity_search`, `mode: "quick"` | `perplexity/sonar` | Быстрый факт, новость, проверка | меньше 1 ₽ |
| `perplexity_search`, `mode: "pro"` | `perplexity/sonar-pro` | Больше источников и подробностей | 2–10 ₽ |
| `perplexity_search`, `mode: "reason"` | `perplexity/sonar-reasoning-pro` | Вывод из нескольких источников, «что выбрать» | 2–10 ₽ |
| `perplexity_research` | `perplexity/sonar-deep-research` | Большой обзор темы (минуты) | 15–70 ₽ |
| `perplexity_check` | — | Статус долгого запроса, расходы за день, баланс | бесплатно |

Фильтры поиска (необязательные): `recency` (hour/day/week/month/year), `domains` (до 20 сайтов, исключение через `-`), `academic` (научные источники), `languages`, `after_date` / `before_date` (ММ/ДД/ГГГГ), `max_tokens`.

Защита от лишних трат:
- в описании инструментов прописано, что Claude обязан спросить разрешение перед каждым платным вызовом;
- работают только модели `perplexity/*` — другие запрещены в коде;
- дневной лимит расходов `PPLX_DAILY_BUDGET` (по умолчанию 200 ₽): запрос, который может его превысить, не отправляется;
- Deep Research запрашивается потоком (`stream: true`): без него ProxyAPI обрывает долгий запрос примерно через 300 с и возвращает пустой ответ; пустой ответ считается ошибкой;
- у каждого режима свой лимит длины ответа — иначе ProxyAPI требует на балансе запас под максимальный ответ модели (для Deep Research это ~130 ₽);
- все вызовы с токенами и стоимостью пишутся в `perplexity.log`, расходы по дням — в `spend.json`.

> ⚠️ Perplexity с 27.09.2026 считает API Sonar устаревшим: запросы пока работают, но модели могут смениться. Названия моделей можно поменять переменными `PPLX_MODEL_*` без правки кода.

## Установка

### 1. Скачать и установить зависимости

Нужен [Node.js](https://nodejs.org/) 20+.

```bash
git clone https://github.com/spolperim-lab/ProxyAPI-Perplexity-mcp.git
cd ProxyAPI-Perplexity-mcp
npm install
```

### 2. Ключ ProxyAPI

1. Зарегистрируйтесь на [proxyapi.ru](https://proxyapi.ru) и пополните баланс (100–300 ₽ хватит на тесты).
2. «Ключи API» → «Создать новый ключ API» (ключ начинается с `sk-`, показывается один раз).
3. В настройках ключа рекомендуется:
   - **Доступные модели** — выбрать только модели Perplexity;
   - **Разрешения → «Запрос баланса»** — включить, тогда стоимость каждого запроса будет точной (разница баланса до и после), а не оценкой по токенам;
   - **Бюджет** — по желанию, ещё один предохранитель.
4. Скопируйте `key.env.example` в `key.env` и вставьте ключ в строку `ProxyAPI_Key`.

Один `key.env` можно делить с другими MCP (например, с [gigachat-image-mcp](https://github.com/spolperim-lab/gigachat-image-mcp)): каждый сервер читает только свою строку.

> ⚠️ `key.env` — секрет. Не выкладывайте его и не пересылайте. Он уже в `.gitignore`.

### 3. Подключить к Claude

Замените `C:/path/to/ProxyAPI-Perplexity-mcp` на реальный путь (прямые слэши работают и в Windows).

**Claude Code:**

```bash
claude mcp add perplexity --scope user -e PROXYAPI_KEY_FILE=C:/path/to/key.env -e PPLX_DAILY_BUDGET=200 -- node C:/path/to/ProxyAPI-Perplexity-mcp/index.js
```

Чтобы Claude Code всегда спрашивал подтверждение, добавьте в `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": ["mcp__perplexity__perplexity_search", "mcp__perplexity__perplexity_research"]
  }
}
```

**Claude Desktop** — в `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "perplexity": {
      "command": "node",
      "args": ["C:/path/to/ProxyAPI-Perplexity-mcp/index.js"],
      "env": {
        "PROXYAPI_KEY_FILE": "C:/path/to/key.env",
        "PPLX_DAILY_BUDGET": "200"
      }
    }
  }
}
```

После правки полностью перезапустите Claude Desktop (значок в трее → «Выйти»).

## Настройки

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PROXYAPI_KEY` / `PROXYAPI_KEY_FILE` | — | Ключ напрямую или путь к `key.env` |
| `PROXYAPI_BASE` | `https://api.proxyapi.ru` | Адрес API |
| `PPLX_DAILY_BUDGET` | `200` | Лимит расходов за сутки, ₽ (`0` — без лимита) |
| `PPLX_WAIT_MS` | `60000` | Сколько ждать ответ до «ещё выполняется» |
| `PPLX_TIMEOUT_MS` | `900000` | Таймаут одного запроса |
| `PPLX_MODEL_QUICK` / `_PRO` / `_REASON` / `_RESEARCH` | модели Sonar | Заменить модель режима |
| `PPLX_PRICES` | цены каталога на 03.11.2026 | JSON с ценами для оценки, ₽ за 1М токенов |
| `PPLX_LOG_FILE` / `PPLX_SPEND_FILE` | рядом с `index.js` | Лог и учёт расходов |

## Docker

`Dockerfile` в корне собирает сервер в контейнер. Ключ в образ не зашивается —
он передаётся при запуске.

```bash
docker build -t proxyapi-perplexity-mcp .
docker run --rm -i   -e PROXYAPI_KEY=sk-...   -e PPLX_DAILY_BUDGET=200   proxyapi-perplexity-mcp
```

Этим же файлом [Glama](https://glama.ai/mcp/servers/spolperim-lab/ProxyAPI-Perplexity-mcp)
прогоняет автоматические проверки безопасности и качества.

## Лицензия

MIT — см. [LICENSE](LICENSE).
