FROM node:20-slim AS base

# --- deps ---
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# --- build ---
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# データと LLM 接続は環境変数で外出し:
#   DATA_DIR              … 永続データの保存先(既定: /app/data)
#   ANTHROPIC_API_KEY     … Anthropic API キー(直接接続時)
#   CLAUDE_CODE_USE_BEDROCK=1 + AWS 認証情報 … Bedrock 経由
#   CONTEXT_WINDOW_TOKENS … コンテキストウィンドウ上限(既定: 200000)

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

RUN mkdir -p /app/data && chown nextjs:nodejs /app/data
VOLUME /app/data

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
