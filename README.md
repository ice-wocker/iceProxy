<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-orange" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/models-18-brightgreen" alt="18 Models">
  <img src="https://img.shields.io/badge/providers-6-blueviolet" alt="6 Providers">
  <img src="https://img.shields.io/badge/tests-82-success" alt="82 Tests">
  <img src="https://img.shields.io/github/stars/ice-wocker/iceProxy?style=social" alt="Stars">
</p>

<h1 align="center">iceProxy</h1>

<p align="center">
  <b>One OpenAI-compatible endpoint for 18 free AI models across 6 providers</b><br>
  <sub>Streaming · Cross-provider failover · Multi-account rotation · Zero build step</sub>
</p>

iceProxy is a Cloudflare Worker that puts 18 free-tier AI models behind a single
OpenAI-compatible API. Point any OpenAI client at it, change nothing else.

**Why it exists:** free tiers are scattered across six different vendors, each with
its own auth scheme, its own request shape, and its own way of rate-limiting you.
iceProxy normalizes all of that into `/v1/chat/completions` — and when one provider
throttles you, it quietly retries on the next one.

## Features

- **OpenAI-compatible** — drop-in `base_url` replacement. Works with `openai-python`,
  LangChain, Cline, Continue, Cursor, `aichat`, `llm`, and anything else that speaks
  the protocol.
- **Real streaming** — true SSE passthrough, including Gemini (which doesn't speak
  OpenAI natively). `stream: true` actually streams.
- **Cross-provider failover** — a 429 or 5xx on one provider rolls over to the next
  configured one. Only retryable errors trigger it; a 400 is returned as-is.
- **Multi-account rotation** — add N Qwen accounts, get N times the quota. Tokens
  refresh on demand, and a rate-limited account cools down instead of dying.
- **6 providers, one interface** — Qwen, Gemini, GLM, Cerebras, Groq, OpenRouter.
- **Zero build step** — plain ES modules, no bundler, no transpiler.
- **Zero runtime dependencies** — the unit tests use only `node:test`. Nothing to
  audit in your supply chain.
