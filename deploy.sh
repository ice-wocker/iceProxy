#!/bin/bash
# iceProxy one-click deploy
set -e

echo "=== 1. Install ==="
npm install

echo "=== 2. Create KV (idempotent) ==="
KV_ID=$(npx wrangler kv namespace create ACCOUNTS 2>&1 | grep -oE 'id = "[^"]+"' | head -1 | sed 's/id = "//;s/"$//')
if [ -z "$KV_ID" ]; then
  echo "KV exists, reading from wrangler.toml"
  KV_ID=$(grep -E '^id = "' wrangler.toml | head -1 | sed 's/id = "//;s/"$//')
fi
if [ -z "$KV_ID" ]; then
  echo "❌ Failed to get KV id. Please run manually:"
  echo "  npx wrangler kv namespace create ACCOUNTS"
  echo "  then add id to wrangler.toml"
  exit 1
fi
# Update wrangler.toml
if ! grep -q "id = \"$KV_ID\"" wrangler.toml; then
  sed -i "s/^# id = \"your_kv_id\"/id = \"$KV_ID\"/" wrangler.toml
fi
echo "KV id: $KV_ID"

echo "=== 3. Login (if needed) ==="
npx wrangler whoami 2>/dev/null || npx wrangler login

echo "=== 4. Deploy ==="
npx wrangler deploy

echo ""
echo "✅ iceProxy deployed!"
echo "Test: curl https://ice-proxy.<your-sub>.workers.dev/health"
