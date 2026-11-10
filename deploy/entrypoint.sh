#!/bin/sh
# Make the mounted data folder writable for the unprivileged "node" user, then run the bot as that
# user (never as root). Fixes "EACCES: permission denied" when ./data was created by another user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
