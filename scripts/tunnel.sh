#!/usr/bin/env bash
# Expose a locally running CodeAgent at a free public https URL (no domain needed)
# using a Cloudflare quick tunnel: https://<random>.trycloudflare.com
set -euo pipefail
PORT="${PORT:-3000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo "  Linux:  curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/"
  echo "  macOS:  brew install cloudflared"
  echo "  Windows: winget install --id Cloudflare.cloudflared"
  exit 1
fi

echo "Tunneling http://localhost:${PORT} → look for the https://*.trycloudflare.com URL below"
exec cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}"
