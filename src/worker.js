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
  resolveDefaultModel,
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
  providerNeedsKey,
  classifyStatus,
  readJsonOrText
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
  const keyless = [];
  for (const [prefix, p] of Object.entries(PROVIDERS)) {
    if (p.auth === "none") keyless.push(prefix);
    if (p.auth === "key" && env?.[p.keyEnv]) configured.add(p.keyEnv);
  }
  return ok({
    status: "ok",
    service: "iceProxy",
    models: MODELS.length,
    // 只报「哪些密钥已配置」，不回显值
    providers_ready: [...configured],
    // 免密钥 provider：没有任何配置也应该能用
    providers_keyless: keyless,
    default_model: resolveDefaultModel(env),
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
  // 只要「多少个账号」，所以用 count()：一次 KV list。
  // 旧写法 list() 之后在循环里对每个账号再 get()，而那些值只被 .length 用掉。
  const accountCount = await pool.count();
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
  if (provider.auth === "none") return true; // 不需要凭据，永远可用
  if (provider.auth === "qwen-oauth") return accountCount > 0;
  return !!resolveApiKey(provider, env);
}

// ---------- 单次上游调用 ----------

/**
 * 请求上游的超时上限（毫秒）。
 *
 * 只用在**非流式**请求上：上游收了请求却不回应时，Workers 会一直挂着，
 * 客户端也只有干等的份。流式请求不能套总时长上限 —— 模型先思考 90 秒
 * 再开始吐字是正常的，掐掉等于把长回答全废了。流式的活性判断见
 * assertStreamingResponse 的注释。
 */
export const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * 同一个 provider 的重试次数与退避。
 *
 * 为什么需要：免费上游会**成片地**抽风 —— 实测 pollinations 会出现
 * `ENOSPC: no space left on device`（它自己磁盘满了）和整段的 402。
 * 隔一秒再试往往就好了。不给重试的话，一次瞬时抖动就会让候选链白白烧掉
 * 一个名额（候选链最多 4 个，烧不起）。
 *
 * 只对**临时性**错误重试（见 isTransient）；400 这种「请求本身错了」
 * 不重试，试一万次也是一样。
 */
const UPSTREAM_RETRIES = 1;
const UPSTREAM_RETRY_DELAY_MS = 250;

/**
 * 发起一次上游请求，返回 { resp, ... }。
 *
 * 这里**不再改写 stream 字段** —— 客户端要流式就传流式，要非流式就传非流式。
 * 上一版在 openai-compat 分支硬编码 `stream: false`，是「流式请求收到
 * 非流式响应」这个 bug 的根因。
 *
 * 流式调用方**必须**再调 assertStreamingResponse(resp)：上游可能无视
 * `stream: true` 直接回一个普通 JSON。
 */
async function callUpstream({ entry, body, env, pool, stream }) {
  const { provider, upstreamModel } = entry;
  const timeout = stream ? null : UPSTREAM_TIMEOUT_MS;
  const init = (headers, payload) => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(payload),
    ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {})
  });

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
    const resp = await fetch(
      `${provider.base}/chat/completions`,
      init({ Authorization: `Bearer ${account.access_token}` }, upstream)
    );
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
      init({}, payload)
    );
    return { resp, gemini: true };
  }

  // openai 兼容：GLM / Cerebras / Groq / OpenRouter + 免密钥的 Pollinations
  const key = resolveApiKey(provider, env);
  if (providerNeedsKey(provider) && !key) {
    throw new AuthFailure(`missing_key:${provider.keyEnv}`);
  }
  const upstream = { ...body, model: upstreamModel, stream };
  delete upstream.provider;
  // 免密钥 provider 不带 Authorization 头 —— 带了反而会被上游当成无效凭据拒掉
  const authHeader = key ? { Authorization: `Bearer ${key}` } : {};
  const resp = await fetch(
    `${provider.base}/chat/completions`,
    init({ ...authHeader, ...(provider.extraHeaders || {}) }, upstream)
  );
  return { resp };
}

class NonStreamingUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = "NonStreamingUpstreamError";
  }
}

