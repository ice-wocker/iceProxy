/**
 * iceProxy —— 把多家免费 AI 模型聚合成一个 OpenAI 兼容端点。
 *
 * 架构：
 *   worker.js      路由与编排（本文件）
 *   providers.js   模型目录 + provider 注册表（单一真相源）
 *   accounts.js    Qwen OAuth 账号池（轮换 / 刷新 / 冷却）
 *   adapters.js    各家协议适配（含 Gemini 的翻译）
 *   openai.js      OpenAI 协议形状（SSE 帧、错误体）
 *
 * 部署：npx wrangler deploy
 * 密钥：见 README 的「密钥」一节
 */

import {
  PROVIDERS,
  MODELS,
  DEFAULT_MODEL,
  buildCatalog
} from "./providers.js";
import {
  AccountPool,
  AuthFailure
} from "./accounts.js";
import {
  toGeminiPayload,
  fromGeminiResponse,
  iterGeminiDeltas,
  iterOpenAiDeltas,
  resolveApiKey,
  classifyStatus
} from "./adapters.js";
import {
  corsHeaders,
  errorResponse,
  upstreamError,
  ok,
  completionId,
  sseChunk,
  sseDone,
  streamResponse,
  iterSsePayloads
} from "./openai.js";
import { QWEN_DEVICE_CODE_URL, QWEN_TOKEN_URL, QWEN_CLIENT_ID } from "./accounts.js";

const catalog = buildCatalog();

// ---------- 鉴权 ----------

/**
 * 校验客户端 API key。
 *
 * 未配置 OPENAI_API_KEYS 时放行：本地 `wrangler dev` 和自用场景不需要，
 * 强迫配置只会让人多一道坎。
 */
export function checkApiKey(request, env) {
  const configured = env?.OPENAI_API_KEYS;
  if (!configured) return true;
  const allowed = String(configured)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return true;
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // 常量时间比较，避免通过响应时间逐字节猜 key
  return allowed.some((k) => timingSafeEqual(k, m[1]));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- 路由处理 ----------

function handleHealth(env) {
  const configured = new Set();
  for (const p of Object.values(PROVIDERS)) {
    if (p.auth === "key" && env?.[p.keyEnv]) configured.add(p.keyEnv);
  }
  return ok({
    status: "ok",
    service: "iceProxy",
    models: MODELS.length,
    // 只报「哪些密钥已配置」，不回显值
    providers_ready: [...configured],
    qwen_pool: !!env?.ACCOUNTS
  });
}

/**
 * /v1/models —— 返回 OpenAI 形状的模型列表。
 *
 * 比官方多两个非标准字段（context_length / capabilities / provider），
 * 标准客户端会忽略它们，而需要判断上下文的客户端能用上。
 */
async function handleModels(env, pool) {
  let accountCount = 0;
  if (pool?.enabled) {
    try {
      accountCount = (await pool.list()).length;
    } catch {
      accountCount = 0;
    }
  }
  const data = MODELS.map((m) => {
    const entry = catalog.get(m.id);
    const ready = isProviderReady(entry.provider, env, accountCount);
    return {
      id: m.id,
      object: "model",
      created: 0,
      owned_by: entry.prefix,
      provider: entry.provider.label,
      context_length: entry.ctx,
      capabilities: entry.caps,
      // 非标准但很有用：告诉客户端这个模型此刻能不能用
      available: ready
    };
  });
  return ok({ object: "list", data });
}

function isProviderReady(provider, env, accountCount) {
  if (provider.auth === "qwen-oauth") return accountCount > 0;
  return !!resolveApiKey(provider, env);
}

// ---------- 单次上游调用 ----------

/**
 * 发起一次上游请求，返回原始 Response。
 *
 * 这里**不再改写 stream 字段** —— 客户端要流式就传流式，要非流式就传非流式。
 * 上一版在 openai-compat 分支硬编码 `stream: false`，是「流式请求收到
 * 非流式响应」这个 bug 的根因。
 */
async function callUpstream({ entry, body, env, pool, stream }) {
  const { provider, upstreamModel } = entry;

  if (provider.auth === "qwen-oauth") {
    const acc = await pool.pick();
    if (!acc) throw new AuthFailure("no_qwen_account");
    let account = acc.acc;
    let accountId = acc.id;
    if (acc.needsRefresh) {
      try {
        account = await pool.refresh(acc.id, acc.acc);
      } catch (e) {
        await pool.penalize(acc.id, acc.acc, e instanceof AuthFailure ? "auth_failure" : "network");
        throw e;
      }
    }
    const upstream = { ...body, model: upstreamModel, stream };
    const resp = await fetch(`${provider.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.access_token}`
      },
      body: JSON.stringify(upstream)
    });
    return { resp, accountId, account };
  }

  if (provider.protocol === "gemini") {
    const key = resolveApiKey(provider, env);
    if (!key) throw new AuthFailure(`missing_key:${provider.keyEnv}`);
    const payload = toGeminiPayload(body);
    const method = stream ? "streamGenerateContent" : "generateContent";
    const suffix = stream ? "&alt=sse" : "";
    const resp = await fetch(
      `${provider.base}/models/${upstreamModel}:${method}?key=${encodeURIComponent(key)}${suffix}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    return { resp, gemini: true };
  }

  // openai 兼容：GLM / Cerebras / Groq / OpenRouter
  const key = resolveApiKey(provider, env);
  if (!key) throw new AuthFailure(`missing_key:${provider.keyEnv}`);
  const upstream = { ...body, model: upstreamModel, stream };
  delete upstream.provider;
  const resp = await fetch(`${provider.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(provider.extraHeaders || {})
    },
    body: JSON.stringify(upstream)
  });
  return { resp };
}

