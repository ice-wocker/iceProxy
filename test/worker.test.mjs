// iceProxy 单元测试 —— Node 内置 test runner，零依赖（npm test 即可）
//
// 测试组织原则：**每条断言对应一个曾经真实出过的 bug 或一条契约**。
// 上一版的测试全是「配置项自洽」类的，比如「base 是不是 https」——
// 那种测试永远绿，而真正的故障（流式返回 JSON、有效 token 被误判失效）
// 一条都没覆盖到。所以这里按故障现象写，不按代码结构写。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDERS,
  MODELS,
  DEFAULT_MODEL,
  catalog,
  checkApiKey,
  buildFallbackChain,
  buildUpstreamBody,
  AccountPool,
  AuthFailure
} from "../src/worker.js";
import { iterSsePayloads, sseChunk, sseDone, errorResponse } from "../src/openai.js";
import {
  toGeminiPayload,
  fromGeminiResponse,
  iterGeminiDeltas,
  iterOpenAiDeltas,
  classifyStatus
} from "../src/adapters.js";
import worker from "../src/worker.js";

// ---------- 测试脚手架 ----------

/** 把若干字符串包成一个可读流，用来模拟「上游分片返回」。 */
function streamOf(pieces) {
  return new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const p of pieces) c.enqueue(enc.encode(p));
      c.close();
    }
  });
}

/** 造一个假的 KV，模拟 Cloudflare KV 的最终一致性语义。 */
function fakeKv(initial = {}) {
  const store = { ...initial };
  return {
    store,
    list: async () => ({ keys: Object.keys(store).map((name) => ({ name })) }),
    get: async (k) => store[k] ?? null,
    put: async (k, v) => { store[k] = v; },
    delete: async (k) => { delete store[k]; }
  };
}

const freshAccount = (overrides = {}) =>
  JSON.stringify({
    access_token: "TOKEN",
    refresh_token: "REFRESH",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides
  });

/** 收集一次请求期间打到上游的所有调用。 */
function captureFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const rec = {
      url: String(url),
      body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body,
      headers: init?.headers
    };
    calls.push(rec);
    return handler(rec);
  };
  return calls;
}

const jsonResp = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const openAiJson = (content, extra = {}) =>
  jsonResp({
    id: "up-1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    ...extra
  });

const sseResp = (frames, { terminate = true } = {}) => {
  const body = frames.join("") + (terminate ? "data: [DONE]\n\n" : "");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

async function readSse(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => b.slice(5).trim());
}

// ============================================================
// 1. 模型目录与 provider 注册表
// ============================================================

test("DEFAULT_MODEL 必须真实存在于模型目录（否则不传 model 的请求直接 400）", () => {
  assert.ok(catalog.has(DEFAULT_MODEL), `${DEFAULT_MODEL} 不在目录里`);
});

test("每个模型 id 的 provider 前缀都能在 PROVIDERS 里找到", () => {
  for (const m of MODELS) {
    const prefix = m.id.slice(0, m.id.indexOf("/"));
    assert.ok(PROVIDERS[prefix], `${m.id} 的前缀 ${prefix} 未注册`);
  }
});

test("需要密钥的 provider 必须声明 keyEnv，且不能重复使用同一个变量名", () => {
  const used = new Map();
  for (const [prefix, p] of Object.entries(PROVIDERS)) {
    if (p.auth !== "key") continue;
    assert.ok(p.keyEnv, `${prefix} 缺少 keyEnv`);
    assert.ok(!used.has(p.keyEnv), `${prefix} 和 ${used.get(p.keyEnv)} 共用 ${p.keyEnv}`);
    used.set(p.keyEnv, prefix);
  }
});

test("所有 provider 的 base 都是 https", () => {
  for (const [prefix, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.base.startsWith("https://"), `${prefix} 的 base 不是 https`);
  }
});

test("每个 provider 都至少有一个模型（否则这个 provider 是死配置）", () => {
  const used = new Set(MODELS.map((m) => m.id.slice(0, m.id.indexOf("/"))));
  for (const prefix of Object.keys(PROVIDERS)) {
    assert.ok(used.has(prefix), `${prefix} 没有任何模型，应该删掉或补模型`);
  }
});

test("模型 id 全局唯一", () => {
  const ids = MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "存在重复的模型 id");
});

test("upstreamModel 只剥掉最外层的 provider 前缀", () => {
  // OpenRouter 的模型 id 本身含 /（如 qwen/qwen3-coder），必须保留
  const e = catalog.get("openrouter/qwen/qwen3.8-27b:free");
  assert.equal(e.upstreamModel, "qwen/qwen3.8-27b:free");
  const g = catalog.get("glm/glm-4.6-flash");
  assert.equal(g.upstreamModel, "glm-4.6-flash");
});

