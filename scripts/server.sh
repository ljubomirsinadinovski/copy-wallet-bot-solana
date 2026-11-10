#!/usr/bin/env bash
# Look at the production bot from your laptop, over Tailscale SSH. Read-only except restart/reload.
#   pnpm server:status            health, version, container, recent errors/warnings
#   pnpm server:logs [2h]         logs of the last hour (or the given period, e.g. 30m, 2h, 1d)
#   pnpm server:follow            live logs (Ctrl+C to stop watching)
#   pnpm server:db "select …"     read-only SQL on the live database
#   pnpm server:deploys           what is deployed + recent commits on the server
#   pnpm server:backup            download the newest nightly database backup
#   pnpm server:restart           safe restart of the bot
#   pnpm server:reload            apply changes to the server's .env (recreates the container)
#   pnpm server:ssh               open a shell on the server
# The server address is the SSH alias "copy-wallet" (see deploy/SERVER-SETUP.md); override with COPY_WALLET_SSH=…
set -euo pipefail
HOST="${COPY_WALLET_SSH:-copy-wallet}"
APP=/opt/copy-wallet
cmd="${1:-status}"; shift || true
[ "${1:-}" = "--" ] && shift

case "$cmd" in
  status)
    ssh "$HOST" "cd $APP && echo \"deployed: \$(cat .deployed 2>/dev/null || echo '-')\" \
      && echo \"health:   \$(curl -s -m 5 http://127.0.0.1:8787/api/health || echo 'NOT RESPONDING')\" \
      && docker compose ps --format 'container: {{.Name}} {{.Status}}' \
      && echo '--- errors and warnings, last 24h:' \
      && (docker compose logs --no-log-prefix --since 24h bot 2>&1 | grep -aE 'ERROR|FATAL|WARN' | tail -20 || echo none)"
    ;;
  logs)
    ssh "$HOST" "cd $APP && docker compose logs --no-log-prefix --since ${1:-1h} bot"
    ;;
  follow)
    ssh -t "$HOST" "cd $APP && docker compose logs --no-log-prefix -f --since 10m bot"
    ;;
  db)
    sql="${*:?usage: pnpm server:db \"select ...\"}"
    printf '%s\n' "$sql" | ssh "$HOST" "sqlite3 -readonly -header -column $APP/data/copy-wallet.db"
    ;;
  deploys)
    ssh "$HOST" "cd $APP && echo \"deployed: \$(cat .deployed 2>/dev/null || echo '-')\" && git log --oneline -10 origin/main"
    ;;
  backup)
    mkdir -p backups
    latest="$(ssh "$HOST" "ls -1t $APP/backups/*.db 2>/dev/null | head -1")"
    [ -n "$latest" ] || { echo "No backups on the server yet."; exit 1; }
    scp "$HOST:$latest" backups/ && echo "Saved backups/$(basename "$latest")"
    ;;
  restart)
    ssh "$HOST" "cd $APP && docker compose restart bot && sleep 5 && curl -s -m 5 http://127.0.0.1:8787/api/health"
    ;;
  reload)
    ssh "$HOST" "cd $APP && GIT_SHA=\$(cat .deployed) docker compose up -d && sleep 8 && curl -s -m 5 http://127.0.0.1:8787/api/health"
    ;;
  ssh)
    ssh -t "$HOST" "cd $APP; exec \$SHELL -l"
    ;;
  *)
    sed -n '2,14p' "$0"; exit 1
    ;;
esac
