# ── build: install everything, compile server + web UI ──────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.7.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
  && pnpm install --frozen-lockfile --prod

# ── runtime: only what the bot needs ────────────────────────────────────────
FROM node:24-bookworm-slim
WORKDIR /app
# The git commit this image was built from – shown by /api/health so deploys can verify it.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    LOG_PRETTY=true
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/drizzle ./server/drizzle
COPY --from=build /app/web/dist ./web/dist
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /app/data && chown node:node /app/data && chmod +x /usr/local/bin/entrypoint.sh
# Starts as root only to fix the data folder's ownership, then runs the bot as "node".
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
WORKDIR /app/server
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
