#!/usr/bin/env node
// MCP-сервер: поиск в интернете через Perplexity (модели Sonar) по API ProxyAPI.
// Отвечает текстом со ссылками на источники и в конце каждого ответа пишет,
// сколько стоил запрос и сколько потрачено за день.
//
// Как работает:
//   perplexity_search / perplexity_research запускают задачу и ждут ответ не дольше PPLX_WAIT_MS.
//   Успела — ответ сразу. Не успела — возвращается job_id, а запрос продолжается в фоне;
//   статус проверяется бесплатным инструментом perplexity_check.
//   Разрешены только модели perplexity/*. Каждый вызов пишется в лог, расходы за день — в spend.json.
//
// Стоимость запроса:
//   если у ключа включено разрешение «Запрос баланса», берётся точная разница баланса до и после;
//   иначе — оценка по токенам из ответа и ценам каталога ProxyAPI (PPLX_PRICES).
//
// Переменные окружения:
//   PROXYAPI_KEY         — ключ ProxyAPI напрямую
//   PROXYAPI_KEY_FILE    — либо путь к файлу со строкой "ProxyAPI_Key = ..."
//   PROXYAPI_BASE        — по умолчанию https://api.proxyapi.ru
//   PPLX_DAILY_BUDGET    — лимит расходов в рублях за сутки (по умолчанию 200, 0 — без лимита)
//   PPLX_WAIT_MS         — сколько ждать ответ до «ещё идёт» (по умолчанию 60000)
//   PPLX_TIMEOUT_MS      — таймаут одного запроса (по умолчанию 900000 — Deep Research бывает долгим)
//   PPLX_LOG_FILE        — лог вызовов (по умолчанию perplexity.log рядом с index.js)
//   PPLX_SPEND_FILE      — учёт расходов по дням (по умолчанию spend.json рядом с index.js)
//   PPLX_MODEL_QUICK / _PRO / _REASON / _RESEARCH — переопределить модели режимов
//   PPLX_PRICES          — JSON с ценами {"perplexity/sonar": {"in": 136.84, "out": 136.84}, ...} в ₽ за 1М токенов

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = (process.env.PROXYAPI_BASE || "https://api.proxyapi.ru").replace(/\/$/, "");
const DAILY_BUDGET = process.env.PPLX_DAILY_BUDGET === undefined ? 200 : Number(process.env.PPLX_DAILY_BUDGET);
const WAIT_MS = Number(process.env.PPLX_WAIT_MS) || 60_000;
const TIMEOUT_MS = Number(process.env.PPLX_TIMEOUT_MS) || 900_000;
const LOG_FILE = path.resolve(process.env.PPLX_LOG_FILE || path.join(SCRIPT_DIR, "perplexity.log"));
const SPEND_FILE = path.resolve(process.env.PPLX_SPEND_FILE || path.join(SCRIPT_DIR, "spend.json"));

// Режимы: какая модель и какой лимит длины ответа (лимит нужен ещё и для предварительной
// проверки баланса в ProxyAPI — без него он требует запас на максимальный ответ модели).
const MODES = {
  quick: { model: process.env.PPLX_MODEL_QUICK || "perplexity/sonar", maxTokens: 1500, label: "быстрый поиск" },
  pro: { model: process.env.PPLX_MODEL_PRO || "perplexity/sonar-pro", maxTokens: 4000, label: "поиск Pro" },
  reason: {
    model: process.env.PPLX_MODEL_REASON || "perplexity/sonar-reasoning-pro",
    maxTokens: 4000,
    label: "поиск с рассуждением",
  },
  research: {
    model: process.env.PPLX_MODEL_RESEARCH || "perplexity/sonar-deep-research",
    maxTokens: 25000,
    label: "Deep Research",
    // Потоком: ProxyAPI обрывает «молчащий» запрос примерно через 300 с, а поток держит соединение живым.
    stream: true,
  },
};

// Цены каталога ProxyAPI на 03.11.2026, ₽ за 1М токенов с НДС. Используются только для оценки.
const PRICES = {
  "perplexity/sonar": { in: 136.84, out: 136.84 },
  "perplexity/sonar-pro": { in: 410.53, out: 2105.26 },
  "perplexity/sonar-reasoning-pro": { in: 273.68, out: 1157.89 },
  "perplexity/sonar-deep-research": { in: 273.68, out: 1157.89 },
  ...(process.env.PPLX_PRICES ? JSON.parse(process.env.PPLX_PRICES) : {}),
};

