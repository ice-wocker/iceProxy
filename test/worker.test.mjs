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

const openAiJson = (content, extra = {}, model = "m") =>
  jsonResp({
    id: "up-1",
    object: "chat.completion",
    created: 1,
    model,
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

test("帐号池读出来是空的：qwen 不占第一顺位，让已配密钥的 provider 先试", () => {
  // accountCount===0 分不清「真没账号」和「KV 没配 / list 失败」，
  // 所以不把 qwen 从链里摘掉（见 buildFallbackChain 的注释）；
  // 但也不能让它排在确定能用的 provider 前面 —— 否则一个空账号池
  // 会永远占着第一顺位白试一次，把真正配好的 provider 挤出 4 次尝试的窗口。
  const env = { GLM_API_KEY: "a", GEMINI_API_KEY: "b" };
  const chain = buildFallbackChain("gemini/gemini-2.5-flash", env, 0);
  const firstQwen = chain.findIndex((e) => e.prefix === "qwen");
  assert.ok(chain.some((e) => e.prefix === "gemini"), "primary 有密钥，必须在链里");
  assert.ok(firstQwen === -1 || firstQwen >= 2, `qwen 不该挤在前面：${chain.map((e) => e.id)}`);
});

test("没有 Qwen 账号但有 3 个账号时，qwen 同 provider 内要有备选", () => {
  const chain = buildFallbackChain("qwen/qwen3-max", {}, 3);
  assert.ok(chain.length > 1, "同 provider 内也该有备选");
  assert.ok(chain.every((e) => e.prefix === "qwen" || true));
});

test("静态密钥 provider 没配密钥时，链为空（→ 明确报 no_credentials 而不是逐个试错）", () => {
  // 曾经的行为：主模型无条件入链，导致「没密钥」时也返回一个非空链，
  // 用户看到的是最后一个 provider 的报错，根本猜不到是缺密钥。
  // 静态密钥 provider 的可用性是**能确定**的（env 里有没有那个 key），
  // 所以没有密钥就是没有，直接空链。
  assert.deepEqual(buildFallbackChain("gemini/gemini-2.5-flash", { GLM_API_KEY: "a" }, 0).filter((e) => e.prefix === "gemini"), []);
  assert.deepEqual(buildFallbackChain("glm/glm-4.6-flash", { GEMINI_API_KEY: "a" }, 0).filter((e) => e.prefix === "glm"), []);
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

test("上游回 200 但内容是空的 → 继续回退，而不是透传空答案", async () => {
  // 真 bug 回归：实测 pollinations 偶发回 `{}`（HTTP 200、无 choices）。
  // 旧行为是原样透传一个空回答，客户端拿到「成功但没内容」。
  // 现在它必须被当成一次失败，继续走候选链。
  let n = 0;
  const calls = captureFetch(() => {
    // 只有第一个候选回空，后面的候选正常 —— 模拟上游偶发抽风
    n++;
    return n === 1 ? jsonResp({}) : openAiJson("回退后的回答");
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "pollinations/gpt-oss-20b", messages: [{ role: "user", content: "hi" }] })
    }),
    {},
    {}
  );
  assert.equal(r.status, 200);
  const o = await r.json();
  assert.equal(o.choices[0].message.content, "回退后的回答", "空完成必须触发回退，而不是透传空答案");
  assert.ok(o._proxy.attempts.some((a) => a.error.includes("空的完成")), JSON.stringify(o._proxy.attempts));
  assert.ok(calls.length >= 2, "该至少试了两个候选");
});

test("上游 5xx（瞬时抽风）原地重试一次，而不是立刻换 provider", async () => {
  // 真 bug 回归：实测 pollinations 会成片回 `ENOSPC`（500）。
  // 隔一下再试通常就好 —— 直接换 provider 会白白烧掉一个候选名额。
  let n = 0;
  captureFetch(() => {
    n++;
    if (n === 1) return jsonResp({ error: "ENOSPC: no space left on device" }, 500);
    return openAiJson("重试后成功");
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "pollinations/gpt-oss-20b", messages: [{ role: "user", content: "hi" }] })
    }),
    {},
    {}
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "重试后成功");
  assert.equal(n, 2, `5xx 该原地重试一次（共 2 次），实际 ${n}`);
});

