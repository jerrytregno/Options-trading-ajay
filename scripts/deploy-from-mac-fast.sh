#!/usr/bin/env bash
# Fast deploy: rsync changed files, skip npm install, build + pm2 restart only.
# Usage: ./scripts/deploy-from-mac-fast.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${DEPLOY_HOST:-ubuntu@13.206.140.159}"
KEY="${DEPLOY_KEY:-$HOME/Downloads/LightsailDefaultKey-ap-south-1.pem}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-~/Options-Trading}"

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY"
  echo "Set DEPLOY_KEY=/path/to/key.pem or place key in ~/Downloads/LightsailDefaultKey-ap-south-1.pem"
  exit 1
fi

chmod 400 "$KEY"

echo "==> rsync (fast) to $HOST:$REMOTE_DIR"
rsync -avz --delete \
  -e "ssh -i $KEY" \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .tmp-tsx \
  --exclude .env.local \
  --exclude .env \
  --exclude data/kite-session.json \
  --exclude data/bot-trade-logs.json \
  --exclude 'data/*nine-fifteen-cache*' \
  --exclude data/nine-sixteen-capture.json \
  --exclude data/nine-sixteen-state.json \
  --exclude 'data/nine-sixteen-ran-*.json' \
  --exclude data/momentum-scalper-state.json \
  --exclude data/momentum-scalper-claim.json \
  --exclude 'data/momentum-scalper-ran-*.json' \
  --exclude data/broker-fills \
  --exclude data/ticks \
  . "$HOST:$REMOTE_DIR/"

echo "==> remote deploy (skip npm install)"
ssh -i "$KEY" "$HOST" "cd $REMOTE_DIR && chmod +x deploy.sh && SKIP_NPM_INSTALL=1 ./deploy.sh"

echo "==> Fast deploy complete → https://tradinganalystjry.com"