/** 从请求体里挑出该转发给上游的字段，避免把客户端私有字段透传过去。 */
export function buildUpstreamBody(body) {
  const out = {};
  const pass = [
    "messages",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "response_format",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning_effort",
    "user"
  ];
  for (const k of pass) if (body[k] !== undefined) out[k] = body[k];
  // 只保留 user/assistant/system/tool 角色，且 content 必须是字符串或数组
  out.messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && typeof m === "object" && m.role)
    .map((m) => ({ ...m, content: m.content ?? "" }));
  return out;
}

// ---------- 候选链（跨 provider 回退）----------

/**
 * 决定这次请求可以依次尝试哪些 provider。
 *
 * 上一版 README 写着「自动跨 provider 故障转移」，但代码里
 * 只有 Qwen 的**账号**轮换，没有任何跨 provider 回退 —— 文档在说谎。
 *
 * 现在的规则：
 *   1. 首选客户端指定的模型；
 *   2. 然后是同 provider 的其他模型（同密钥，最省事）；
 *   3. 最后是其它「已配置好密钥」的 provider 的默认模型。
 * 只有在上游返回可重试错误时才往下走，客户端参数错误（400）不重试。
 */
export function buildFallbackChain(modelId, env, accountCount) {
  const primary = catalog.get(modelId);
  if (!primary) return [];
  // 主模型自身也要检查凭据：否则「没配任何密钥」会得到一个非空候选链，
  // 一路试到最后一个 provider 才报错，错误信息也说不清到底缺什么。
  const chain = isProviderReady(primary.provider, env, accountCount) ? [primary] : [];
  const seen = new Set([modelId]);

  for (const m of MODELS) {
    const e = catalog.get(m.id);
    if (seen.has(m.id)) continue;
    if (e.prefix === primary.prefix && isProviderReady(e.provider, env, accountCount)) {
      seen.add(m.id);
      chain.push(e);
    }
  }
  for (const m of MODELS) {
    const e = catalog.get(m.id);
    if (seen.has(m.id)) continue;
    if (e.prefix !== primary.prefix && isProviderReady(e.provider, env, accountCount)) {
      seen.add(m.id);
      chain.push(e);
    }
  }
  return chain.slice(0, 4); // 别无限重试，用户等不起
}