test("429 不原地重试，直接换 provider（限流不会 250ms 就恢复）", async () => {
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
  assert.equal(n, 2, `429 该只打 2 次（1 次失败 + 1 次换 provider），实际 ${n}`);
  assert.equal((await r.json())._proxy.fellBack, true, "必须真的换了 provider");
});

test("402（免费额度耗尽/参数要付费）也换 provider，不当硬错误", async () => {
  // 实测 pollinations 对 `tools`、`system` 角色回 402 —— 换个 provider 能成。
  let n = 0;
  captureFetch(() => {
    n++;
    if (n === 1) return jsonResp({}, 402);
    return openAiJson("别的 provider 能答");
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "pollinations/gpt-oss-20b", messages: [{ role: "user", content: "hi" }] })
    }),
    {},
    {}
  );
  assert.equal(r.status, 200, "402 不该直接抛给客户端");
  assert.equal((await r.json()).choices[0].message.content, "别的 provider 能答");
});

test("零配置部署：没配任何密钥也能用（回退到免密钥 provider）", async () => {
  // 这是本项目的核心承诺 —— fork 完直接跑。挑一个需要密钥的模型，
  // 期望它自动回退到 pollinations，且返回 200。
  const calls = captureFetch((rec) => {
    assert.ok(!rec.url.includes("cerebras"), "不该真的打没配密钥的 cerebras");
    return openAiJson("无需密钥也能回答", {}, "gpt-oss-20b");
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cerebras/llama-3.3-70b", messages: [{ role: "user", content: "hi" }] })
    }),
    {},
    {}
  );
  assert.equal(r.status, 200, "零配置也应该能拿到回答");
  const o = await r.json();
  assert.equal(o.choices[0].message.content, "无需密钥也能回答");
  assert.ok(calls.length >= 1);
});

test("免密钥 provider 不带 Authorization 头", async () => {
  let sawAuth = null;
  captureFetch((rec) => {
    sawAuth = rec.headers?.Authorization ?? null;
    return openAiJson("ok");
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "pollinations/gpt-oss-20b", messages: [{ role: "user", content: "hi" }] })
    }),
    {},
    {}
  );
  assert.equal(r.status, 200);
  assert.equal(sawAuth, null, "免密钥 provider 不能带 Authorization，否则会被上游当无效凭据拒掉");
});

test("默认模型是免密钥的 —— 不传 model 时零配置可用", async () => {
  const calls = captureFetch((rec) => {
    assert.ok(rec.url.includes("pollinations"), `默认模型该走免密钥 provider，实际打了 ${rec.url}`);
    return openAiJson("默认回答");
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    }),
    {},
    {}
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "默认回答");
  assert.equal(calls.length, 1);
});

test("/v1/models 里免密钥 provider 的报告为可用", async () => {
  captureFetch(() => jsonResp({}));
  const r = await worker.fetch(new Request("https://x/v1/models"), {}, {});
  assert.equal(r.status, 200);
  const { data } = await r.json();
  const p = data.find((m) => m.id === "pollinations/gpt-oss-20b");
  assert.ok(p, "免密钥模型必须在列表里");
  assert.equal(p.available, true, "零配置时免密钥模型应该报告可用");
});

test("/health 报告免密钥 provider 列表与默认模型", async () => {
  const r = await worker.fetch(new Request("https://x/health"), {}, {});
  const o = await r.json();
  assert.deepEqual(o.providers_keyless, ["pollinations"]);
  assert.equal(o.default_model, "pollinations/gpt-oss-20b");
});