/**
 * 「我要的是流，上游却给了普通 JSON」——调用方据此改成非流式交付。
 *
 * 症状（修之前）：客户端发 `stream: true`，某个上游因为自身策略无视了这个字段，
 * 回 200 + `application/json`。旧代码不做任何检查，直接把它套进
 * makeStreamResponse：客户端收到 200 + `text/event-stream`，然后是一坨
 * 没有 `data:` 前缀的 JSON 文本，也没有 `[DONE]`。表现就是**界面一直转圈**，
 * 而日志里什么都看不出来 —— 上游是 200，我们也是 200。
 *
 * 现在：返回一个错误对象表示「需要降级」，由调用方切换成非流式路径，
 * 并在响应里带上 `_proxy.streamDowngraded` + `X-IceProxy-Stream-Downgraded`。
 * 客户端至少能立刻拿到完整回答，而不是等一个永远不会来的帧。
 */
function assertStreamingResponse(resp) {
  const ctype = (resp.headers.get("Content-Type") || "").toLowerCase();
  if (ctype.includes("text/event-stream")) return null;
  return new NonStreamingUpstreamError(
    `上游没有返回事件流（Content-Type: ${ctype || "未声明"}），已按非流式交付`
  );
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

  // 「这个 provider 现在能试吗」有三种答案，不能压成两种：
  //   ready  确定能用（静态密钥配了，或 Qwen 账号数 > 0）
  //   maybe  说不清 —— Qwen 有 KV binding 但账号数读出来是 0，
  //          分不清「真没账号」还是「KV 刚抖动 / list 失败」
  //   no     确定不能用（静态密钥没配）
  //
  // maybe 必须单独对待：**不摘掉它**（一次 KV 抖动不该让配了账号的人看到
  // 「你没配凭据」），但**也不让它排在确定能用的 provider 前面** ——
  // 否则一个空账号池会永远占着第一顺位白试一次，把真正配好的 provider
  // 挤出 4 次尝试的窗口。
  const readiness = (p) => {
    if (p.auth === "none") return "ready"; // 免密钥，天然就绪
    if (p.auth === "qwen-oauth") return accountCount > 0 ? "ready" : "maybe";
    return isProviderReady(p, env, accountCount) ? "ready" : "no";
  };
  const allowed = (p) => readiness(p) !== "no";

  // 主模型自身也要检查凭据：否则「一个密钥都没配」会得到一个非空候选链，
  // 一路试到最后一个 provider 才报错，错误信息也说不清到底缺什么。
  const chain = allowed(primary.provider) ? [primary] : [];
  const seen = new Set([modelId]);

  for (const m of MODELS) {
    const e = catalog.get(m.id);
    if (seen.has(m.id)) continue;
    // 同 provider 的其它模型紧跟 primary：同一份凭据，最便宜的一次重试，
    // 不该被别的 provider 插队。
    if (e.prefix === primary.prefix && allowed(e.provider)) {
      seen.add(m.id);
      chain.push(e);
    }
  }

  // 其它 provider：确定能用的先上，maybe 的垫底。
  const others = [];
  for (const m of MODELS) {
    const e = catalog.get(m.id);
    if (seen.has(m.id) || e.prefix === primary.prefix || !allowed(e.provider)) continue;
    seen.add(m.id);
    others.push(e);
  }
  others.sort((a, b) => (readiness(a.provider) === "ready" ? 0 : 1) - (readiness(b.provider) === "ready" ? 0 : 1));
  for (const e of others) if (!chain.some((c) => c.id === e.id)) chain.push(e);

  return chain.slice(0, 4); // 别无限重试，用户等不起
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 这个失败值得**原地重试同一个 provider**吗？
 *
 * 和 isRetryable 的区别是刻意的，别合并：
 *   - 429（限流）：额度已经用完了，250ms 后再打还是 429。该换 provider。
 *   - 401/403（认证）：凭据错了，重试一万次也一样。该换 provider。
 *   - 402：免费额度耗尽/参数要付费。同样该换。
 *   - 5xx / 408 / 425：上游瞬时抽风（实测 pollinations 的 ENOSPC 就是 500）。
 *     这才是「等一下就好」的情况，值得原地重试一次。
 *   - 网络层异常（超时、连接被切）：同上，值得重试。
 */
function isTransient(status) {
  return status === 408 || status === 425 || status >= 500;
}

/** 这个状态码值得换个 provider 再试吗？ */
function isRetryable(status) {
  // 402/408/425 也归进来。它们看着像「客户端的错」，其实是上游的临时状态：
  //   - 402 Payment Required：免费档额度用尽 / 这个模型或参数要付费。
  //     实测 pollinations 对 `tools`、`system` 角色、以及偶发抽风都回 402 ——
  //     换个 provider 完全可能成功，所以必须回退，不能当硬错误丢给用户。
  //   - 408 请求超时、425 Too Early：重试有意义的临时状态。
  return (
    status === 402 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 401 ||
    status === 403 ||
    status >= 500
  );
}

/**
 * 上游回 200，但 body 里没有任何可用的回答吗？
 *
 * 为什么需要：真实上游会**偶发**回一个空 `{}` —— HTTP 200、Content-Type 正常，
 * 但既没有 choices 也没有 error（实测 pollinations 会出现）。假上游永远不会
 * 这样，所以单测和离线 e2e 都照不到。
 *
 * 旧行为是原样透传成 `choices: []`，客户端拿到「成功但没有内容」，只能自己猜。
 * 现在把它当成一次失败，继续走候选链 —— 下一个 provider 往往是好的。
 *
 * 只用于**非流式**：流式判断「有没有内容」要读完整个流，破坏实时性，不值得。
 */
export function isEmptyCompletion(d) {
  if (!d || typeof d !== "object") return true;
  if (d.error) return false; // 有 error 就交给错误路径，别在这里吞
  if (!Array.isArray(d.choices) || d.choices.length === 0) return true;
  const c = d.choices[0];
  const content = c?.message?.content ?? c?.text ?? "";
  const hasToolCall = Array.isArray(c?.message?.tool_calls) && c.message.tool_calls.length > 0;
  return !String(content).trim() && !hasToolCall;
}

// ---------- 主处理 ----------

async function handleChat(rawBody, env, pool, wantStream) {
  const body = buildUpstreamBody(rawBody);
  // 客户端没指定 model 时用环境变量里的默认模型（wrangler.toml 的 DEFAULT_MODEL）。
  // 在这之前那个变量是死的 —— 声明了、注释也写了「改这里就能换默认模型」，
  // 但代码从没读过，属于「改了没反应还找不到原因」的那类配置。
  const requested = rawBody.model || resolveDefaultModel(env);

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

  const accountCount = await pool.count();

  const chain = buildFallbackChain(requested, env, accountCount);
  if (!chain.length) {
    return errorResponse(
      `没有可用于 ${requested} 的凭据。请配置对应的密钥，或用 /v1/auth/start 添加 Qwen 账号。`,
      { status: 400, type: "invalid_request_error", code: "no_credentials" }
    );
  }

  const attempts = [];
  // 有多少次失败是「凭据缺失」造成的。全是的话，报错该指向「去配凭据」，
  // 而不是丢一句 502 —— 502 听起来像上游挂了，用户会去查网络。
  let credentialErrors = 0;
  for (const entry of chain) {
    let out;
    // 对同一个 provider 做有限重试：临时抖动（上游磁盘满、边缘 5xx）
    // 隔一下再试通常就好，比直接换 provider 更省额度。
    for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt++) {
      try {
        out = await callUpstream({ entry, body, env, pool, stream: wantStream });
      } catch (e) {
        out = { error: e };
      }
      // 网络层就抛了（超时/连接断）—— 值得原地重试
      if (out?.error) {
        const e = out.error;
        if (e instanceof AuthFailure) break; // 凭据问题，重试无意义
        if (attempt < UPSTREAM_RETRIES) {
          await sleep(UPSTREAM_RETRY_DELAY_MS);
          continue;
        }
        break;
      }
      if (isTransient(out.resp.status) && attempt < UPSTREAM_RETRIES) {
        await sleep(UPSTREAM_RETRY_DELAY_MS);
        continue;
      }
      break;
    }

    // 调用阶段就失败了（没拿到 Response）：区分「凭据缺失」和「真出错」。
    if (out?.error) {
      const e = out.error;
      if (e instanceof AuthFailure && e.message.startsWith("missing_key:")) {
        attempts.push({ model: entry.id, error: `缺少密钥 ${e.message.split(":")[1]}` });
        credentialErrors++;
        continue;
      }
      if (e instanceof AuthFailure && e.message === "no_qwen_account") {
        attempts.push({ model: entry.id, error: "没有可用的 Qwen 账号" });
        credentialErrors++;
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
      const downgrade = assertStreamingResponse(resp);
      if (!downgrade) {
        return makeStreamResponse({ entry, resp, model: requested, meta });
      }
      // 上游不听「stream: true」。降级但不静默：响应体照旧是合法 JSON，
      // 另外把这件事写进 _proxy 和响应头。
      attempts.push({ model: entry.id, error: downgrade.message });
      meta.streamDowngraded = true;
      return makeJsonResponse({
        entry,
        resp,
        model: requested,
        meta,
        headers: { "X-IceProxy-Stream-Downgraded": "1" }
      });
    }
    // 非流式：先读一次 body，挡掉「200 但空完成」这种偶发情况并继续回退。
    // 只为**OpenAI 协议**的 provider 做这个判断 —— Gemini 的 JSON 里是
    // `candidates` 而不是 `choices`，拿 isEmptyCompletion 去量它必然误判为空。
    // 读出来的解析结果原样传给 makeJsonResponse，不重复读 body。
    const peeked = await readJsonOrText(resp);
    const openaiShape = entry.provider.protocol !== "gemini";
    if (openaiShape && !peeked._nonJson && isEmptyCompletion(peeked)) {
      attempts.push({ model: entry.id, error: "上游返回了空的完成（HTTP 200 但无内容）" });
      continue;
    }
    return makeJsonResponse({ entry, resp, peeked, model: requested, meta });
  }

  const detail = attempts.map((a) => `${a.model}: ${a.error}`).join(" | ");
  if (attempts.length && credentialErrors === attempts.length) {
    return errorResponse(
      `没有可用于 ${requested} 的凭据。请配置对应 provider 的密钥，或用 node scripts/auth.js add 添加 Qwen 账号。`,
      { status: 400, type: "invalid_request_error", code: "no_credentials" }
    );
  }
  return upstreamError(`所有候选 provider 都失败了。${detail}`);
}

/**
 * 回退信息要同时出现在 body 的 `_proxy` 和响应头上（README 承诺了后者）。
 *
 * 两个坑，都是这套代码真踩过的：
 *   1. **头部值只能是 ASCII（ByteString）。** `servedModel` 为了可读用了
 *      `→`（U+2192），直接塞进 header 会让 `new Response()` 抛
 *      「Cannot convert argument to a ByteString」—— 一次正常的回退直接变成 500。
 *      header 用 ASCII 的 `->`，可读性交给 body 里的 `_proxy`。
 *   2. **非流式那条路以前完全不设这个头**，只在 body 里说。客户端若按头判断，
 *      非流式场景会把回退当正常响应。
 */
function fallbackHeaders(meta) {
  if (!meta?.fellBack) return {};
  return { "X-IceProxy-Fallback": String(meta.servedModel).replace(/[^\x20-\x7e]/g, "->") };
}

async function makeJsonResponse({ entry, resp, peeked = null, model, meta, headers = {} }) {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  headers = { ...fallbackHeaders(meta), ...headers };

  // Gemini 需要翻译形状，OpenAI 兼容的直接透传
  if (entry.provider.protocol === "gemini") {
    const d = peeked ?? (await readJsonOrText(resp));
    if (d._nonJson) {
      return upstreamError(`上游返回了非 JSON 内容（HTTP ${resp.status}，${resp.headers.get("Content-Type") || "未声明类型"}）：${d.text}`);
    }
    if (d.error) return upstreamError(d.error.message || JSON.stringify(d.error), 502);
    const { text, usage, finishReason } = fromGeminiResponse(d, model);
    return ok(
      {
        ...requireOpenaiShape({ id, created, model, content: text, usage, finishReason }),
        _proxy: meta
      },
      headers
    );
  }

  const d = peeked ?? (await readJsonOrText(resp));
  if (d._nonJson) {
    // 网关/边缘节点拒绝时回的是纯文本（例如 GFW 的 RST、Cloudflare 的 1009），
    // 那段文本本身就是最有用的诊断，别丢。
    return upstreamError(
      `上游返回了非 JSON 内容（HTTP ${resp.status}，${resp.headers.get("Content-Type") || "未声明类型"}）：${d.text}`
    );
  }
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
  }, headers);
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

  return streamResponse(stream, fallbackHeaders(meta));
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
  assertStreamingResponse,
  NonStreamingUpstreamError,
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
  // 概览逻辑收进账号池：它更清楚「哪些字段能外泄」，别再散在路由层
  const accounts = await pool.accounts();
  const total = accounts.length;
  const providers = {};
  for (const [prefix, p] of Object.entries(PROVIDERS)) {
    providers[prefix] =
      p.auth === "none" ? true : p.auth === "qwen-oauth" ? total > 0 : !!resolveApiKey(p, env);
  }
  return ok({ total, accounts, providers });
}
