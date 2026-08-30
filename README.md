# iceProxy

**OpenAI-compatible API for 5 free AI models · Cloudflare Workers · 0 cold start**

iceProxy is a single-file Cloudflare Worker that exposes free-tier AI models as an OpenAI-compatible API. It supports **multi-account rotation** for the Qwen free tier (2000 req/day × N accounts) and **fallback** across providers for high availability.

## Features

- ✅ **OpenAI-compatible API** — drop-in replacement for `https://api.openai.com/v1`
- ✅ **5 free providers** with 8+ models:
  | Provider | Models | Free Tier | Auth |
  |----------|--------|-----------|------|
  | **Qwen** | qwen3-coder-plus, qwen3-coder-flash, vision-model | 2000 req/day | OAuth (QR) |
  | **Gemini** | gemini-2.0-flash, gemini-1.5-flash | 1500 req/day | API Key |
  | **GLM** (智谱) | glm-4.5-flash | Generous free | API Key |
  | **Cerebras** | qwen-3-32b | 30 req/min | API Key |
  | **OpenRouter** | auto (free models) | Daily free | API Key |
- ✅ **Multi-account rotation** — add N Qwen accounts, get N × 2000 req/day
- ✅ **Auto-failover** — when one account is rate-limited, automatically switch to next
- ✅ **Auto-refresh tokens** — Qwen access tokens refresh on demand
- ✅ **Daily auto-reset** — failed accounts reset at UTC midnight (no cron)
- ✅ **Free hosting** — Cloudflare Workers free tier = 100k requests/day
- ✅ **API key gate** — protect your proxy with your own bearer token
- ✅ **Admin health endpoint** — monitor all accounts
- ✅ **Single file** — no build step, just `wrangler deploy`

## Architecture

```
Client (any OpenAI SDK) ──> iceProxy Worker ──┬─> Qwen OAuth (multi-account)
                                             ├─> Gemini (Google)
                                             ├─> GLM (Zhipu)
                                             ├─> Cerebras
                                             └─> OpenRouter
```

All in one ~450-line `worker.js`.

## Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/ice-wocker/iceProxy
cd iceProxy
npm install
```

### 2. Create KV Namespace
```bash
npx wrangler kv namespace create ACCOUNTS
# Copy the returned "id" into wrangler.toml
```

### 3. (Optional) Set API keys for non-Qwen providers
```bash
npx wrangler secret put GEMINI_API_KEY       # get free at https://aistudio.google.com/apikey
npx wrangler secret put GLM_API_KEY          # https://bigmodel.cn/
npx wrangler secret put CEREBRAS_API_KEY     # https://cloud.cerebras.ai/
npx wrangler secret put OPENROUTER_API_KEY   # https://openrouter.ai/
npx wrangler secret put OPENAI_API_KEYS      # "sk-xxx,sk-yyy" - clients must use one of these
npx wrangler secret put ADMIN_SECRET         # for /admin/health
```

### 4. (Optional) Add Qwen OAuth accounts
```bash
# Add first account - shows QR / device code
node scripts/auth.js add account1

# Add more accounts to multiply quota
node scripts/auth.js add account2
node scripts/auth.js add account3

# List local accounts
node scripts/auth.js list

# Push to Cloudflare KV
node scripts/auth.js deploy
```

### 5. Deploy
```bash
npx wrangler deploy
```

Your proxy is now live at `https://ice-proxy.<your-subdomain>.workers.dev` 🎉

## Usage

### cURL
```bash
# Qwen code (free, 2000/day per account)
curl -X POST https://ice-proxy.YOUR.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "qwen/qwen3-coder-flash",
    "messages": [{"role": "user", "content": "Write hello world in Python"}]
  }'

# Gemini (free)
curl -X POST .../v1/chat/completions \
  -d '{"model": "gemini/gemini-2.0-flash", "messages": [...]}'

# GLM (free)
curl -X POST .../v1/chat/completions \
  -d '{"model": "glm/glm-4.5-flash", "messages": [...]}'
```

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://ice-proxy.YOUR.workers.dev/v1",
    api_key="sk-xxx"  # the OPENAI_API_KEYS you set
)

response = client.chat.completions.create(
    model="qwen/qwen3-coder-flash",
    messages=[{"role": "user", "content": "Explain recursion"}]
)
print(response.choices[0].message.content)
```

### Node.js
```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "https://ice-proxy.YOUR.workers.dev/v1",
  apiKey: process.env.ICE_PROXY_KEY
});
const r = await client.chat.completions.create({
  model: "gemini/gemini-2.0-flash",
  messages: [{ role: "user", content: "Hello" }]
});
```

### Cline / Continue.dev / Cursor / etc.
Set:
- **API Base URL**: `https://ice-proxy.YOUR.workers.dev/v1`
- **API Key**: your `OPENAI_API_KEYS` value
- **Model**: any of the 8+ listed (e.g. `qwen/qwen3-coder-flash`)

## Models

| Model ID | Provider | Best For | Notes |
|----------|----------|----------|-------|
| `qwen/qwen3-coder-plus` | Qwen | Coding | 2000/day per account |
| `qwen/qwen3-coder-flash` | Qwen | Coding, fast | 2000/day, lower latency |
| `qwen/vision-model` | Qwen | Image input | 2000/day |
| `gemini/gemini-2.0-flash` | Google | Multimodal, fast | 1500/day |
| `gemini/gemini-1.5-flash` | Google | Multimodal | 1500/day |
| `glm/glm-4.5-flash` | Zhipu | Chinese | Generous free |
| `cerebras/qwen-3-32b` | Cerebras | Fast Qwen 32B | 30 req/min |
| `openrouter/auto` | OpenRouter | Many free models | Daily free |

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness check |
| `/v1/models` | GET | List models (OpenAI compat) |
| `/v1/chat/completions` | POST | Chat completion |
| `/v1/auth/start` | POST | Start Qwen OAuth (returns user code) |
| `/v1/auth/poll` | POST | Poll Qwen OAuth (with code_verifier) |
| `/admin/health` | GET | Account health (requires ADMIN_SECRET) |

## Multi-Account Logic

When you add multiple Qwen accounts, iceProxy automatically:

1. **Picks freshest token** — favors accounts whose access_token is far from expiry
2. **Auto-refreshes** — refreshes access_token using refresh_token when needed
3. **Auto-failover** — on 429 (rate limit) or 401 (invalid), instantly switches to next account
4. **Daily reset** — failed accounts are tried again at UTC midnight (no cron job needed)
5. **Persistent** — tokens cached in Cloudflare KV, survive deploys

With 5 Qwen accounts you get **10,000 req/day** for free.

## Cost

- **Cloudflare Workers free tier**: 100,000 requests/day
- **KV free tier**: 100,000 reads/day, 1,000 writes/day
- **Total**: $0/month for personal use

## License

MIT