- **82 tests** — including regression tests for every bug listed in
  [Known fixed bugs](#known-fixed-bugs).

## Models

| Model ID | Provider | Context | Notes |
|---|---|---:|---|
| `qwen/qwen3-coder-flash` | Qwen | 1M | Default. Fast coding model |
| `qwen/qwen3-coder-plus` | Qwen | 1M | Stronger coding model |
| `qwen/qwen3-max` | Qwen | 262K | General flagship |
| `qwen/qwen-vl-max` | Qwen | 131K | Vision input |
| `gemini/gemini-2.5-flash` | Gemini | 1M | Vision + audio + tools |
| `gemini/gemini-2.5-flash-lite` | Gemini | 1M | Cheapest/fastest Gemini |
| `gemini/gemini-2.0-flash` | Gemini | 1M | Previous gen, still fast |
| `glm/glm-4.6-flash` | GLM | 200K | Strong Chinese + coding |
| `glm/glm-4.5-flash` | GLM | 131K | Previous gen |
| `cerebras/qwen-3-32b` | Cerebras | 131K | Very fast inference |
| `cerebras/llama-3.3-70b` | Cerebras | 131K | Very fast inference |
| `groq/llama-3.3-70b-versatile` | Groq | 131K | Very fast inference |
| `groq/qwen-3-32b` | Groq | 131K | Very fast inference |
| `openrouter/qwen/qwen3.8-27b:free` | OpenRouter | 262K | Free tier, vision |
| `openrouter/google/gemma-4-31b-it:free` | OpenRouter | 262K | Free tier, vision |
| `openrouter/nvidia/nemotron-3-super-120b-a12b:free` | OpenRouter | 262K | Free tier |
| `openrouter/cohere/north-mini-code:free` | OpenRouter | 256K | Free tier, coding |
| `openrouter/inclusionai/ling-3.0-flash-sante:free` | OpenRouter | 262K | Free tier, tools |

Only Qwen works with **no API key at all** — it uses OAuth device flow instead.
That's the default model, so a fresh fork is usable after adding one account.

> Free quotas change constantly, so this README deliberately does **not** list
> request-per-day numbers. Check each provider's own page. `CI` enforces that this
> table and `src/providers.js` never drift apart.

## Architecture

```
Client (any OpenAI SDK)
        │
        ▼
  ┌─────────────────────────────────────────┐
  │  iceProxy Worker                        │
  │                                         │
  │  worker.js      routing + orchestration │
  │  providers.js   model catalog (truth)   │
  │  adapters.js    per-provider protocol   │
  │  accounts.js    Qwen pool: rotate/refresh│
  │  openai.js      SSE frames, error shape │
  └───┬──────┬──────┬──────┬──────┬──────┬──┘
      │      │      │      │      │      │
    Qwen  Gemini  GLM  Cerebras  Groq  OpenRouter
      │
   KV: account pool (access_token / refresh_token)
```

`providers.js` is the single source of truth for the model list. `worker.js` reads
from it. `scripts/check-docs.mjs` asserts the README matches it.

## Quick start

### 1. Clone

```bash
git clone https://github.com/ice-wocker/iceProxy
cd iceProxy
npm install
```

### 2. Deploy

```bash
./deploy.sh
```

That script installs dependencies, runs the tests, creates the KV namespace,
writes its id back into `wrangler.toml`, and deploys. It's idempotent — running it
again is safe.

Or do it by hand:

```bash
npx wrangler kv namespace create ACCOUNTS   # paste the id into wrangler.toml
npx wrangler deploy
```

### 3. Add a Qwen account (optional, but it's the only key-free path)

```bash
node scripts/auth.js add
```

Scan the QR / open the link, and the token lands in Cloudflare KV. Add more
accounts to multiply the quota.

### 4. Add API keys for the other providers (all optional)

```bash
npx wrangler secret put GEMINI_API_KEY      # https://aistudio.google.com/apikey
npx wrangler secret put GLM_API_KEY         # https://bigmodel.cn/
npx wrangler secret put CEREBRAS_API_KEY    # https://cloud.cerebras.ai/
npx wrangler secret put GROQ_API_KEY        # https://console.groq.com/keys
npx wrangler secret put OPENROUTER_API_KEY  # https://openrouter.ai/
```

Providers without a key are simply marked unavailable in `/v1/models`. They are
skipped in the failover chain rather than failing at request time.

### 5. Lock it down (do this if it's public)

```bash
npx wrangler secret put OPENAI_API_KEYS   # "sk-yourkey" — clients must send this
npx wrangler secret put ADMIN_SECRET      # for /admin/health
```

Without `OPENAI_API_KEYS` the endpoint is **open** — convenient on `wrangler dev`,
careless on a public URL.

## Usage

### curl

```bash
curl -X POST https://ice-proxy.YOUR-SUBDOMAIN.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-yourkey" \
  -d '{
    "model": "qwen/qwen3-coder-flash",
    "messages": [{"role": "user", "content": "Write hello world in Python"}]
  }'
```

Streaming:

```bash
curl -N -X POST .../v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "glm/glm-4.6-flash", "stream": true,
       "messages": [{"role": "user", "content": "hi"}]}'
```

### Python (official SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://ice-proxy.YOUR-SUBDOMAIN.workers.dev/v1",
    api_key="sk-yourkey",
)

# non-streaming
r = client.chat.completions.create(
    model="gemini/gemini-2.5-flash",
    messages=[{"role": "user", "content": "Explain recursion"}],
)
print(r.choices[0].message.content)

# streaming
with client.chat.completions.create(
    model="qwen/qwen3-coder-flash",
    messages=[{"role": "user", "content": "Write a haiku"}],
    stream=True,
) as stream:
    for chunk in stream:
        if chunk.choices[0].delta.content:
            print(chunk.choices[0].delta.content, end="")
```

### Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://ice-proxy.YOUR-SUBDOMAIN.workers.dev/v1",
  apiKey: process.env.ICE_PROXY_KEY,
});

const stream = await client.chat.completions.create({
  model: "groq/llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### Cline / Continue / Cursor

- **Base URL**: `https://ice-proxy.YOUR-SUBDOMAIN.workers.dev/v1`
- **API Key**: your `OPENAI_API_KEYS` value
- **Model**: any id from the table above

## Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | none | Liveness + which providers are configured |
| `/v1/models` | GET | optional | List models, with `context_length`, `capabilities`, `available` |
| `/v1/chat/completions` | POST | optional | Chat completion (streaming and non-streaming) |
| `/v1/auth/start` | POST | optional | Begin Qwen OAuth device flow |
| `/v1/auth/poll` | POST | optional | Poll for the Qwen token and store the account |
| `/admin/health` | GET | `ADMIN_SECRET` | Account pool status |

`/v1/models` adds three non-standard fields (`context_length`, `capabilities`,
`available`). Standard clients ignore them; clients that care about context window
can use them.