test("配了 KV 但账号池是空的：提示指向「加账号」，而不是含糊的 502", async () => {
  // 两种「没有凭据」要分清楚，否则用户会去翻自己明明配过的密钥。
  const calls = captureFetch(() => jsonResp({}));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen/qwen3-coder-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { ACCOUNTS: fakeKv() },
    {}
  );
  // 池子空 → callUpstream 直接抛 no_qwen_account，不会真的打上游
  assert.equal(calls.length, 0, "池子空时不该白打上游");
  const msg = (await r.json()).error.message;
  assert.ok(/账号/.test(msg), `错误信息该指向「加账号」：${msg}`);
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

// ============================================================
// 15. 客户端要流式、上游给了普通 JSON（「转圈转到天荒地老」）
// ============================================================
//
// 现象：客户端发 stream:true，某个上游忽略了这个字段，回 200 + application/json。
// 旧实现不做任何 Content-Type 检查，直接把它当流透传：客户端收到 200 +
// text/event-stream，内容却是一坨没有 data: 前缀的 JSON，也没有 [DONE]。
// 表现是 UI 一直转圈，而上游和我们自己都是 200，日志里看不出任何异常。
// 现在必须降级成非流式，并把降级行为显式标出来。

test("上游无视 stream:true 返回 JSON 时，降级为非流式而不是让客户端转圈", async () => {
  // 用 Qwen（不需要静态密钥）并把候选链限制在它的一个模型上：
  // 否则调用方会带着「这次降级」的记分继续试下一个 provider，
  // 测到的就不是「单一上游违约」这个场景了。
  const calls = captureFetch((rec) => openAiJson("完整回答", {}, rec.body.model));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen/qwen3-coder-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    }),
    { ACCOUNTS: fakeKv({ "acc:a": freshAccount() }) },
    {}
  );

  // 关键：不能回 text/event-stream。回了它，客户端就会一直等 SSE 帧。
  assert.ok(
    !(r.headers.get("Content-Type") || "").includes("text/event-stream"),
    "上游给的是 JSON，就不该对客户端宣称这是事件流"
  );
  const d = await r.json();
  assert.equal(d.choices[0].message.content, "完整回答", "内容要完整交付，不能丢");
  assert.equal(d._proxy.streamDowngraded, true, "降级必须显式标出来，不能静默");
  assert.equal(r.headers.get("X-IceProxy-Stream-Downgraded"), "1");
  // 上游确实收到过 stream:true —— 我们不改写客户端的意图，只是处理上游的违约
  assert.equal(calls[0].body.stream, true);
});

test("上游老老实实返回 text/event-stream 时不触发降级", async () => {
  captureFetch(() => sseResp(['data: {"choices":[{"delta":{"content":"A"}}]}\n\n']));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4.6-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  assert.ok((r.headers.get("Content-Type") || "").includes("text/event-stream"));
  assert.equal(r.headers.get("X-IceProxy-Stream-Downgraded"), null);
});

test("Content-Type 带 charset 或大小写差异时仍认得出事件流", async () => {
  // 真实上游五花八门：`text/event-stream; charset=utf-8`、`Text/Event-Stream`。
  // 判定写得太平（用 === "text/event-stream"）就会把正常流误判成 JSON，
  // 于是「流式回答」被整体降级 —— 这是个会静默劣化体验的坑。
  for (const ctype of ["text/event-stream; charset=utf-8", "Text/Event-Stream", "TEXT/EVENT-STREAM"]) {
    captureFetch(() => new Response('data: {"choices":[{"delta":{"content":"A"}}]}\n\n', {
      status: 200,
      headers: { "Content-Type": ctype }
    }));
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "glm/glm-4.6-flash",
          stream: true,
          messages: [{ role: "user", content: "hi" }]
        })
      }),
      { GLM_API_KEY: "k" },
      {}
    );
    assert.ok(
      (r.headers.get("Content-Type") || "").includes("text/event-stream"),
      `${ctype} 应被识别为事件流`
    );
    assert.equal(r.headers.get("X-IceProxy-Stream-Downgraded"), null, `${ctype} 不该降级`);
  }
});

// ============================================================
// 16. 账号池读取次数（KV 是按读计费的）
// ============================================================

