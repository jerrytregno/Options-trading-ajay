#!/usr/bin/env bash
# Upload local code to Lightsail and run deploy.sh on the server.
# Usage: ./scripts/deploy-from-mac.sh
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

echo "==> rsync to $HOST:$REMOTE_DIR"
rsync -avz --delete --progress \
  -e "ssh -i $KEY" \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .env.local \
  --exclude .env \
  --exclude data/kite-session.json \
  --exclude data/bot-trade-logs.json \
  --exclude data/nine-sixteen-capture.json \
  --exclude data/nine-sixteen-state.json \
  --exclude 'data/nine-sixteen-ran-*.json' \
  --exclude data/ticks \
  . "$HOST:$REMOTE_DIR/"

echo "==> remote deploy"
ssh -i "$KEY" "$HOST" "cd $REMOTE_DIR && chmod +x deploy.sh && ./deploy.sh"

echo "==> Deploy complete → https://tradinganalystjry.com"
