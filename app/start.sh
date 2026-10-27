#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22 or newer, then run this again."
  exit 1
fi
exec node app/host.mjs