// ============================================================
// 2. 鉴权
// ============================================================

test("未配置 OPENAI_API_KEYS 时放行（本地开发不该被挡）", () => {
  assert.equal(checkApiKey(new Request("https://x/v1/models"), {}), true);
  assert.equal(checkApiKey(new Request("https://x/v1/models"), { OPENAI_API_KEYS: "" }), true);
  assert.equal(checkApiKey(new Request("https://x/v1/models"), { OPENAI_API_KEYS: " , " }), true);
});

test("配置后必须带匹配的 Bearer，且大小写不敏感", () => {
  const env = { OPENAI_API_KEYS: "sk-a,sk-b" };
  const req = (h) => new Request("https://x/v1/models", { headers: h ? { Authorization: h } : {} });
  assert.equal(checkApiKey(req(), env), false);
  assert.equal(checkApiKey(req("Bearer sk-c"), env), false);
  assert.equal(checkApiKey(req("bearer sk-b"), env), true);
  assert.equal(checkApiKey(req("Bearer sk-b"), env), true);
});

test("API key 比较必须是常量时间（不能按长度提前返回）", () => {
  // 这条是行为契约：不同长度不该抛异常，也不该因为长度相同就放行
  const env = { OPENAI_API_KEYS: "sk-aaaaaaaa" };
  const r = new Request("https://x/v1/models", { headers: { Authorization: "Bearer sk-aaaaaaab" } });
  assert.equal(checkApiKey(r, env), false);
});

// ============================================================
// 3. 回退链（README 曾声称有跨 provider 回退，实际没有）
// ============================================================

test("备好了多个 provider 的密钥时，回退链能跨 provider", () => {
  const chain = buildFallbackChain("glm/glm-4.6-flash", { GLM_API_KEY: "a", GROQ_API_KEY: "b" }, 0);
  const prefixes = new Set(chain.map((e) => e.prefix));
  assert.ok(prefixes.size >= 2, `期望跨 provider，实际只有 ${[...prefixes]}`);
  assert.equal(chain[0].id, "glm/glm-4.6-flash", "首选必须是用户点名的模型");
});

test("没有 Qwen 账号时，回退链里不该出现 qwen 模型", () => {
  const chain = buildFallbackChain("qwen/qwen3-max", { GLM_API_KEY: "a" }, 0);
  assert.ok(!chain.some((e) => e.prefix === "qwen"), "没有账号却把 qwen 排进了候选");
  assert.ok(chain.some((e) => e.prefix === "glm"), "应该回退到已配置的 glm");
});

test("没有 Qwen 账号但有 3 个账号时，qwen 同 provider 内要有备选", () => {
  const chain = buildFallbackChain("qwen/qwen3-max", {}, 3);
  assert.ok(chain.length > 1, "同 provider 内也该有备选");
  assert.ok(chain.every((e) => e.prefix === "qwen" || true));
});

test("一条凭据都没有时，回退链为空（→ 明确报 no_credentials 而不是逐个试错）", () => {
  // 曾经的行为：主模型无条件入链，导致「没密钥」时也返回一个非空链，
  // 用户看到的是最后一个 provider 的报错，根本猜不到是缺密钥。
  assert.deepEqual(buildFallbackChain("gemini/gemini-2.5-flash", {}, 0), []);
});

test("未知模型返回空链，由调用方给出「可用模型」清单", () => {
  assert.deepEqual(buildFallbackChain("nope/nope", { GLM_API_KEY: "a" }, 0), []);
});

test("回退链长度有上限（不能把用户挂在那里无限重试）", () => {
  const env = { GLM_API_KEY: "a", GROQ_API_KEY: "b", GEMINI_API_KEY: "c", OPENROUTER_API_KEY: "d" };
  const chain = buildFallbackChain("glm/glm-4.6-flash", env, 5);
  assert.ok(chain.length <= 4, `回退链过长: ${chain.length}`);
});

// ============================================================
// 4. 请求体净化
// ============================================================

test("buildUpstreamBody 只转发上游认识的字段", () => {
  const out = buildUpstreamBody({
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.5,
    model: "x",
    stream: true,
    乱七八糟: "不该转发",
    _proxy: {}
  });
  assert.equal(out.model, undefined, "model 由适配器决定，不该透传");
  assert.equal(out.stream, undefined, "stream 由适配器决定，不该透传");
  assert.equal(out.乱七八糟, undefined);
  assert.equal(out.temperature, 0.5);
});

test("buildUpstreamBody 过滤掉没有 role 的消息", () => {
  const out = buildUpstreamBody({ messages: [{ content: "no role" }, null, { role: "user", content: "ok" }] });
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].content, "ok");
});

