<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-orange" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/no%20API%20key-needed-success" alt="No API key needed">
  <img src="https://img.shields.io/badge/models-20-brightgreen" alt="20 Models">
  <img src="https://img.shields.io/badge/providers-7-blueviolet" alt="7 Providers">
  <img src="https://img.shields.io/badge/tests-104-success" alt="104 Tests">
  <img src="https://img.shields.io/github/stars/ice-wocker/iceProxy?style=social" alt="Stars">
</p>

<h1 align="center">iceProxy</h1>

<p align="center">
  <b>One OpenAI-compatible endpoint for 20 free AI models across 7 providers</b><br>
  <sub>Works with <b>zero configuration</b> · Streaming · Cross-provider failover · Multi-account rotation</sub>
</p>

iceProxy is a Cloudflare Worker that puts 20 free-tier AI models behind a single
OpenAI-compatible API. Point any OpenAI client at it, change nothing else.

**Deploy it and it works.** No API key, no account, no KV namespace — the default
model runs on a keyless upstream ([Pollinations](https://pollinations.ai)), so a
fresh `wrangler deploy` answers requests on the first try. Add provider keys later
to unlock more models; the failover chain picks them up automatically.

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
- **Zero-config by default** — the default model needs no credentials at all, so a
  fresh deploy is immediately usable. Everything else is opt-in.
- **7 providers, one interface** — Pollinations (keyless), Qwen, Gemini, GLM,
  Cerebras, Groq, OpenRouter.
- **Zero build step** — plain ES modules, no bundler, no transpiler.
- **Zero runtime dependencies** — the unit tests use only `node:test`. Nothing to
  audit in your supply chain.
- **104 tests** — including regression tests for every bug listed in
  [Known fixed bugs](#known-fixed-bugs).
- **A real-availability prober** (`npm run probe`) — hits the actual providers and
  tells you which of the 20 model IDs still exist, as opposed to which ones merely
  have credentials configured.

## Models

| Model ID | Provider | Context | Notes |
|---|---|---:|---|
| `pollinations/gpt-oss-20b` | Pollinations | 131K | **Default. No API key at all** |
| `pollinations/openai-fast` | Pollinations | 131K | Alias of the same upstream model |
| `qwen/qwen3-coder-flash` | Qwen | 1M | Fast coding model |
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

Two things need **no API key**:

- **Pollinations** — truly keyless, anonymous tier, no account. It's the default
  model, so a fresh fork works immediately.
- **Qwen** — no static key, but you add an account once via OAuth device flow
  (`node scripts/auth.js add`). Add several to multiply the quota.

Everything else needs a provider key, and can be added at any time. Whichever
providers you've configured become part of the failover chain automatically —
you never edit the model list to "enable" one.

### What "no API key" actually buys you

Being honest about the keyless tier, because it's the reason the default works:

- **Pollinations' anonymous tier is free and needs no signup**, but it is a
  *shared public endpoint*. It rate-limits bursts, and its backend has been known
  to return `500 ENOSPC` (disk full) or `402` during busy periods. Single requests
  at human pace are reliable in testing; hammering it is not. When it does fail,
  the proxy **retries transient errors once** and then fails over — but with only
  one keyless provider today, there's nothing to fail over *to*, so you'll get a
  clear per-provider error instead of a hang.
- **No `tools` / function calling, and no `system` role** on the anonymous tier —
  the upstream returns `402` for those. That's why `pollinations/*` is marked
  `caps: ["stream"]` only, and why the proxy treats `402` as *failover-able*
  rather than a hard client error.
- **One model** (`gpt-oss-20b`), under three aliases.

So: keyless is the zero-friction default and it genuinely works, but it is not a
service-level guarantee. For anything load-bearing, add at least one keyed
provider — then the failover chain has somewhere to go.

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
  └─┬────┬──────┬──────┬──────┬──────┬──────────┬──┘
    │    │      │      │      │      │          │
Pollinations Qwen Gemini  GLM  Cerebras  Groq  OpenRouter
 (no key)   │
         KV: account pool (access_token / refresh_token)
```

`providers.js` is the single source of truth for the model list. `worker.js` reads
from it. `scripts/check-docs.mjs` asserts the README matches it.

## Quick start

### 1. Clone and deploy

```bash
git clone https://github.com/ice-wocker/iceProxy
cd iceProxy
npm install
npx wrangler deploy
```

**That's it.** No KV namespace, no secrets, no provider keys. The default model
(`pollinations/gpt-oss-20b`) needs none of them, so the deployed URL answers
`/v1/chat/completions` immediately. Verify with:

```bash
curl -X POST https://ice-proxy.YOUR-SUBDOMAIN.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

`curl -s https://ice-proxy.YOUR-SUBDOMAIN.workers.dev/health` should report
`"providers_keyless":["pollinations"]`.

`./deploy.sh` does the same thing plus runs the tests first, and (when you later
want more models) creates the KV namespace and writes its id back into
`wrangler.toml`. It's idempotent — running it again is safe.

### 2. Unlock more models (all optional)

Everything below is opt-in. Nothing here is required for the proxy to work.

**Qwen** — no static key, just a one-time account login; add more accounts to
multiply the quota:

```bash
node scripts/auth.js add
```

**Everyone else** — a provider key each:

```bash
npx wrangler secret put GEMINI_API_KEY      # https://aistudio.google.com/apikey
npx wrangler secret put GLM_API_KEY         # https://bigmodel.cn/
npx wrangler secret put CEREBRAS_API_KEY    # https://cloud.cerebras.ai/
npx wrangler secret put GROQ_API_KEY        # https://console.groq.com/keys
npx wrangler secret put OPENROUTER_API_KEY  # https://openrouter.ai/
```

Providers without a key are simply marked unavailable in `/v1/models` — and they
are *skipped in the failover chain rather than failing at request time*. So on a
keyless-only deploy, asking for `gemini/gemini-2.5-flash` transparently falls back
to the keyless provider instead of erroring. Once you `secret put GEMINI_API_KEY`,
the same request starts going to Gemini — no code change, no redeploy of the model
list.

### 3. Lock it down (do this if it's public)

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

### When an upstream ignores `stream: true`

Not every provider honours the flag. If one returns `200` with a non-SSE
`Content-Type`, iceProxy does **not** relay it as a stream — that gives the client
`200 text/event-stream` with no `data:` frames and no `[DONE]`, which is
indistinguishable from a hang. Instead it delivers the response as a normal JSON
completion and marks what happened:

```
X-IceProxy-Stream-Downgraded: 1
```

```json
{ "choices": [ ... ], "_proxy": { "streamDowngraded": true, "attempts": [ ... ] } }
```

You get the whole answer at once instead of waiting for a stream that will never
start. The same principle applies to `X-IceProxy-Fallback`: it is set on **both**
the streaming and non-streaming paths, so a client that watches the header never
mistakes a fallback for a direct hit.

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
npm test                        # 99 tests, no network, no dependencies
node scripts/verify-local.mjs   # end-to-end against a local fake upstream
node scripts/check-docs.mjs     # README vs code consistency
npm run check                   # all three, in order

# the only one that touches the network:
npm run probe                   # are the model IDs upstream still alive?
npm run probe -- --model glm/glm-4.6-flash
npm run probe -- --json         # machine-readable
```

The unit tests mock `globalThis.fetch`, so they run offline and never touch a real
provider. They cover: SSE frame reassembly across arbitrary chunk boundaries,
streaming and non-streaming for every protocol, the failover chain, account pool
rotation/refresh/cooldown, and every historical bug below.

`scripts/probe-models.mjs` is the third thing, and the only one that goes online.
The tests above all answer "is our traffic correct?"; none of them answer "does
upstream still recognise this model name". Free tiers retire model IDs, and that
kind of rot is permanently green locally. `npm run probe` drives the real Worker
against the real providers, one request per model, and reports:

- `✔` answered,
- `🔑` credentials are missing/invalid — **not** a dead model,
- `✖` upstream refused the model itself,
- `⏭` no credential configured on this machine, so not tested.

It never exits non-zero: it is a diagnostic, and someone else's free tier having a
bad day should not turn our CI red. CI runs it against OpenRouter (the one provider
where a probe works without a real account) with a placeholder key — which is
enough, because *"does this model exist"* is answered by the `401` just as well as
by a `200`.

`scripts/verify-local.mjs` is the other half: it stands up a **fake upstream** on
localhost and drives the Worker through real HTTP with a real client's requests —
streaming including a JSON line cut in half, a provider that ignores
`stream: true`, cross-provider failover, error attribution, CORS. It needs no
keys and touches no real provider. **Three of the bugs listed below were found by
it while every unit test was green.**

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
| Chat UI span forever on `stream: true` | Provider ignored `stream`, returned JSON; we relayed it as `text/event-stream` with no `data:` frames and no `[DONE]` | No `Content-Type` assertion. Every upstream response was assumed to be the shape we asked for |
| A normal failover returned **500** | `TypeError: Cannot convert argument to a ByteString` | `servedModel` used `→` (U+2192); HTTP header values must be latin-1 |
| Failover invisible to non-streaming clients | `X-IceProxy-Fallback` was only set on the streaming path | Two response builders, only one of them set the header |
| `/v1/models` read KV once per account | N+1 KV reads, billed as such | Availability only needed `.length`, but `list()` was followed by a `get()` per id |
| "You have no credentials" when you did | A KV hiccup made a configured Qwen account look absent | `accountCount === 0` was read as "provider unavailable" instead of "we couldn't tell" |
| Upstream's refusal was thrown away | `upstream returned non-JSON`, with no hint of *why* | `resp.json()` was tried first; a failed `json()` **consumes the body**, so the follow-up `text()` throws and the diagnostic text (`error code: 1009`, an HTML challenge page) is lost. Now reads the body as text and parses it itself |
| `DEFAULT_MODEL` in `wrangler.toml` did nothing | Changed the var, restarted, default model unchanged | The variable was declared and documented but never read by any code path. A config that silently does nothing is worse than no config — you blame your own edit |

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
- **"Credentials configured" is not "model works".** `/v1/models` answers the first
  question, not the second. Free tiers retire model IDs silently, so run
  `npm run probe` against your own keys before trusting the list — that is exactly
  why the prober exists.
- **A provider that fails to *parse* used to lose its own error message.** Fixed in
  3.1.0: the raw body is preserved, so a refusal from a gateway
  (`error code: 1009`, an HTML challenge page) now shows up verbatim instead of as
  a generic "upstream returned non-JSON".
- **No embeddings or moderation endpoints.** Inference only.
- **Non-streaming requests time out after 60s**, streaming ones don't have a
  total-duration cap (a model thinking for 90s before its first token is normal).
  A streaming response that never produces a frame relies on the client's own
  timeout.

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
