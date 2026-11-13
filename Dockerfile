# Образ для запуска сервера в контейнере.
# Этим же файлом Glama прогоняет автоматические проверки
# безопасности и качества (вставляется в Admin -> Dockerfile).
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 || npm install --omit=dev --no-audit --no-fund

COPY . .

# Лог вызовов и учёт расходов пишутся рядом с index.js
ENV PPLX_LOG_FILE=/app/perplexity.log
ENV PPLX_SPEND_FILE=/app/spend.json

# Ключ не зашивается в образ: он передаётся через
# PROXYAPI_KEY или PROXYAPI_KEY_FILE при запуске.
# Без ключа сервер всё равно стартует и отдаёт список инструментов.
CMD ["node", "index.js"]
