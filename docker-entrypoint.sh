#!/bin/sh
set -e

mkdir -p /app/storage/images /app/storage/references
chown -R app:app /app/storage

exec su-exec app "$@"