/** 这个状态码值得换个 provider 再试吗？ */
function isRetryable(status) {
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

// ---------- 主处理 ----------

async function handleChat(rawBody, env, pool, wantStream) {
  const body = buildUpstreamBody(rawBody);
  const requested = rawBody.model || DEFAULT_MODEL;

  if (!catalog.has(requested)) {
    const available = MODELS.map((m) => m.id).join(", ");
    return errorResponse(
      `unknown model: ${requested}. Available models: ${available}`,
      { type: "invalid_request_error", code: "model_not_found", param: "model" }
    );
  }
  if (!body.messages.length) {
    return errorResponse("messages 不能为空", { param: "messages" });
  }

  let accountCount = 0;
  if (pool?.enabled) {
    try {
      accountCount = (await pool.list()).length;
    } catch {
      accountCount = 0;
    }
  }

  const chain = buildFallbackChain(requested, env, accountCount);
  if (!chain.length) {
    return errorResponse(
      `没有可用于 ${requested} 的凭据。请配置对应的密钥，或用 /v1/auth/start 添加 Qwen 账号。`,
      { status: 400, type: "invalid_request_error", code: "no_credentials" }
    );
  }

  const attempts = [];
  for (const entry of chain) {
    let out;
    try {
      out = await callUpstream({ entry, body, env, pool, stream: wantStream });
    } catch (e) {
      if (e instanceof AuthFailure && e.message.startsWith("missing_key:")) {
        attempts.push({ model: entry.id, error: `缺少密钥 ${e.message.split(":")[1]}` });
        continue;
      }
      if (e instanceof AuthFailure && e.message === "no_qwen_account") {
        attempts.push({ model: entry.id, error: "没有可用的 Qwen 账号" });
        continue;
      }
      attempts.push({ model: entry.id, error: e.message });
      continue;
    }

    const { resp } = out;
    if (!resp.ok) {
      const reason = classifyStatus(resp.status);
      if (out.accountId && pool) {
        await pool.penalize(out.accountId, out.account, reason);
      }
      const text = await resp.text().catch(() => "");
      attempts.push({ model: entry.id, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` });
      // 只有可重试的错误才继续往下试；400 说明是请求本身的问题，换个 provider 也一样
      if (!isRetryable(resp.status)) {
        return upstreamError(
          `上游拒绝请求（${entry.id}）：${text.slice(0, 500)}`,
          resp.status >= 400 && resp.status < 500 ? 400 : 502
        );
      }
      continue;
    }

    // 成功：请求的模型和实际用的不一致时，在响应里标出来（非标准字段，但有用）
    const servedModel = entry.id === requested ? entry.id : `${requested}→${entry.id}`;
    const meta = { servedModel, fellBack: entry.id !== requested, attempts };

    if (wantStream) {
      return makeStreamResponse({ entry, resp, model: requested, meta });
    }
    return makeJsonResponse({ entry, resp, model: requested, meta });
  }

  const detail = attempts.map((a) => `${a.model}: ${a.error}`).join(" | ");
  return upstreamError(`所有候选 provider 都失败了。${detail}`);
}

async function makeJsonResponse({ entry, resp, model, meta }) {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);

  // Gemini 需要翻译形状，OpenAI 兼容的直接透传
  if (entry.provider.protocol === "gemini") {
    const d = await resp.json().catch(() => null);
    if (!d) return upstreamError("上游返回了非 JSON 内容");
    if (d.error) return upstreamError(d.error.message || JSON.stringify(d.error), 502);
    const { text, usage, finishReason } = fromGeminiResponse(d, model);
    return ok({
      ...requireOpenaiShape({ id, created, model, content: text, usage, finishReason }),
      _proxy: meta
    });
  }

  const d = await resp.json().catch(() => null);
  if (!d) return upstreamError("上游返回了非 JSON 内容");
  if (d.error) return upstreamError(d.error.message || JSON.stringify(d.error), 502);
  // 上游的 usage/model 保持原样，只补上缺失的字段
  return ok({
    id: d.id || id,
    object: "chat.completion",
    created: d.created || created,
    model: d.model || model,
    choices: (d.choices || []).map((c, i) => ({
      index: c.index ?? i,
      message: {
        role: "assistant",
        content: c.message?.content ?? "",
        ...(c.message?.reasoning_content ? { reasoning_content: c.message.reasoning_content } : {}),
        ...(c.message?.tool_calls ? { tool_calls: c.message.tool_calls } : {})
      },
      finish_reason: c.finish_reason ?? "stop"
    })),
    usage: d.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _proxy: meta
  });
}

function requireOpenaiShape({ id, created, model, content, usage, finishReason }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

/** 流式：把上游的流实时转成 OpenAI 的 SSE。 */
async function makeStreamResponse({ entry, resp, model, meta }) {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const isGemini = entry.provider.protocol === "gemini";
  const upstreamBody = resp.body;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (s) => controller.enqueue(enc.encode(s));
      let emittedUsage = null;
      let finishReason = "stop";
      try {
        // 首帧先声明助手角色，官方 SDK 依赖这一帧建立 message 对象
        send(sseChunk({ id, created, model, delta: { role: "assistant", content: "" } }));

        const source = isGemini ? iterGeminiDeltas(upstreamBody) : iterOpenAiDeltas(upstreamBody);
        for await (const ev of source) {
          if (ev.usage) emittedUsage = ev.usage;
          if (ev.text) {
            send(sseChunk({ id, created, model, delta: { content: ev.text } }));
          }
          if (ev.reasoning) {
            send(sseChunk({ id, created, model, delta: { reasoning_content: ev.reasoning } }));
          }
          if (ev.finish) {
            finishReason = ev.finish === "MAX_TOKENS" ? "length" : ev.finish;
          }
        }
        // 末帧带上 finish_reason 和 usage（有的话）
        const last = { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
        if (emittedUsage) last.usage = emittedUsage;
        send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, ...last })}\n\n`);
        send(sseDone());
      } catch (e) {
        // 已经发出 200 头了，只能把错误塞进流里
        send(`data: ${JSON.stringify({ error: { message: String(e?.message || e), type: "upstream_error" } })}\n\n`);
        send(sseDone());
      } finally {
        controller.close();
      }
    }
  });

  const headers = {};
  if (meta.fellBack) headers["X-IceProxy-Fallback"] = meta.servedModel;
  return streamResponse(stream);
}

// ---------- Qwen OAuth 设备流 ----------

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

