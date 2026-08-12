#!/bin/sh
set -eu

APP_UID=1001
APP_GID=1001

mkdir -p /app/data

# A bind-mounted ./data is created root-owned by the Docker daemon, which the
# unprivileged app user cannot write, so Prisma fails to create the database.
# When started as root, fix ownership and then drop privileges for everything
# that follows. When started with an explicit --user, run as-is and rely on the
# host directory already being writable.
if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u /app/data)" != "$APP_UID" ]; then
    echo "[orbit] taking ownership of /app/data..."
    chown -R "$APP_UID:$APP_GID" /app/data
  fi
  drop_priv="setpriv --reuid $APP_UID --regid $APP_GID --clear-groups"
else
  drop_priv=""
fi

echo "[orbit] syncing database schema..."
# Deliberately do not pass --accept-data-loss. Additive upgrades can still be
# applied automatically, but an older image whose schema would drop newer
# tables or columns must fail closed instead of destroying data during a
# rollback. Restore a matching database backup before rolling back the image.
# shellcheck disable=SC2086
$drop_priv node /app/node_modules/prisma/build/index.js db push \
  --schema=/app/prisma/schema.prisma --skip-generate

echo "[orbit] starting application..."
# shellcheck disable=SC2086
exec $drop_priv "$@"