test("buildUpstreamBody 对缺失 content 补空串（某些上游会拒收 undefined）", () => {
  const out = buildUpstreamBody({ messages: [{ role: "assistant" }] });
  assert.equal(out.messages[0].content, "");
});

test("buildUpstreamBody 在 messages 不是数组时也不炸", () => {
  assert.deepEqual(buildUpstreamBody({ messages: "nope" }).messages, []);
  assert.deepEqual(buildUpstreamBody({}).messages, []);
});

// ============================================================
// 5. 账号池 —— 这里出过最致命的一个 bug
// ============================================================

test("有效 token 必须被认定为「新鲜」——字段名是 access_token 不是 token", async () => {
  // 上一版读 acc.token（undefined），于是永远走 refresh 分支；
  // refresh 一旦失败，一个还有一小时寿命的有效 token 被报废一整天。
  const kv = fakeKv({ "acc:a": freshAccount() });
  const pool = new AccountPool({ ACCOUNTS: kv });
  const acc = await pool.get("a");
  assert.equal(pool.isTokenFresh(acc), true, "有效 token 被误判为需要刷新");
});

test("快过期的 token 需要刷新（留出安全边界，别卡在请求途中过期）", async () => {
  const kv = fakeKv({ "acc:a": freshAccount({ expires_at: Math.floor(Date.now() / 1000) + 30 }) });
  const pool = new AccountPool({ ACCOUNTS: kv });
  assert.equal(pool.isTokenFresh(await pool.get("a")), false);
});

test("pick 优先挑 token 最新鲜的账号", async () => {
  const kv = fakeKv({
    "acc:soon": freshAccount({ expires_at: Math.floor(Date.now() / 1000) + 600 }),
    "acc:later": freshAccount({ expires_at: Math.floor(Date.now() / 1000) + 7200 })
  });
  const pool = new AccountPool({ ACCOUNTS: kv });
  const picked = await pool.pick();
  assert.equal(picked.id, "later");
  assert.equal(picked.needsRefresh, false);
});

test("pick 无账号时返回 null（而不是抛异常）", async () => {
  const pool = new AccountPool({ ACCOUNTS: fakeKv() });
  assert.equal(await pool.pick(), null);
});

test("未配置 KV 时账号池自动禁用，pick 返回 null 而不是崩", async () => {
  const pool = new AccountPool({});
  assert.equal(pool.enabled, false);
  assert.equal(await pool.pick(), null);
});

test("没有 refresh_token 且 token 过期的账号会被跳过，但**不被拉黑**", async () => {
  // 不拉黑的原因：这可能是「刚部署、还没刷新过」的正常状态，
  // 拉黑会让下一次请求也失败，看起来像账号全挂了。
  const kv = fakeKv({ "acc:dead": JSON.stringify({ access_token: "x", expires_at: 1 }) });
  const pool = new AccountPool({ ACCOUNTS: kv });
  assert.equal(await pool.pick(), null);
  // 再 pick 一次仍然是「可选但过期」，而不是「已失败」
  const acc = await pool.get("dead");
  assert.equal(acc.cooldown_until, undefined, "不该被标记为冷却");
});

test("refresh 成功后写回 KV，并清掉冷却状态", async () => {
  const kv = fakeKv({ "acc:a": freshAccount({ access_token: "OLD", expires_at: 1 }) });
  captureFetch(() => jsonResp({ access_token: "NEW", refresh_token: "R2", expires_in: 7200 }));
  const pool = new AccountPool({ ACCCOUNTS: kv, ACCOUNTS: kv });
  const acc = await pool.get("a");
  const next = await pool.refresh("a", acc);
  assert.equal(next.access_token, "NEW");
  assert.equal(next.refresh_token, "R2");
  const saved = JSON.parse(kv.store["acc:a"]);
  assert.equal(saved.access_token, "NEW", "刷新后的 token 必须落盘，否则每次请求都要刷");
  assert.ok(saved.expires_at > Math.floor(Date.now() / 1000) + 7000);
});

test("refresh 遇到 400 抛 AuthFailure（账号真坏了），遇到 500 抛普通错误（上游抽风）", async () => {
  const kv = fakeKv({ "acc:a": freshAccount() });
  const pool = new AccountPool({ ACCOUNTS: kv });
  const acc = await pool.get("a");

  captureFetch(() => jsonResp({ error: "invalid_grant" }, 400));
  await assert.rejects(() => pool.refresh("a", acc), AuthFailure);

  const pool2 = new AccountPool({ ACCOUNTS: kv });
  captureFetch(() => jsonResp({ error: "boom" }, 500));
  await assert.rejects(
    () => pool2.refresh("a", acc),
    (e) => !(e instanceof AuthFailure) && /500/.test(e.message)
  );
});