export async function startQwenAuth() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await sha256(verifier));
  const body = new URLSearchParams({
    client_id: QWEN_CLIENT_ID,
    scope: "openid profile email model.completion",
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  const r = await fetch(QWEN_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`auth init failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return { ...d, code_verifier: verifier };
}

export async function pollQwenToken(deviceCode, verifier) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: QWEN_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: verifier
  });
  const r = await fetch(QWEN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// ---------- 导出（供测试使用；Worker 运行时只认 default）----------

export {
  PROVIDERS,
  MODELS,
  DEFAULT_MODEL,
  catalog,
  corsHeaders,
  AccountPool,
  AuthFailure
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const pool = new AccountPool(env);

    try {
      if (path === "/" || path === "/health") {
        return handleHealth(env);
      }
      if (path === "/v1/models" && request.method === "GET") {
        if (!checkApiKey(request, env)) return unauthorized();
        return await handleModels(env, pool);
      }
      if (path === "/v1/chat/completions" && request.method === "POST") {
        if (!checkApiKey(request, env)) return unauthorized();
        let body;
        try {
          body = await request.json();
        } catch {
          return errorResponse("请求体不是合法 JSON");
        }
        if (!body || typeof body !== "object") {
          return errorResponse("请求体必须是 JSON 对象");
        }
        return await handleChat(body, env, pool, !!body.stream);
      }
      if (path === "/v1/auth/start" && request.method === "POST") {
        if (!checkApiKey(request, env)) return unauthorized();
        const d = await startQwenAuth();
        return ok({
          device_code: d.device_code,
          user_code: d.user_code,
          verification_uri: d.verification_uri,
          verification_uri_complete: d.verification_uri_complete,
          expires_in: d.expires_in,
          interval: d.interval || 5,
          code_verifier: d.code_verifier
        });
      }
      if (path === "/v1/auth/poll" && request.method === "POST") {
        if (!checkApiKey(request, env)) return unauthorized();
        const body = await request.json().catch(() => ({}));
        if (!body.device_code || !body.code_verifier) {
          return errorResponse("缺少 device_code 或 code_verifier");
        }
        const r = await pollQwenToken(body.device_code, body.code_verifier);
        if (r.status === 200 && r.data.access_token) {
          const id = body.account_id || `qwen_${Date.now()}`;
          await pool.put(id, {
            access_token: r.data.access_token,
            refresh_token: r.data.refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + (r.data.expires_in || 3600),
            type: "qwen-oauth",
            created_at: new Date().toISOString()
          });
          return ok({ status: "ok", account_id: id });
        }
        // 把上游的原始错误体透传，前端据此区分 pending / slow_down
        return new Response(JSON.stringify(r.data), {
          status: r.status === 200 ? 400 : r.status,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }
      if (path === "/admin/health" && request.method === "GET") {
        return await handleAdminHealth(request, env, pool);
      }
      return errorResponse(`no route: ${path}`, {
        status: 404,
        type: "invalid_request_error",
        code: "not_found"
      });
    } catch (e) {
      console.error("unhandled", e?.stack || e);
      return errorResponse(`内部错误：${e?.message || e}`, { status: 500, type: "internal_error" });
    }
  }
};

function unauthorized() {
  return errorResponse("无效的 API key", { status: 401, type: "authentication_error", code: "invalid_api_key" });
}

/** 管理端健康检查。ADMIN_SECRET 未配置时拒绝访问，避免泄露账号列表。 */
async function handleAdminHealth(request, env, pool) {
  const secret = env?.ADMIN_SECRET;
  if (!secret) {
    return errorResponse("未配置 ADMIN_SECRET，管理端点已关闭", {
      status: 403,
      type: "permission_error",
      code: "admin_disabled"
    });
  }
  const auth = request.headers.get("Authorization") || "";
  const provided = auth.replace(/^Bearer\s+/i, "");
  if (!timingSafeEqual(String(secret), provided)) {
    return errorResponse("无权访问", { status: 403, type: "permission_error" });
  }
  const ids = await pool.list();
  const accounts = [];
  for (const id of ids) {
    const acc = await pool.get(id);
    accounts.push({
      id,
      has_token: !!acc?.access_token,
      expires_in_min: acc?.expires_at
        ? Math.max(0, Math.floor((acc.expires_at - Date.now() / 1000) / 60))
        : 0,
      cooling_down_until: acc?.cooldown_until ? new Date(acc.cooldown_until).toISOString() : null,
      last_error: acc?.last_error ?? null
    });
  }
  const providers = {};
  for (const [prefix, p] of Object.entries(PROVIDERS)) {
    providers[prefix] = p.auth === "qwen-oauth" ? ids.length > 0 : !!resolveApiKey(p, env);
  }
  return ok({ total: ids.length, accounts, providers });
}