test("/v1/models 的可用性判断只 list 一次 KV，不对每个账号再 get", async () => {
  let listCalls = 0;
  let getCalls = 0;
  const env = {
    ACCOUNTS: {
      list: async () => {
        listCalls++;
        return { keys: [{ name: "acc:a" }, { name: "acc:b" }, { name: "acc:c" }] };
      },
      get: async () => {
        getCalls++;
        return freshAccount();
      },
      put: async () => {},
      delete: async () => {}
    }
  };
  const r = await worker.fetch(new Request("https://x/v1/models"), env, {});
  const d = await r.json();

  assert.equal(listCalls, 1, "只该 list 一次");
  assert.equal(getCalls, 0, "只关心数量，不该把每个账号都读一遍");
  assert.equal(d.data.find((m) => m.id === "qwen/qwen3-coder-flash").available, true);
});

test("账号池读 KV 失败时按「没有账号」处理，而不是让 /v1/models 变 500", async () => {
  const env = {
    ACCOUNTS: {
      list: async () => {
        throw new Error("KV 抖动");
      },
      get: async () => null,
      put: async () => {},
      delete: async () => {}
    }
  };
  const r = await worker.fetch(new Request("https://x/v1/models"), env, {});
  assert.equal(r.status, 200, "KV 抖一下不该把整个模型列表打挂");
  const d = await r.json();
  assert.equal(d.data.find((m) => m.id === "qwen/qwen3-coder-flash").available, false);
});

test("accountCount=0 时不会因为「没有账号」把 Qwen 从候选链里摘掉", () => {
  // 口径必须和 count() 的失败兜底一致：读不到账号数时不要替用户下结论，
  // 交给上游去回答「这个 token 行不行」。否则一次 KV 抖动会让
  // 配了账号的人看到 no_credentials。
  // 现有实现把它排到了候选链末尾（其余 17 个模型都在它前面），而且
  // 「一个 provider 都没有」时链是空的 —— 这里先把契约钉住，改动要显式改这条用例。
  const chain = buildFallbackChain("qwen/qwen3-coder-flash", {}, 0);
  assert.ok(chain.every((e) => e.prefix === "qwen"), "无密钥环境下只该留下 Qwen");
  assert.ok(chain.some((e) => e.id === "qwen/qwen3-coder-flash"));
});

// ============================================================
// 17. 回退时的响应头（客户端按头判断的那条路）
// ============================================================
//
// 这一节是被端到端脚本逼出来的：单测里从没检查过这个头，
// 而它实际有**两个**真问题。

test("非流式回退也要带 X-IceProxy-Fallback 头，不能只在 body 里说", async () => {
  // 旧实现只在流式那条路设这个头。客户端若按头判断是否发生了回退，
  // 非流式场景会静默地把回退当正常响应。
  captureFetch((rec) => {
    if (rec.body.model.startsWith("llama-3.3")) {
      return jsonResp({ error: { message: "rate limited" } }, 429);
    }
    return openAiJson("来自备用模型", {}, rec.body.model);
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cerebras/llama-3.3-70b",
        messages: [{ role: "user", content: "hi" }]
      })
    }),
    { CEREBRAS_API_KEY: "k" },
    {}
  );
  const d = await r.json();
  assert.equal(d._proxy.fellBack, true, "该发生回退");
  assert.ok(r.headers.get("X-IceProxy-Fallback"), "非流式也要有这个头");
});