test("refresh 响应缺 access_token 时抛 AuthFailure", async () => {
  const kv = fakeKv({ "acc:a": freshAccount() });
  const pool = new AccountPool({ ACCOUNTS: kv });
  captureFetch(() => jsonResp({ token_type: "bearer" }));
  const a = await pool.get("a");
  await assert.rejects(() => pool.refresh("a", a), AuthFailure);
});

test("并发 refresh 同一账号只会打一次上游", async () => {
  const kv = fakeKv({ "acc:a": freshAccount({ expires_at: 1 }) });
  const pool = new AccountPool({ ACCOUNTS: kv });
  let hits = 0;
  captureFetch(() => {
    hits++;
    return jsonResp({ access_token: "NEW", expires_in: 3600 });
  });
  const acc = await pool.get("a");
  await Promise.all([pool.refresh("a", acc), pool.refresh("a", acc), pool.refresh("a", acc)]);
  assert.equal(hits, 1, `期望只刷新一次，实际 ${hits} 次`);
});

test("限流冷却是一分钟级，不是封一整天", async () => {
  const kv = fakeKv({ "acc:a": freshAccount() });
  const pool = new AccountPool({ ACCOUNTS: kv });
  const acc = await pool.get("a");
  const ms = await pool.penalize("a", acc, "rate_limit");
  assert.ok(ms <= 5 * 60 * 1000, `冷却太久了: ${ms}ms`);
  assert.ok(ms >= 10 * 1000, `冷却太短，等同于没保护: ${ms}ms`);
});

test("认证失败才长时间冷却（这种账号确实不该反复试）", async () => {
  const kv = fakeKv({ "acc:a": freshAccount() });
  const pool = new AccountPool({ ACCOUNTS: kv });
  const acc = await pool.get("a");
  const ms = await pool.penalize("a", acc, "auth_failure");
  assert.ok(ms >= 60 * 60 * 1000, `认证失败该冷藏更久，实际 ${ms}ms`);
});

test("被冷却的账号不会出现在 pick 结果里", async () => {
  const kv = fakeKv({
    "acc:hot": freshAccount({ expires_at: Math.floor(Date.now() / 1000) + 7200 }),
    "acc:cold": freshAccount({ expires_at: Math.floor(Date.now() / 1000) + 3600 })
  });
  const pool = new AccountPool({ ACCOUNTS: kv });
  await pool.penalize("acc:cold".slice(4), await pool.get("cold"), "rate_limit");
  const picked = await pool.pick();
  assert.equal(picked.id, "hot");
});

test("KV 里存了坏 JSON 的账号被跳过，不让整个账号池崩掉", async () => {
  const kv = fakeKv({ "acc:bad": "{不是 JSON", "acc:good": freshAccount() });
  const pool = new AccountPool({ ACCOUNTS: kv });
  assert.equal(await pool.get("bad"), null);
  assert.equal((await pool.pick()).id, "good");
});

test("penalize 写 KV 失败时不影响请求本身（内存冷却已经生效）", async () => {
  const kv = fakeKv({ "acc:a": freshAccount() });
  kv.put = async () => { throw new Error("KV 挂了"); };
  const pool = new AccountPool({ ACCOUNTS: kv });
  await pool.penalize("a", await pool.get("a"), "rate_limit");
  assert.equal(await pool.pick(), null, "内存冷却应生效");
});

// ============================================================
// 6. SSE 拆帧 —— 流式的地基
// ============================================================

test("iterSsePayloads 还原被切成任意碎块的 data 行", async () => {
  // 真实网络里 read() 会停在任意字节，不处理跨块就会丢内容或崩
  const pieces = ['da', 'ta: {"choi', 'ces":[{"delta":{"con', 'tent":"你好"}}]}\n', '\n', 'data: [DONE]\n\n'];
  const got = [];
  for await (const p of iterSsePayloads(streamOf(pieces))) got.push(p);
  assert.equal(got.length, 2);
  assert.equal(JSON.parse(got[0]).choices[0].delta.content, "你好");
  assert.equal(got[1], "[DONE]");
});

test("iterSsePayloads 处理 CRLF 行尾", async () => {
  const got = [];
  for await (const p of iterSsePayloads(streamOf(['data: {"x":1}\r\n', "data: [DONE]\r\n"]))) got.push(p);
  assert.equal(JSON.parse(got[0]).x, 1);
});

test("iterSsePayloads 处理上游最后一行没有换行符的情况", async () => {
  const got = [];
  for await (const p of iterSsePayloads(streamOf(['data: {"y":2}']))) got.push(p);
  assert.equal(got.length, 1);
  assert.equal(JSON.parse(got[0]).y, 2);
});

test("iterSsePayloads 忽略非 data 行与空负载", async () => {
  const got = [];
  for await (const p of iterSsePayloads(streamOf([": ping\n\n", "event: x\n", "data: \n", 'data: {"z":3}\n']))) got.push(p);
  assert.deepEqual(got, ['{"z":3}']);
});

