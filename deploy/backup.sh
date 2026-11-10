#!/usr/bin/env bash
# On the server, by hand: a consistent copy of the live database – safe while the bot is running –
# keeping the newest 14. Run: ssh copy-wallet /opt/copy-wallet/deploy/backup.sh   Download: pnpm server:backup
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/copy-wallet}"
mkdir -p "$APP_DIR/backups"
sqlite3 "$APP_DIR/data/copy-wallet.db" ".backup '$APP_DIR/backups/copy-wallet-$(date +%F-%H%M).db'"
ls -1t "$APP_DIR"/backups/copy-wallet-*.db | tail -n +15 | xargs -r rm --
echo "$(date -Is) backup ok"
