#!/usr/bin/env bash
# Runs ON THE SERVER (called by GitHub Actions, or by hand): deploy commit $1.
#   1. build the new image while the current bot keeps running
#   2. switch over – the old bot finishes copies in progress first (safe restart)
#   3. wait until the new bot is healthy AND reports the new version
#   4. if not: roll back to the previous version automatically
# Every result is sent to Telegram.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/copy-wallet}"
cd "$APP_DIR"
TARGET="${1:?usage: remote-deploy.sh <commit>}"

env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
PORT="$(env_value PORT)"; PORT="${PORT:-8787}"
TG_TOKEN="$(env_value TELEGRAM_BOT_TOKEN)"
TG_CHAT="$(env_value TELEGRAM_CHAT_ID)"
notify() {
  echo "$1"
  if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
    curl -s -m 10 -o /dev/null "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_CHAT}" --data-urlencode "text=$1" || true
  fi
}

wait_healthy() { # $1 = expected version
  for _ in $(seq 1 60); do
    if curl -fs -m 3 "http://127.0.0.1:${PORT}/api/health" | grep -q "\"version\":\"$1\""; then return 0; fi
    sleep 3
  done
  return 1
}

git fetch --quiet origin
SHA="$(git rev-parse --short "$TARGET")"
SUBJECT="$(git log -1 --format=%s "$TARGET")"
PREV="$(cat .deployed 2>/dev/null || true)"

if [ "$SHA" = "$PREV" ] && curl -fs -m 3 "http://127.0.0.1:${PORT}/api/health" | grep -q "\"version\":\"$SHA\""; then
  echo "Already running $SHA – nothing to do."
  exit 0
fi

echo "Deploying $SHA ($SUBJECT), currently running: ${PREV:-none}"
git checkout --quiet --force "$TARGET"

# 1. Build first – the running bot is untouched if the build fails.
if ! GIT_SHA="$SHA" docker compose build; then
  notify "❌ Deploy of $SHA failed to build – still running ${PREV:-the previous version}. ($SUBJECT)"
  [ -n "$PREV" ] && git checkout --quiet --force "$PREV"
  exit 1
fi

# 2. Switch over (safe restart), 3. verify.
GIT_SHA="$SHA" docker compose up -d
if wait_healthy "$SHA"; then
  echo "$SHA" > .deployed
  # Keep the 3 newest images for quick rollbacks.
  docker image ls copy-wallet --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' | sort -r | tail -n +4 | cut -f2 | xargs -r docker image rm >/dev/null 2>&1 || true
  notify "🚀 Deployed $SHA – $SUBJECT"
  exit 0
fi

# 4. Roll back.
docker compose logs --tail 40 bot || true
if [ -n "$PREV" ]; then
  git checkout --quiet --force "$PREV"
  GIT_SHA="$PREV" docker compose up -d
  if wait_healthy "$PREV"; then
    notify "⚠️ Deploy of $SHA failed its health check – rolled back to $PREV. ($SUBJECT)"
  else
    notify "🚨 Deploy of $SHA failed AND rollback to $PREV is not healthy – the bot may be down. Check: pnpm server:status"
  fi
else
  notify "🚨 First deploy of $SHA is not healthy – check: pnpm server:status"
fi
exit 1