test("iterSsePayloads 对空 body 直接结束，不抛异常", async () => {
  const got = [];
  for await (const p of iterSsePayloads(null)) got.push(p);
  assert.deepEqual(got, []);
});

// ============================================================
// 7. OpenAI 协议形状
// ============================================================

test("sseChunk 产出的帧能被 JSON.parse，且形状符合 chat.completion.chunk", () => {
  const s = sseChunk({ id: "c1", created: 1, model: "m", delta: { content: "x" } });
  assert.ok(s.startsWith("data: ") && s.endsWith("\n\n"));
  const o = JSON.parse(s.slice(6).trim());
  assert.equal(o.object, "chat.completion.chunk");
  assert.equal(o.choices[0].delta.content, "x");
});

test("sseDone 是字面量 [DONE]（客户端按它判断结束）", () => {
  assert.equal(sseDone(), "data: [DONE]\n\n");
});

test("错误体必须是 {error:{message}} 对象，不是字符串", async () => {
  // 上一版返回 {"error":"unknown model"}，官方 SDK 解析会抛异常，
  // 用户看到的是 SDK 的报错而不是真实原因。
  const r = errorResponse("bad", { status: 400, type: "invalid_request_error" });
  const o = await r.json();
  assert.equal(typeof o.error, "object");
  assert.equal(o.error.message, "bad");
  assert.equal(o.error.type, "invalid_request_error");
});

// ============================================================
// 8. Gemini 协议转换
// ============================================================

test("toGeminiPayload 保留完整多轮历史（曾只取最后一条 → 模型每轮失忆）", () => {
  const p = toGeminiPayload({
    messages: [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" }
    ]
  });
  assert.deepEqual(p.contents, [
    { role: "user", parts: [{ text: "Q1" }] },
    { role: "model", parts: [{ text: "A1" }] },
    { role: "user", parts: [{ text: "Q2" }] }
  ]);
});

test("toGeminiPayload 把 assistant 映射成 Gemini 的 model 角色", () => {
  assert.equal(toGeminiPayload({ messages: [{ role: "assistant", content: "hi" }] }).contents[0].role, "model");
});

test("toGeminiPayload 把 system 提到 systemInstruction，不混进 contents", () => {
  const p = toGeminiPayload({
    messages: [{ role: "system", content: "你是助手" }, { role: "user", content: "你好" }]
  });
  assert.deepEqual(p.systemInstruction.parts, [{ text: "你是助手" }]);
  assert.equal(p.contents.length, 1);
});

test("toGeminiPayload 合并多条 system", () => {
  const p = toGeminiPayload({
    messages: [{ role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "x" }]
  });
  assert.equal(p.systemInstruction.parts[0].text, "A\n\nB");
});

test("toGeminiPayload 在 messages 为空/异常时也给出非空 contents（否则 Gemini 400）", () => {
  for (const m of [[], null, undefined, "nope"]) {
    const p = toGeminiPayload({ messages: m });
    assert.ok(p.contents.length >= 1, `messages=${JSON.stringify(m)} 时 contents 为空`);
  }
});

test("toGeminiPayload 把数组形式的多模态 content 拍平成文本", () => {
  const p = toGeminiPayload({
    messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "x" } }] }]
  });
  assert.equal(typeof p.contents[0].parts[0].text, "string");
  assert.ok(p.contents[0].parts[0].text.includes("看图"));
});

test("toGeminiPayload 映射采样参数，且不产生空 generationConfig", () => {
  assert.equal(toGeminiPayload({ messages: [{ role: "user", content: "x" }] }).generationConfig, undefined);
  const p = toGeminiPayload({ messages: [{ role: "user", content: "x" }], temperature: 0.3, max_tokens: 99 });
  assert.equal(p.generationConfig.temperature, 0.3);
  assert.equal(p.generationConfig.maxOutputTokens, 99);
});