const rub = (n) => `${n.toFixed(2).replace(".", ",")} ₽`;

// ---------- лог и учёт расходов ----------

function log(entry) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    // лог не должен ломать запросы
  }
}

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD по местному времени

function readSpend() {
  try {
    return JSON.parse(readFileSync(SPEND_FILE, "utf8"));
  } catch {
    return {};
  }
}

function spentToday() {
  return readSpend()[today()] || 0;
}

function addSpend(amount) {
  const spend = readSpend();
  spend[today()] = Math.round(((spend[today()] || 0) + amount) * 100) / 100;
  try {
    writeFileSync(SPEND_FILE, JSON.stringify(spend, null, 2), "utf8");
  } catch {
    // учёт не должен ломать запросы
  }
}

// ---------- API ----------

function readKey() {
  if (process.env.PROXYAPI_KEY) return process.env.PROXYAPI_KEY.trim();
  const file = process.env.PROXYAPI_KEY_FILE;
  if (!file) throw new Error("Не задан PROXYAPI_KEY или PROXYAPI_KEY_FILE");
  const match = readFileSync(file, "utf8").match(/^\s*ProxyAPI_Key\s*=\s*(\S+)/m);
  if (!match) throw new Error(`В файле ${file} не найдена строка "ProxyAPI_Key = ..."`);
  return match[1];
}

