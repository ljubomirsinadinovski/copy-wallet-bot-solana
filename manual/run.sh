#!/usr/bin/env bash
# Manual trading: start it when you want to buy or sell by hand, stop it with Ctrl+C when you're done.
#   bash manual/run.sh        → open http://127.0.0.1:8790
# Settings: manual/manual.env (overrides the project's .env, for this tool only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Node 24 – the project's version – even if the terminal's default (nvm) is older.
if ! node -v 2>/dev/null | grep -q '^v24'; then
  NODE24="$(ls -d "$HOME"/.nvm/versions/node/v24*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$NODE24" ] && export PATH="$NODE24:$PATH"
fi
node -v 2>/dev/null | grep -q '^v24' || { echo "Node 24 is needed: nvm install 24"; exit 1; }

# This folder isn't part of the pnpm workspace: it borrows the project's installed packages.
[ -d server/node_modules ] && [ -d web/node_modules ] || { echo "Run 'pnpm install' in the project first."; exit 1; }
ln -sfn ../../server/node_modules manual/server/node_modules
ln -sfn ../../web/node_modules manual/web/node_modules
[ -f manual/manual.env ] || cp manual/manual.env.example manual/manual.env

# Build the page (about a second), then start the server.
web/node_modules/.bin/vite build --config manual/web/vite.config.ts --logLevel warn
exec server/node_modules/.bin/tsx --env-file-if-exists=.env --env-file-if-exists=manual/manual.env manual/server/main.ts