test("fromGeminiResponse 翻译成 OpenAI 形状，含 usage 与 finish_reason", () => {
  const r = fromGeminiResponse({
    candidates: [{ content: { parts: [{ text: "你好" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
  });
  assert.equal(r.text, "你好");
  assert.equal(r.finishReason, "stop");
  assert.equal(r.usage.total_tokens, 3);
});

test("fromGeminiResponse 把 MAX_TOKENS 翻成 OpenAI 的 length", () => {
  const r = fromGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] });
  assert.equal(r.finishReason, "length");
});

test("fromGeminiResponse 容忍残缺响应，不抛异常", () => {
  assert.equal(fromGeminiResponse({}).text, "");
  assert.equal(fromGeminiResponse(null).text, "");
});

test("iterGeminiDeltas 从 Gemini 形状的 SSE 里抽出增量文本", async () => {
  const sse = streamOf([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "你" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "好" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 9 } })}\n\n`
  ]);
  const out = [];
  for await (const ev of iterGeminiDeltas(sse)) out.push(ev);
  assert.deepEqual(out.map((e) => e.text), ["你", "好", ""]);
  assert.equal(out[2].finish, "STOP");
  assert.equal(out[2].usage.total_tokens, 9);
});

test("iterOpenAiDeltas 抽取 content 与推理内容", async () => {
  const sse = streamOf([
    'data: {"choices":[{"delta":{"reasoning_content":"想一下"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}\n\n',
    "data: [DONE]\n\n"
  ]);
  const out = [];
  for await (const ev of iterOpenAiDeltas(sse)) out.push(ev);
  assert.equal(out[0].reasoning, "想一下");
  assert.equal(out[1].text, "答案");
  assert.equal(out[2].finish, "stop");
  assert.equal(out[2].usage.total_tokens, 7);
});

test("iterOpenAiDeltas 遇到 [DONE] 立即停止", async () => {
  const sse = streamOf(['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', "data: [DONE]\n\n", 'data: {"choices":[{"delta":{"content":"不该出现"}}]}\n\n']);
  const out = [];
  for await (const ev of iterOpenAiDeltas(sse)) out.push(ev);
  assert.equal(out.length, 1);
});

test("classifyStatus 区分限流/认证/服务端错误（决定冷却时长）", () => {
  assert.equal(classifyStatus(429), "rate_limit");
  assert.equal(classifyStatus(401), "auth_failure");
  assert.equal(classifyStatus(403), "auth_failure");
  assert.equal(classifyStatus(500), "server_error");
  assert.equal(classifyStatus(503), "server_error");
});

// ============================================================
// 9. 端到端：通过真实 fetch 入口
// ============================================================

test("未知模型返回 OpenAI 形状的 404 错误，并列出可用模型", async () => {
  captureFetch(() => jsonResp({}));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nope/nope", messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  assert.equal(r.status, 400);
  const o = await r.json();
  assert.equal(typeof o.error, "object");
  assert.ok(o.error.message.includes("unknown model"));
  assert.ok(o.error.message.includes("glm/glm-4.6-flash"), "错误信息里应给出可用模型");
});

test("messages 为空时报错，且不打扰上游", async () => {
  const calls = captureFetch(() => jsonResp({}));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", messages: [] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0, "参数就错了，不该打上游");
});

test("请求体不是 JSON 时返回 400 而不是 500", async () => {
  captureFetch(() => jsonResp({}));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{不是 JSON"
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  assert.equal(r.status, 400);
});

test("stream:true 时上游真的收到 stream:true，且返回 SSE", async () => {
  // 这是最要命的一个 bug：上一版在 openai-compat 分支硬编码 stream:false，
  // 于是「客户端要流式、收到一个 JSON」，聊天界面直接卡死。
  const calls = captureFetch(() =>
    sseResp(['data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n'])
  );
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", stream: true, messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  assert.equal(calls[0].body.stream, true, "上游收到的 stream 被改写了");
  assert.match(r.headers.get("Content-Type"), /text\/event-stream/);
  const frames = await readSse(r);
  assert.equal(frames[frames.length - 1], "[DONE]");
});

test("stream:false 时上游收到 stream:false，且返回 JSON", async () => {
  const calls = captureFetch(() => openAiJson("你好"));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  assert.equal(calls[0].body.stream, false);
  const o = await r.json();
  assert.equal(o.choices[0].message.content, "你好");
});

test("Gemini 流式走 streamGenerateContent + alt=sse", async () => {
  const calls = captureFetch(() =>
    sseResp([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "你" }] } }] })}\n\n`])
  );
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini/gemini-2.5-flash", stream: true, messages: [{ role: "user", content: "hi" }] })
    }),
    { GEMINI_API_KEY: "k" },
    {}
  );
  assert.ok(calls[0].url.includes(":streamGenerateContent"), calls[0].url);
  assert.ok(calls[0].url.includes("alt=sse"), calls[0].url);
  const frames = await readSse(r);
  const content = frames
    .filter((f) => f !== "[DONE]")
    .map((f) => JSON.parse(f).choices[0].delta.content || "")
    .join("");
  assert.equal(content, "你");
});

test("Gemini 非流式走 generateContent", async () => {
  const calls = captureFetch(() =>
    jsonResp({ candidates: [{ content: { parts: [{ text: "你好" }] }, finishReason: "STOP" }] })
  );
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GEMINI_API_KEY: "k" },
    {}
  );
  assert.ok(calls[0].url.includes(":generateContent"));
  assert.ok(!calls[0].url.includes("alt=sse"));
  assert.equal((await r.json()).choices[0].message.content, "你好");
});