async function request(pathname, init = {}, timeout = TIMEOUT_MS) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${readKey()}`, Accept: "application/json", ...init.headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const body = await res.text();
    const hints = {
      401: "Неверный ключ ProxyAPI.",
      402: "Не хватает денег на балансе или исчерпан бюджет ключа (баланс проверяется с запасом на максимальную длину ответа).",
      403: "Модель не разрешена для этого ключа или IP не в белом списке.",
      429: "Слишком много запросов, попробуйте позже.",
    };
    throw new Error(`ProxyAPI ${pathname}: HTTP ${res.status}. ${hints[res.status] || ""} ${body}`.trim());
  }
  return res;
}

async function api(pathname, init, timeout) {
  return (await request(pathname, init, timeout)).json();
}

// Читает ответ в формате SSE (stream: true) и собирает его в тот же вид, что и обычный ответ:
// текст — из кусочков delta.content, источники и usage — из последних кусочков, где они есть.
async function readStream(res) {
  const data = { choices: [{ message: { content: "" } }] };
  const message = data.choices[0].message;
  const decoder = new TextDecoder();
  let buffer = "";

  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const chunk = JSON.parse(payload);
    if (chunk.error) throw new Error(`ProxyAPI прервал поток: ${JSON.stringify(chunk.error)}`);
    const choice = chunk.choices?.[0] || {};
    if (choice.delta?.content) message.content += choice.delta.content;
    else if (choice.message?.content && !message.content) message.content = choice.message.content;
    for (const src of [choice.delta, choice.message]) {
      if (src?.annotations?.length) message.annotations = src.annotations;
    }
    if (choice.finish_reason) data.choices[0].finish_reason = choice.finish_reason;
    for (const key of ["model", "usage", "citations", "search_results"]) {
      if (chunk[key] && (!Array.isArray(chunk[key]) || chunk[key].length)) data[key] = chunk[key];
    }
  };

  for await (const part of res.body) {
    buffer += decoder.decode(part, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(handle);
  }
  handle(buffer + decoder.decode());
  return data;
}

// Баланс доступен, только если в настройках ключа включено разрешение «Запрос баланса».
async function getBalance() {
  try {
    const data = await api("/proxyapi/balance", {}, 15_000);
    return typeof data.balance === "number" ? data.balance : null;
  } catch {
    return null;
  }
}

// ---------- запрос к Perplexity ----------

function buildBody({ query, mode, recency, domains, academic, languages, after_date, before_date, max_tokens }) {
  const cfg = MODES[mode];
  if (!cfg.model.startsWith("perplexity/")) {
    throw new Error(`Модель ${cfg.model} запрещена: этот MCP работает только с моделями perplexity/*`);
  }
  const body = {
    model: cfg.model,
    messages: [
      {
        role: "system",
        content:
          "Отвечай на языке вопроса. Опирайся на найденные источники и ставь ссылки вида [1], [2]. " +
          "Если данных нет или они противоречат друг другу — так и скажи.",
      },
      { role: "user", content: query },
    ],
    max_tokens: max_tokens || cfg.maxTokens,
  };
  if (cfg.stream) body.stream = true;
  // Фильтры поиска Perplexity — передаются только если заданы.
  if (recency) body.search_recency_filter = recency;
  if (domains?.length) body.search_domain_filter = domains;
  if (academic) body.search_mode = "academic";
  if (languages?.length) body.search_language_filter = languages;
  if (after_date) body.search_after_date_filter = after_date;
  if (before_date) body.search_before_date_filter = before_date;
  return body;
}

// Полный список источников в порядке выдачи: номер в списке = метка [n] в тексте.
// Порядок поиска: search_results → citations → message.annotations (так их отдаёт ProxyAPI).
function extractSources(data) {
  const message = data.choices?.[0]?.message || {};
  let list = [];
  const results = data.search_results || message.search_results;
  const citations = data.citations || message.citations;
  if (Array.isArray(results) && results.length) {
    list = results.map((r) => ({ title: r.title, url: r.url, date: r.date }));
  } else if (Array.isArray(citations) && citations.length) {
    list = citations.map((url) => ({ url }));
  } else if (Array.isArray(message.annotations)) {
    list = message.annotations
      .filter((a) => a.type === "url_citation" && a.url_citation?.url)
      .map((a) => ({ title: a.url_citation.title, url: a.url_citation.url }));
  }
  // Номер присваивается до удаления дублей, чтобы не сбить соответствие меткам в тексте.
  const seen = new Set();
  return list
    .map((s, i) => ({ ...s, n: i + 1 }))
    .filter((s) => s.url && !seen.has(s.url) && seen.add(s.url));
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function estimateCost(model, usage = {}) {
  const price = PRICES[model];
  if (!price) return null;
  const input = usage.prompt_tokens || 0;
  const output = usage.completion_tokens || 0;
  return (input * price.in + output * price.out) / 1_000_000;
}

let running = 0; // сколько платных запросов идёт сейчас — при нескольких разница баланса неточна

async function runQuery(args) {
  const body = buildBody(args);
  running++;
  const balanceBefore = await getBalance();
  try {
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const data = body.stream
      ? await readStream(
          await request("/v1/chat/completions", { ...init, headers: { ...init.headers, Accept: "text/event-stream" } }),
        )
      : await api("/v1/chat/completions", init);
    const balanceAfter = await getBalance();

    const estimate = estimateCost(body.model, data.usage);
    const exact =
      balanceBefore !== null && balanceAfter !== null && running === 1
        ? Math.max(0, Math.round((balanceBefore - balanceAfter) * 100) / 100)
        : null;
    const cost = exact ?? estimate ?? 0;
    addSpend(cost);

    const text = (data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // ProxyAPI может закрыть долгий запрос (~300 с) и вернуть HTTP 200 без ответа — это ошибка, а не успех.
    if (!text) {
      throw new Error(
        `ProxyAPI вернул пустой ответ (списано ${rub(cost)}). Ответ сервера: ${JSON.stringify(data).slice(0, 1000)}`,
      );
    }
    return {
      text,
      sources: extractSources(data),
      model: data.model || body.model,
      usage: data.usage || {},
      cost: { exact, estimate, charged: cost, balance: balanceAfter },
      finishReason: data.choices?.[0]?.finish_reason,
    };
  } finally {
    running--;
  }
}

// ---------- задачи ----------

const jobs = new Map(); // job_id -> задача (живут, пока работает сервер)
const seconds = (job) => Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);

function checkBudget(mode, max_tokens) {
  if (!DAILY_BUDGET) return;
  const cfg = MODES[mode];
  const price = PRICES[cfg.model];
  const worst = price ? ((max_tokens || cfg.maxTokens) * price.out) / 1_000_000 : 0;
  const spent = spentToday();
  if (spent + worst > DAILY_BUDGET) {
    throw new Error(
      `Дневной лимит: потрачено ${rub(spent)} из ${rub(DAILY_BUDGET)}, а запрос в режиме «${cfg.label}» ` +
        `может стоить до ${rub(worst)}. Увеличьте PPLX_DAILY_BUDGET или подождите до завтра.`,
    );
  }
}

function startJob(args) {
  checkBudget(args.mode, args.max_tokens);
  const id = randomUUID().slice(0, 8);
  const job = { id, status: "running", mode: args.mode, query: args.query, startedAt: Date.now() };
  jobs.set(id, job);
  log({ event: "start", job: id, mode: args.mode, model: MODES[args.mode].model, query: args.query });

  job.promise = runQuery(args).then(
    (result) => {
      Object.assign(job, { status: "done", result, finishedAt: Date.now() });
      log({
        event: "done",
        job: id,
        seconds: seconds(job),
        model: result.model,
        usage: result.usage,
        cost: result.cost,
        sources: result.sources.length,
      });
    },
    (err) => {
      Object.assign(job, { status: "error", error: String(err?.message || err), finishedAt: Date.now() });
      log({ event: "error", job: id, seconds: seconds(job), error: job.error });
    },
  );
  return job;
}

function costLine(job) {
  const { cost, usage, model } = job.result;
  const amount =
    cost.exact !== null
      ? `${rub(cost.exact)} (точно, по балансу)`
      : cost.estimate !== null
        ? `≈ ${rub(cost.estimate)} (оценка по токенам; для точной суммы включите ключу разрешение «Запрос баланса»)`
        : "неизвестно (нет цены для модели в PPLX_PRICES)";
  const parts = [
    `💰 Запрос: ${amount}`,
    `модель ${model}, токены ${usage.prompt_tokens ?? "?"} → ${usage.completion_tokens ?? "?"}, ${seconds(job)} с`,
    `за сегодня ${rub(spentToday())}${DAILY_BUDGET ? ` из ${rub(DAILY_BUDGET)}` : ""}`,
  ];
  if (cost.balance !== null) parts.push(`остаток баланса ${rub(cost.balance)}`);
  return parts.join(" · ");
}

function jobResult(job) {
  if (job.status === "done") {
    const { text, sources, finishReason } = job.result;
    const sourceList = sources.length
      ? "\n\nИсточники:\n" +
        sources.map((s) => `[${s.n}] ${s.title || domainOf(s.url)} — ${s.url}${s.date ? ` (${s.date})` : ""}`).join("\n")
      : "";
    const cut = finishReason === "length" ? "\n\n⚠️ Ответ обрезан лимитом длины — можно повторить с большим max_tokens." : "";
    return { content: [{ type: "text", text: `${text}${sourceList}${cut}\n\n${costLine(job)}` }] };
  }
  if (job.status === "error") {
    return {
      isError: true,
      content: [{ type: "text", text: `Ошибка (задача ${job.id}, ${seconds(job)} с): ${job.error}` }],
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Запрос ещё выполняется (${seconds(job)} с, режим «${MODES[job.mode].label}»). Задача: ${job.id}.\n` +
          `Проверить — инструмент perplexity_check с job_id="${job.id}". Он бесплатный; ` +
          `повторно запускать поиск не нужно, иначе деньги спишутся второй раз.`,
      },
    ],
  };
}

async function runTool(args) {
  try {
    const job = startJob(args);
    await Promise.race([job.promise, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
    return jobResult(job);
  } catch (err) {
    log({ event: "error", error: String(err?.message || err), query: args.query });
    return { isError: true, content: [{ type: "text", text: String(err?.message || err) }] };
  }
}

// ---------- MCP ----------

const filterSchema = {
  recency: z
    .enum(["hour", "day", "week", "month", "year"])
    .optional()
    .describe("Только свежие источники: за последний час/день/неделю/месяц/год"),
  domains: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Искать только на этих сайтах ["habr.com"] или исключить сайты через минус ["-pinterest.com"]. Не смешивать'),
  academic: z.boolean().optional().describe("Искать по научным публикациям (с ним фильтры по датам не работают)"),
  languages: z.array(z.string()).max(10).optional().describe('Языки источников, коды ISO 639-1: ["ru", "en"]'),
  after_date: z.string().optional().describe("Только опубликованное после даты, формат ММ/ДД/ГГГГ"),
  before_date: z.string().optional().describe("Только опубликованное до даты, формат ММ/ДД/ГГГГ"),
  max_tokens: z.number().int().positive().optional().describe("Лимит длины ответа (по умолчанию зависит от режима)"),
};

const paidNote =
  "ВАЖНО: каждый вызов платный (списывается с баланса ProxyAPI пользователя). " +
  "Перед вызовом обязательно спроси разрешение, показав вопрос, режим и примерную цену, " +
  "и вызывай только после явного согласия. В конце ответа инструмент сам пишет фактическую стоимость — передай её пользователю.";

const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const server = new McpServer({ name: "perplexity", version: "1.0.0" });

server.registerTool(
  "perplexity_search",
  {
    title: "Поиск в интернете (Perplexity)",
    description:
      "Ищет ответ в интернете через Perplexity и возвращает текст со ссылками на источники и стоимость запроса. " +
      "Режимы: quick — быстрый факт, новость, проверка «так ли это» (perplexity/sonar, обычно меньше 1 ₽); " +
      "pro — нужно больше источников и подробностей, сравнение вариантов (perplexity/sonar-pro, ~2–10 ₽); " +
      "reason — нужен вывод из нескольких источников, «почему», «что выбрать» (perplexity/sonar-reasoning-pro, ~2–10 ₽). " +
      "Для большого обзора темы используй perplexity_research. По умолчанию quick. " +
      "Используй, когда нужна свежая или проверяемая информация из сети, а не общие знания. " +
      paidNote,
    annotations,
    inputSchema: {
      query: z.string().min(1).describe("Вопрос для поиска — лучше полной фразой и с контекстом"),
      mode: z.enum(["quick", "pro", "reason"]).default("quick").describe("Режим поиска"),
      ...filterSchema,
    },
  },
  (args) => runTool({ ...args, mode: args.mode || "quick" }),
);

server.registerTool(
  "perplexity_research",
  {
    title: "Deep Research (Perplexity)",
    description:
      "Глубокое исследование темы через Perplexity Deep Research (perplexity/sonar-deep-research): десятки источников, " +
      "развёрнутый отчёт со ссылками. Идёт от одной до нескольких минут и стоит ~15–70 ₽. " +
      `Если не уложится в ${Math.round(WAIT_MS / 1000)} с, вернёт job_id — тогда проверяй через perplexity_check, не запуская заново. ` +
      "Используй только для больших обзоров (литература, рынок, сравнение множества вариантов), для простых вопросов — perplexity_search. " +
      paidNote,
    annotations,
    inputSchema: {
      query: z.string().min(1).describe("Тема исследования: что именно выяснить, для чего, какие аспекты важны"),
      ...filterSchema,
    },
  },
  (args) => runTool({ ...args, mode: "research" }),
);

server.registerTool(
  "perplexity_check",
  {
    title: "Статус запроса и расходы Perplexity",
    description:
      "Бесплатно (без обращения к модели) показывает статус запроса по job_id: идёт, готово (с ответом) или ошибка. " +
      "Без job_id — список последних запросов, расходы за сегодня и остаток баланса. Разрешение пользователя не нужно.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { job_id: z.string().optional().describe("Номер задачи из ответа perplexity_search / perplexity_research") },
  },
  async ({ job_id }) => {
    if (job_id) {
      const job = jobs.get(job_id.trim());
      if (job) return jobResult(job);
      return {
        isError: true,
        content: [
          { type: "text", text: `Задача ${job_id} не найдена — вероятно, сервер перезапускался. История — в логе: ${LOG_FILE}` },
        ],
      };
    }
    const recent = [...jobs.values()].slice(-10).reverse();
    const lines = recent.map(
      (j) =>
        `${j.id} — ${j.status === "done" ? "готово" : j.status === "error" ? "ошибка" : "идёт"} ` +
        `(${MODES[j.mode].label}, ${seconds(j)} с${j.status === "done" ? `, ${rub(j.result.cost.charged)}` : ""}): ${j.query.slice(0, 80)}`,
    );
    const balance = await getBalance();
    return {
      content: [
        {
          type: "text",
          text:
            (lines.length ? lines.join("\n") : "С момента запуска сервера запросов не было.") +
            `\n\nЗа сегодня потрачено ${rub(spentToday())}${DAILY_BUDGET ? ` из ${rub(DAILY_BUDGET)}` : ""}.` +
            (balance !== null ? ` Остаток баланса ProxyAPI: ${rub(balance)}.` : "") +
            `\nЛог: ${LOG_FILE}`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
