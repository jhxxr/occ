#!/bin/sh
set -eu

mkdir -p /app/data

echo "[orbit] applying database migrations..."
node /app/node_modules/prisma/build/index.js migrate deploy --schema=/app/prisma/schema.prisma

echo "[orbit] starting application..."
exec "$@"