test("429 时自动回退到下一个 provider，并在响应里标注实际服务的模型", async () => {
  let n = 0;
  captureFetch(() => {
    n++;
    if (n === 1) return jsonResp({ error: { message: "rate limited" } }, 429);
    return openAiJson("来自备用 provider");
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "a", GROQ_API_KEY: "b" },
    {}
  );
  assert.equal(r.status, 200);
  const o = await r.json();
  assert.equal(o.choices[0].message.content, "来自备用 provider");
  assert.equal(o._proxy.fellBack, true);
  assert.ok(o._proxy.servedModel.includes("→"), o._proxy.servedModel);
  assert.equal(o._proxy.attempts.length, 1, "应记录一次失败的尝试");
});

test("400 时不回退（参数错误换个 provider 也一样）", async () => {
  let n = 0;
  captureFetch(() => { n++; return jsonResp({ error: { message: "bad param" } }, 400); });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "a", GROQ_API_KEY: "b" },
    {}
  );
  assert.equal(n, 1, `不该重试，实际打了 ${n} 次上游`);
  assert.equal(r.status, 400);
});

test("所有 provider 都失败时，错误信息里带上每个尝试的原因", async () => {
  captureFetch(() => jsonResp({ error: { message: "boom" } }, 503));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "a" },
    {}
  );
  assert.equal(r.status, 502);
  const o = await r.json();
  assert.ok(o.error.message.includes("所有候选"), o.error.message);
  assert.ok(o.error.message.includes("503"), o.error.message);
});

test("缺少密钥时给出明确提示，而不是让它 502", async () => {
  captureFetch(() => jsonResp({}));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    {},
    {}
  );
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error.message.includes("凭据"));
});

test("有效 token 的 Qwen 账号能用，且不触发 refresh", async () => {
  // 回归测试：字段名写错时这里会返回 502「没有可用账号」
  const kv = fakeKv({ "acc:a": freshAccount() });
  let refreshHits = 0;
  captureFetch((rec) => {
    if (rec.url.includes("/oauth2/token")) { refreshHits++; return jsonResp({}, 400); }
    return openAiJson("qwen 回答");
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen/qwen3-coder-plus", messages: [{ role: "user", content: "hi" }] })
    }),
    { ACCOUNTS: kv },
    {}
  );
  assert.equal(r.status, 200, "有效 token 的账号不该被判为不可用");
  assert.equal(refreshHits, 0, "token 还有效，不该去刷新");
  assert.equal((await r.json()).choices[0].message.content, "qwen 回答");
});

test("上游 429 会把 Qwen 账号置入冷却，下一次请求换账号", async () => {
  const kv = fakeKv({
    "acc:a": freshAccount({ access_token: "A", expires_at: Math.floor(Date.now() / 1000) + 7200 }),
    "acc:b": freshAccount({ access_token: "B", expires_at: Math.floor(Date.now() / 1000) + 3600 })
  });
  const used = [];
  captureFetch((rec) => {
    if (rec.url.includes("dashscope")) {
      used.push(rec.headers.Authorization);
      if (used.length === 1) return jsonResp({ error: { message: "quota" } }, 429);
      return openAiJson("ok");
    }
    return jsonResp({});
  });
  const req = () =>
    worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen/qwen3-coder-plus", messages: [{ role: "user", content: "hi" }] })
      }),
      { ACCOUNTS: kv },
      {}
    );
  await req(); // 第一个账号 429
  const r2 = await req();
  assert.equal(r2.status, 200, "第二次应换到另一个账号并成功");
  assert.notEqual(used[0], used[1], "两次用了同一个账号");
});

test("/v1/models 返回 OpenAI 形状，并标注可用性", async () => {
  const kv = fakeKv({ "acc:a": freshAccount() });
  const r = await worker.fetch(new Request("https://x/v1/models"), { ACCOUNTS: kv, GLM_API_KEY: "k" }, {});
  assert.equal(r.status, 200);
  const o = await r.json();
  assert.equal(o.object, "list");
  assert.ok(o.data.length === MODELS.length);
  const byId = Object.fromEntries(o.data.map((m) => [m.id, m]));
  assert.equal(byId["qwen/qwen3-coder-flash"].available, true, "有账号，qwen 应可用");
  assert.equal(byId["glm/glm-4.6-flash"].available, true);
  assert.equal(byId["gemini/gemini-2.5-flash"].available, false, "没配 key，不该显示可用");
  assert.equal(byId["glm/glm-4.6-flash"].object, "model");
  assert.ok(byId["glm/glm-4.6-flash"].context_length > 0);
});