## Behavior worth knowing

### Failover

The candidate chain is built as:

1. the model you asked for,
2. other models from the same provider (same credential, cheapest to try),
3. models from other providers that have credentials configured.

Capped at 4 attempts. Only **429, 401, 403 and 5xx** advance the chain — a 400 means
the request itself is wrong, and retrying it elsewhere would just burn another
provider's quota to produce the same error.

When the request is served by a different model than you asked for, the response
carries `_proxy` and the header `X-IceProxy-Fallback`:

```json
{
  "_proxy": {
    "servedModel": "glm/glm-4.6-flash→groq/llama-3.3-70b-versatile",
    "fellBack": true,
    "attempts": [{ "model": "glm/glm-4.6-flash", "error": "HTTP 429: ..." }]
  }
}
```

### Account rotation

For Qwen, `iceProxy`:

- picks the account whose token expires latest,
- refreshes proactively 2 minutes before expiry (so a token can't expire mid-request),
- deduplicates concurrent refreshes within an isolate (KV has no atomic ops),
- cools down on failure **by cause**: rate limits for a minute, server errors for
  seconds, auth failures for hours. It does not burn an account for the whole day
  over one 429.

Failed accounts recover automatically — there's no cron job.

### Statelessness

The worker keeps no conversation state. Context is whatever the client resends each
turn, which is how OpenAI behaves. Streaming requests are proxied, not buffered.

## Cost

Cloudflare Workers and KV both have free tiers that comfortably cover personal use.
Total: $0/month. See Cloudflare's current pricing for limits.

## Development

```bash
npm test                        # 82 tests, no network, no dependencies
node scripts/check-docs.mjs     # README vs code consistency
npm run check                   # both
```

The tests mock `globalThis.fetch`, so they run offline and never touch a real
provider. They cover: SSE frame reassembly across arbitrary chunk boundaries,
streaming and non-streaming for every protocol, the failover chain, account pool
rotation/refresh/cooldown, and every historical bug below.

## Known fixed bugs

These are documented because each one is now covered by a regression test — and
because they're the class of bug that a green test suite would happily miss.

| Bug | Symptom | Root cause |
|---|---|---|
| Streaming never streamed | `stream: true` returned a single JSON blob; chat UIs hung | `stream` was hardcoded to `false` in the OpenAI-compat path |
| Gemini had no streaming at all | Same, for all Gemini models | Only `generateContent` was implemented, never `streamGenerateContent` |
| Valid Qwen accounts rejected | "no Qwen account available" with a fresh token | Account pool read `acc.token`, but accounts store `access_token` — so every request took the refresh path, and one failed refresh blacklisted the account for the day |
| Same bug, second effect | An extra token-refresh round trip on every request | Same field-name mismatch |
| README lied about failover | Documented "cross-provider failover" that didn't exist | Only Qwen *account* rotation was implemented |
| Errors broke SDKs | `KeyError` inside client libraries | Error body was `{"error": "string"}` instead of `{"error": {"message": ...}}` |
| Gemini dropped conversation history | Model forgot everything each turn with Cline/Cursor | Only the last message was forwarded |
| Last chunk of a broken stream vanished | Response truncated mid-sentence | Buffered SSE rows were discarded when the upstream errored |
| Docs drift | README said 7 models, code had 8, `package.json` said 5 | No single source of truth; now `providers.js` + a CI check |

## Limitations

- **This is a proxy, not a service.** It depends on free tiers that vendors can
  change, rate-limit, or withdraw at any time. No availability guarantee.
- **Automating OAuth account creation may violate a vendor's terms.** `scripts/auth.js`
  is a convenience for your own account. Use it on accounts you own.
- **Free quotas are shared and finite.** Don't hammer it. Excessive use gets your
  own accounts throttled or banned.
- **`_proxy` is non-standard.** Some strict clients may reject unknown top-level
  response fields. The streaming path never adds it.
- **Tool calling is passed through, not normalized.** Providers differ in how they
  express tool calls; iceProxy forwards `tools`/`tool_choice` but doesn't translate
  between dialects.
- **No embeddings or moderation endpoints.** Inference only.

## License

MIT — see [LICENSE](LICENSE).

## Star history

<a href="https://star-history.com/#ice-wocker/iceProxy&Timeline">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ice-wocker/iceProxy&type=Timeline&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ice-wocker/iceProxy&type=Timeline" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ice-wocker/iceProxy&type=Timeline" />
  </picture>
</a>