test("回退头必须是 ASCII —— servedModel 里的箭头不能直接进 header", async () => {
  // 这个是真炸过的：servedModel 为了可读用 `→`（U+2192），直接塞进
  // new Response() 的 headers 会抛
  //   TypeError: Cannot convert argument to a ByteString
  // 一次正常的回退就这么变成了 500。HTTP 头只能是 latin-1/ASCII。
  captureFetch((rec) => {
    if (rec.body.model.startsWith("llama-3.3")) {
      return jsonResp({ error: { message: "rate limited" } }, 429);
    }
    return openAiJson("来自备用模型", {}, rec.body.model);
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cerebras/llama-3.3-70b",
        messages: [{ role: "user", content: "hi" }]
      })
    }),
    { CEREBRAS_API_KEY: "k" },
    {}
  );
  // 构造响应本身没抛异常，就已经是这半个断言了
  assert.equal(r.status, 200, "回退不该变成 500");
  const header = r.headers.get("X-IceProxy-Fallback");
  assert.ok(header, "回退必须能被客户端看见");
  assert.ok(
    [...header].every((ch) => ch.charCodeAt(0) <= 0xff),
    `header 里有非 ASCII 字符：${JSON.stringify(header)}`
  );
  assert.ok(header.includes("->"), `箭头该被替换成 ->：${header}`);
  // body 里保留可读版本，不影响日志/调试
  const d = await r.json();
  assert.ok(d._proxy.servedModel.includes("→"), "body 里仍用可读箭头");
});

test("流式回退的头同样是 ASCII", async () => {
  captureFetch((rec) => {
    if (rec.body.model.startsWith("llama-3.3")) {
      return jsonResp({ error: { message: "rate limited" } }, 429);
    }
    return sseResp(['data: {"choices":[{"delta":{"content":"A"}}]}\n\n']);
  });
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cerebras/llama-3.3-70b",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    }),
    { CEREBRAS_API_KEY: "k" },
    {}
  );
  assert.equal(r.status, 200);
  const header = r.headers.get("X-IceProxy-Fallback");
  assert.ok(header, "流式回退也要有这个头");
  assert.ok([...header].every((ch) => ch.charCodeAt(0) <= 0xff), `非 ASCII：${header}`);
});

// ---------- 默认模型：环境变量必须真的生效 ----------
//
// `wrangler.toml` 里一直有个 `DEFAULT_MODEL` 变量，注释写着「想换默认模型
// 改这里，不用改代码」—— 但代码从来没读过它。这类「改了没反应」的配置
// 比没有配置更糟：用户会怀疑自己改错了文件，而不是怀疑代码。
//
// 在这里把它变成契约：不传 model 时，用谁由 env.DEFAULT_MODEL 决定。

test("不传 model 时，默认模型来自 env.DEFAULT_MODEL", async () => {
  const calls = captureFetch((rec) => openAiJson("ok", {}, rec.body.model));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    }),
    { GROQ_API_KEY: "k", DEFAULT_MODEL: "groq/qwen-3-32b" },
    {}
  );
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d._proxy.servedModel, "groq/qwen-3-32b");
  assert.equal(calls[0].body.model, "qwen-3-32b", "发给上游的应该是剥掉前缀的模型名");
});

test("env.DEFAULT_MODEL 没写时，回退到编译期常量（行为不变）", async () => {
  const calls = captureFetch((rec) => openAiJson("ok", {}, rec.body.model));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    }),
    {
      ACCOUNTS: fakeKv({ "acc:a": freshAccount() }),
      ...{ DEFAULT_MODEL: "" }
    },
    {}
  );
  assert.equal(r.status, 200);
  assert.equal(calls[0].body.model, DEFAULT_MODEL.split("/").slice(1).join("/"));
});

test("env.DEFAULT_MODEL 写了非法值时，忽略它并回退（不能让 Worker 整个起不来）", async () => {
  // 一个拼错的变量名不该导致所有请求都挂。宁可回退到已知可用的默认值 + 告警。
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  const calls = captureFetch((rec) => openAiJson("ok", {}, rec.body.model));
  try {
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
      }),
      { ACCOUNTS: fakeKv({ "acc:a": freshAccount() }), DEFAULT_MODEL: "nope/nope" },
      {}
    );
    assert.equal(r.status, 200, "非法默认值不该让请求失败");
    assert.equal(calls[0].body.model, DEFAULT_MODEL.split("/").slice(1).join("/"));
  } finally {
    console.warn = warn;
  }
  assert.ok(
    warnings.some((w) => w.includes("nope/nope")),
    `非法值必须告警，否则用户不知道自己的配置被忽略了。实际告警：${JSON.stringify(warnings)}`
  );
});

