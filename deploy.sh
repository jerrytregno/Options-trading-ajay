#!/usr/bin/env bash
# Deploy on Lightsail (or any Node host). Run from project root after git pull or rsync.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PM2_NAME="${PM2_NAME:-options-trading}"
GIT_PULL="${GIT_PULL:-0}"

echo "==> Deploying from $ROOT"

if [[ "$GIT_PULL" == "1" ]]; then
  if [[ -d .git ]]; then
    echo "==> git pull"
    git pull --ff-only origin main
  else
    echo "==> Skipping git pull (.git not found — use rsync from Mac or set GIT_PULL=0)"
  fi
fi

echo "==> npm install"
npm install

echo "==> npm run build"
npm run build

mkdir -p data
rm -rf data/sensex-nine-fifteen-cache* data/sensex-nine-fifteen-cache-rows 2>/dev/null || true

if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  echo "==> pm2 restart $PM2_NAME"
  pm2 restart "$PM2_NAME"
else
  echo "==> pm2 start $PM2_NAME"
  pm2 start npm --name "$PM2_NAME" -- start
  pm2 save
fi

echo "==> Done at $(date -Iseconds)"
pm2 status "$PM2_NAME"
echo ""
echo "Tip: pm2 logs $PM2_NAME --lines 30"