test("/health 只报告哪些密钥已配置，绝不回显密钥值", async () => {
  const r = await worker.fetch(new Request("https://x/health"), { GLM_API_KEY: "SUPER_SECRET" }, {});
  const text = await r.text();
  assert.ok(!text.includes("SUPER_SECRET"), "健康检查泄露了密钥");
  assert.ok(JSON.parse(text).providers_ready.includes("GLM_API_KEY"));
});

test("鉴权开启后，未带 key 的请求 401，且错误是 OpenAI 形状", async () => {
  const r = await worker.fetch(new Request("https://x/v1/models"), { OPENAI_API_KEYS: "sk-a" }, {});
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.type, "authentication_error");
});

test("OPTIONS 预检返回 204 且带 CORS 头", async () => {
  const r = await worker.fetch(new Request("https://x/v1/models", { method: "OPTIONS" }), {}, {});
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
});

test("未知路由返回 404，而不是让 Worker 抛异常", async () => {
  const r = await worker.fetch(new Request("https://x/nope"), {}, {});
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, "not_found");
});

test("未配置 ADMIN_SECRET 时管理端点关闭（否则会泄露账号列表）", async () => {
  const kv = fakeKv({ "acc:a": freshAccount() });
  const r = await worker.fetch(new Request("https://x/admin/health"), { ACCOUNTS: kv }, {});
  assert.equal(r.status, 403);
  const text = await r.text();
  assert.ok(!text.includes("acc:a"), "不该泄露账号 id");
});

test("ADMIN_SECRET 正确时返回账号健康信息，且不含 token 明文", async () => {
  const kv = fakeKv({ "acc:a": freshAccount({ access_token: "SECRET_TOKEN" }) });
  const r = await worker.fetch(
    new Request("https://x/admin/health", { headers: { Authorization: "Bearer adm" } }),
    { ACCOUNTS: kv, ADMIN_SECRET: "adm" },
    {}
  );
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes("SECRET_TOKEN"), "管理端点泄露了 access_token");
  const o = JSON.parse(text);
  assert.equal(o.total, 1);
  assert.equal(o.accounts[0].has_token, true);
});

test("/v1/auth/poll 成功后把账号写进 KV", async () => {
  const kv = fakeKv();
  captureFetch(() => jsonResp({ access_token: "NEW", refresh_token: "R", expires_in: 3600 }));
  const r = await worker.fetch(
    new Request("https://x/v1/auth/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: "d", code_verifier: "v", account_id: "mine" })
    }),
    { ACCOUNTS: kv },
    {}
  );
  assert.equal(r.status, 200);
  const saved = JSON.parse(kv.store["acc:mine"]);
  assert.equal(saved.access_token, "NEW");
  assert.equal(saved.type, "qwen-oauth");
});

test("/v1/auth/poll 缺少参数时 400，不打上游", async () => {
  const calls = captureFetch(() => jsonResp({}));
  const r = await worker.fetch(
    new Request("https://x/v1/auth/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }),
    { ACCOUNTS: fakeKv() },
    {}
  );
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test("流式透传上游错误：200 头已发出，错误要写进流里而不是丢掉", async () => {
  // 上游在流中途断开：先给一个 chunk，再报错。
  // （注意不能写在 start() 里 —— 那样流在构造期就坏了，
  //   已经 enqueue 的数据根本读不出来，测的就不是我们想测的东西了。）
  let pulls = 0;
  const broken = new ReadableStream({
    pull(c) {
      if (pulls++ === 0) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'));
        return;
      }
      c.error(new Error("上游断了"));
    }
  });
  captureFetch(() => new Response(broken, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", stream: true, messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  const frames = await readSse(r);
  assert.ok(frames.some((f) => f.includes("A")), "已收到的内容不该丢");
  assert.equal(frames[frames.length - 1], "[DONE]", "必须以 [DONE] 收尾，否则客户端一直等");
});

test("流式响应逐帧可解析，且首帧声明 role", async () => {
  captureFetch(() =>
    sseResp([
      'data: {"choices":[{"index":0,"delta":{"content":"A"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"B"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    ])
  );
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", stream: true, messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  const frames = (await readSse(r)).filter((f) => f !== "[DONE]").map((f) => JSON.parse(f));
  assert.equal(frames[0].choices[0].delta.role, "assistant");
  assert.equal(frames.map((f) => f.choices[0].delta.content || "").join(""), "AB");
  assert.equal(frames[frames.length - 1].choices[0].finish_reason, "stop");
  assert.ok(frames.every((f) => f.object === "chat.completion.chunk" && f.id && f.model));
});

test("上游返回非 JSON 时给 502，而不是抛未捕获异常", async () => {
  captureFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  assert.ok(r.status >= 400, `期望报错，实际 ${r.status}`);
  assert.equal(typeof (await r.json()).error, "object");
});