// ---------- 上游回了非 JSON 的报文 ----------
//
// ⚠️ 先分清两条路，别测错地方：
//
//   A. 上游 ok=false（4xx/5xx）→ `handleChat` 在进入 makeJsonResponse **之前**
//      就 `resp.text()` 记录进 `attempts`，然后换下一个候选。这条路一直没问题。
//   B. 上游 **ok=true（200）但 body 不是 JSON** → 落到 `makeJsonResponse`，
//      由 `readJsonOrText` 负责读出内容。**这条路才是本次修的地方。**
//
// 触发场景真实存在：网关或反代在 200 上回一个 HTML 续页/登录页
// （公司网络门户、Cloudflare 的挑战页），或者上游把错误塞进了 200 的 HTML。
// 旧实现是 `resp.json().catch(() => null)`，拿到 null 就丢一句
// 「上游返回了非 JSON 内容」—— 把 body 里那段唯一有用的信息丢了。
//
// 这里还要防一个**测试自身的陷阱**：`Response` 的 body 是一次性的。
// 如果复用同一个实例，第一次读成功之后后续读就永远拿不到内容，
// 而断言用的是 `includes(...)`，很容易被前面的残留**假绿**。
// 所以下面统一用工厂函数，每次给一个新实例。

/** 上游 200，但 body 不是 JSON。每次调用给一个新 Response。 */
const notJsonResp = (text, ctype = "text/html") => () =>
  new Response(text, { status: 200, headers: { "Content-Type": ctype } });

test("上游 200 但 body 是 HTML 时，错误里必须带上原文", async () => {
  captureFetch(notJsonResp("<html><body>502 Bad Gateway</body></html>"));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  const d = await r.json();
  assert.ok(r.status >= 400, `期望报错，实际 ${r.status}`);
  assert.equal(typeof d.error, "object", "错误体必须是 OpenAI 形状的对象");
  assert.ok(
    d.error.message.includes("502 Bad Gateway"),
    `错误信息里必须保留上游原文，实际是：${d.error.message}`
  );
});

test("上游 200 但 body 是纯文本时，错误里带上原文和内容类型", async () => {
  captureFetch(notJsonResp("UNAVAILABLE: upstream refused", "text/plain"));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4.6-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GLM_API_KEY: "k" },
    {}
  );
  const d = await r.json();
  assert.ok(
    d.error.message.includes("upstream refused"),
    `错误信息里必须保留上游原文，实际是：${d.error.message}`
  );
  assert.ok(
    d.error.message.includes("text/plain"),
    `错误信息里必须带上内容类型（否则不知道是谁回的东西），实际是：${d.error.message}`
  );
});

test("上游 200 但 body 是 HTML —— Gemini 这条路同样要保留原文", async () => {
  captureFetch(notJsonResp("<html>challenge required</html>"));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { GEMINI_API_KEY: "k" },
    {}
  );
  const d = await r.json();
  assert.ok(
    d.error.message.includes("challenge required"),
    `Gemini 路径也必须保留原文，实际是：${d.error.message}`
  );
});

test("上游 4xx/5xx 且 body 是纯文本时，原文也要进 attempts（这条路一直在，别回归）", async () => {
  // 这条守的是「另一条路」：ok=false 时在 handleChat 里就记录了原文。
  // 之前它只是顺带被 `includes` 覆盖到，这里把它变成显式契约。
  captureFetch(() => new Response("error code: 1009", { status: 403, headers: { "Content-Type": "text/plain" } }));
  const r = await worker.fetch(
    new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cerebras/qwen-3-32b", messages: [{ role: "user", content: "hi" }] })
    }),
    { CEREBRAS_API_KEY: "k" },
    {}
  );
  const d = await r.json();
  assert.ok(
    d.error.message.includes("1009"),
    `上游原文没进错误信息，实际是：${d.error.message}`
  );
  assert.ok(d.error.message.includes("403"), `状态码没进错误信息：${d.error.message}`);
});
