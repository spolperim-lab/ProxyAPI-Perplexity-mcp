*[Русская версия](README.md) · English*

# perplexity-proxyapi-mcp

An MCP server for Claude (Claude Code and Claude Desktop): web search and Deep Research
through **Perplexity** (the Sonar models), reached over the **[ProxyAPI](https://proxyapi.ru)**
gateway — billed in roubles with a Russian card or SBP, no VPN required.

Every answer comes back with source links and a line about what it cost:

```
💰 Запрос: 0,42 ₽ (точно, по балансу) · модель perplexity/sonar, токены 512 → 830, 6 с · за сегодня 3,10 ₽ из 200,00 ₽ · остаток баланса 296,90 ₽
```

## Tools

| Tool | Model | When to use it | Rough price |
|---|---|---|---|
| `perplexity_search`, `mode: "quick"` | `perplexity/sonar` | A quick fact, a news check | under 1 ₽ |
| `perplexity_search`, `mode: "pro"` | `perplexity/sonar-pro` | More sources and more detail | 2–10 ₽ |
| `perplexity_search`, `mode: "reason"` | `perplexity/sonar-reasoning-pro` | Reasoning across several sources, "which one should I pick" | 2–10 ₽ |
| `perplexity_research` | `perplexity/sonar-deep-research` | A broad survey of a topic, takes minutes | 15–70 ₽ |
| `perplexity_check` | — | Status of a long request, today's spend, balance | free |

Optional search filters: `recency` (hour/day/week/month/year), `domains` (up to 20 sites,
prefix with `-` to exclude), `academic` (scholarly sources), `languages`,
`after_date` / `before_date` (MM/DD/YYYY), `max_tokens`.

## Guards against overspending

- The tool descriptions tell Claude it must ask for permission before every paid call.
- Only `perplexity/*` models are allowed; anything else is rejected in code.
- A daily spending cap, `PPLX_DAILY_BUDGET` (200 ₽ by default): a request that could
  exceed it is never sent.
- Deep Research is requested as a stream (`stream: true`). Without streaming, ProxyAPI
  cuts a long request off after roughly 300 s and returns an empty reply; an empty reply
  is treated as an error.
- Each mode has its own response-length cap — otherwise ProxyAPI demands enough balance
  to cover the model's maximum possible answer (about 130 ₽ for Deep Research).
- Every call with its tokens and cost is written to `perplexity.log`, and the daily
  totals to `spend.json`.

> ⚠️ Since 2026-09-27 Perplexity treats the Sonar API as deprecated. Requests still work,
> but the models may change. Model names can be swapped through the `PPLX_MODEL_*`
> variables without touching the code.

## Setup

### 1. Clone and install

Needs [Node.js](https://nodejs.org/) 20+.

```bash
git clone https://github.com/spolperim-lab/ProxyAPI-Perplexity-mcp.git
cd ProxyAPI-Perplexity-mcp
npm install
```

### 2. A ProxyAPI key

1. Register at [proxyapi.ru](https://proxyapi.ru) and top up the balance — 100–300 ₽ is
   plenty for testing.
2. "Ключи API" → "Создать новый ключ API". The key starts with `sk-` and is shown only once.
3. In the key's settings it is worth doing this:
   - **Available models** — select only the Perplexity models.
   - **Permissions → balance request** — enable it, so the cost of each request is exact
     (the balance difference before and after) rather than estimated from token counts.
   - **Budget** — optional, one more safety net.
4. Copy `key.env.example` to `key.env` and paste the key into the `ProxyAPI_Key` line.

One `key.env` can be shared with other MCP servers — for example
[gigachat-image-mcp](https://github.com/spolperim-lab/gigachat-image-mcp) — since each
server reads only its own line.

> ⚠️ `key.env` is a secret. Do not publish or forward it. It is already in `.gitignore`.

### 3. Connect it to Claude

Replace `C:/path/to/ProxyAPI-Perplexity-mcp` with the real path. Forward slashes work on
Windows too.

**Claude Code:**

```bash
claude mcp add perplexity --scope user -e PROXYAPI_KEY_FILE=C:/path/to/key.env -e PPLX_DAILY_BUDGET=200 -- node C:/path/to/ProxyAPI-Perplexity-mcp/index.js
```

To make Claude Code always ask for confirmation, add this to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": ["mcp__perplexity__perplexity_search", "mcp__perplexity__perplexity_research"]
  }
}
```

**Claude Desktop** — in `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

After editing, quit Claude Desktop completely (tray icon → Quit) and start it again.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PROXYAPI_KEY` / `PROXYAPI_KEY_FILE` | — | The key directly, or a path to `key.env` |
| `PROXYAPI_BASE` | `https://api.proxyapi.ru` | API address |
| `PPLX_DAILY_BUDGET` | `200` | Daily spending cap in roubles (`0` disables it) |
| `PPLX_WAIT_MS` | `60000` | How long to wait before answering "still running" |
| `PPLX_TIMEOUT_MS` | `900000` | Timeout for a single request |
| `PPLX_MODEL_QUICK` / `_PRO` / `_REASON` / `_RESEARCH` | Sonar models | Override the model of a mode |
| `PPLX_PRICES` | catalogue prices as of 2026-11-03 | JSON with prices for estimates, ₽ per 1M tokens |
| `PPLX_LOG_FILE` / `PPLX_SPEND_FILE` | next to `index.js` | Log and spend ledger |

## Docker

The `Dockerfile` in the root builds the server into a container. The key is not baked
into the image — it is passed at run time.

```bash
docker build -t proxyapi-perplexity-mcp .
docker run --rm -i   -e PROXYAPI_KEY=sk-...   -e PPLX_DAILY_BUDGET=200   proxyapi-perplexity-mcp
```

[Glama](https://glama.ai/mcp/servers/spolperim-lab/ProxyAPI-Perplexity-mcp) uses the same
file to run its automated safety and quality checks.

## License

MIT — see [LICENSE](LICENSE).
