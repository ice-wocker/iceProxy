#!/usr/bin/env bash
# iceProxy 一键部署。
#
# 和上一版的区别：
#   1. 不再用 `sed -i` 去改 wrangler.toml。上一版靠正则匹配
#      `# id = "your_kv_id"` 那一行，一旦格式变过或已经填过，
#      正则就静默匹配不上，KV id 留在占位符上，部署出来的 Worker
#      每个 Qwen 请求都失败 —— 而且它不会报错。这里改成解析后写回，
#      幂等且可重入。
#   2. 部署前先跑测试，把坏的拦在门外。
#   3. 每步失败都有明确提示。
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "1/5 检查依赖"
command -v node >/dev/null || { echo "缺少 node（需要 >=20）"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node 版本过低：$(node -v)，需要 >=20"; exit 1; }
echo "node $(node -v)"

say "2/5 安装依赖"
npm install --no-audit --no-fund

say "3/5 部署前先跑测试"
npm test

say "4/5 准备 KV namespace"
KV_ID=$(node -e '
const fs=require("fs");
try{
  const t=fs.readFileSync("wrangler.toml","utf8");
  const m=t.match(/^\s*id\s*=\s*"([^"]+)"/m);
  if(m && m[1]!=="REPLACE_WITH_KV_ID") process.stdout.write(m[1]);
}catch{}
')

if [ -z "${KV_ID:-}" ]; then
  echo "尚未配置 KV，尝试创建……"
  OUT=$(npx wrangler kv namespace create ACCOUNTS 2>&1 || true)
  KV_ID=$(printf '%s\n' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)
  if [ -z "$KV_ID" ]; then
    echo
    echo "自动创建 KV 失败。手动执行："
    echo "  npx wrangler kv namespace create ACCOUNTS"
    echo "再把 id 填进 wrangler.toml 的 [[kv_namespaces]]。"
    echo "（也可以跳过：不配 KV 时 Qwen 模型不可用，其他 provider 照常）"
    echo
  else
    node -e '
      const fs=require("fs"), kv=process.argv[1];
      let t=fs.readFileSync("wrangler.toml","utf8");
      t=t.replace("REPLACE_WITH_KV_ID", kv);
      fs.writeFileSync("wrangler.toml", t);
      console.log("已把 KV id 写入 wrangler.toml");
    ' "$KV_ID"
  fi
else
  echo "KV 已配置：$KV_ID"
fi

say "5/5 登录 & 部署"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "未登录 Cloudflare，启动登录……"
  npx wrangler login
fi
npx wrangler deploy

cat <<'DONE'

部署完成。

接下来（可选）：
  node scripts/auth.js add               # 加一个 Qwen 账号（不需要任何 API key）
  npx wrangler secret put GLM_API_KEY    # 再配其它 provider

验证：
  curl https://ice-proxy.<你的子域>.workers.dev/health
  curl https://ice-proxy.<你的子域>.workers.dev/v1/models
DONE
