#!/usr/bin/env node
/**
 * 端到端冒烟：把 Worker 挂在一个**假上游**上，用真实 HTTP 请求过一遍
 * 客户端真正会走的那几条路。`npm test` 测的是函数级契约，这个脚本测的是
 * 「一个 OpenAI 客户端拿它当 base_url，到底能不能用」。
 *
 * 为什么单独做一个脚本而不是塞进 pytest/node:test：
 *   1. 它要起 HTTP 端口、要真的走网络栈 —— 和「单测离线、零依赖」的约定冲突；
 *   2. 它验证的是「对客户端友好」，需要看的是原始报文（头、分块边界、[DONE]），
 *      而不是函数返回值。
 *
 * 假上游不碰任何真实 provider：它就是一个 HTTP server，按 `model` 字段
 * 决定回什么形状。所以这个脚本可以在任何机器上、没有密钥的情况下跑。
 *
 * 用法：node scripts/verify-local.mjs
 */

import http from "node:http";

// 起假上游之前先留一份干净的 fetch，等下要把它换成「指向假上游」的版本
const realFetch = globalThis.fetch;
const { default: worker } = await import("../src/worker.js");
const { AccountPool } = await import("../src/accounts.js");

// ---------- 假上游 ----------
//
// 每个「性格」挂在一个**真实存在**的模型 id 上 —— 客户端的 model 字段必须
// 能过 catalog 校验，所以不能自己编一个。扮演谁由这里决定，与 src/providers.js
// 的模型清单解耦：清单增减模型不会让这个脚本失效（找不到性格就按 ok 处理）。
const PERSONALITIES = [
  // GLM：正常的 SSE + 合法的 [DONE]
  { upstreamModel: "glm-4.6-flash", kind: "stream" },
  // GLM 另一个型号：上游憋一会儿再吐字（正常的长思考）
  { upstreamModel: "glm-4.5-flash", kind: "slow-stream" },
  // Qwen：无视 stream:true，回普通 JSON —— 降级路径
  { upstreamModel: "qwen3-coder-flash", kind: "ignores-stream" },
  // Cerebras：回 429 —— 触发回退
  { upstreamModel: "llama-3.3-70b", kind: "rate-limited" }
];
const upstream = http.createServer((req, res) => {
  const q = new URL(req.url, "http://127.0.0.1");
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    // 注意：这里收到的是**剥掉 provider 前缀后的上游模型名**。
    // 客户端填的是 `glm/glm-4.6-flash`，到这儿已经是 `glm-4.6-flash`。
    const model = q.searchParams.get("model") || "";
    const wantStream = q.searchParams.get("stream") === "1";
    if (process.env.VERIFY_DEBUG) console.error(`[fake-upstream] model=${model} stream=${wantStream}`);

    const completion = (text) =>
      JSON.stringify({
        id: "up",
        object: "chat.completion",
        created: 1,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
      });

    // 每个「性格」绑定一个真实存在的模型 id，见下面 ROUTING 的说明。
    const personality = PERSONALITIES.find((p) => p.upstreamModel === model) ?? { kind: "ok" };

    if (personality.kind === "rate-limited") {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "rate limited" } }));
    }
    if (personality.kind === "ignores-stream") {
      // 无视 stream:true，照样回 JSON —— 我们刚修的降级路径
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(completion("我被要求流式，但上游给了 JSON"));
    }
    if (personality.kind === "slow-stream") {
      // 先憋着不吐字，模拟「模型在思考」。总时长超时会把这种正常行为掐掉。
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      return setTimeout(() => {
        res.write(`data: {"choices":[{"delta":{"content":"慢但正常"}}]}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }, 1200);
    }
    if (wantStream && personality.kind === "stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      // 故意把一行 JSON 从中间切开，模拟真实网络的分片
      const line = `data: {"choices":[{"delta":{"content":"分片"}}]}\n\n`;
      const cut = Math.floor(line.length / 2);
      res.write(line.slice(0, cut));
      return setTimeout(() => {
        res.write(line.slice(cut));
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      }, 30);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(completion(`普通回答（${model}）`));
  });
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upBase = `http://127.0.0.1:${upstream.address().port}`;

// ---------- 把 Worker 挂起来 ----------
//
// 不走 wrangler：直接把 worker.fetch 当 servlet 用。这样验证的是同一份
// 源码，但不需要 Cloudflare 账号，也不需要网络。
const env = {
  // 静态密钥充当假上游的「凭据」；实际值不重要，假上游不校验
  GLM_API_KEY: "k-glm",
  GEMINI_API_KEY: "k-gemini",
  CEREBRAS_API_KEY: "k-cerebras",
  OPENAI_API_KEYS: "sk-local",
  ACCOUNTS: (() => {
    const mem = { "acc:a": JSON.stringify({
      access_token: "T", refresh_token: "R",
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }) };
    return {
      store: mem,
      list: async () => ({ keys: Object.keys(mem).map((name) => ({ name })) }),
      get: async (k) => mem[k] ?? null,
      put: async (k, v) => { mem[k] = v; },
      delete: async (k) => { delete mem[k]; }
    };
  })()
};

const hits = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(upBase)) {
    // 假上游自己发的（不该发生，防呆）
    throw new Error("假上游不该再往外发请求");
  }
  const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body ?? {};
  hits.push({ url: u, model: body.model, stream: body.stream });
  // 真实上游域名 → 本地假上游。按 model 名分派，另带一个 stream 标记。
  const target = `${upBase}/gen?model=${encodeURIComponent(body.model || "x")}&stream=${body.stream === true ? 1 : 0}`;
  return realFetch(target, init);
};

// ---------- 断言工具 ----------
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✖"} ${name}${extra ? "  —— " + extra : ""}`);
  if (!cond) failed++;
};

const call = (path, { method = "GET", body, key } = {}) =>
  worker.fetch(
    new Request("https://ice-proxy.test" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    }),
    env,
    {}
  );

const ssePayloads = async (r) => {
  const text = await r.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => b.slice(5).trim());
};

// ---------- 1. 健康与鉴权 ----------
console.log("\n== 1. 健康检查 / 鉴权 ==");
{
  const r = await call("/health");
  const d = await r.json();
  check("/health 200", r.status === 200);
  check("不回显密钥值", !JSON.stringify(d).includes("k-glm"), JSON.stringify(d).slice(0, 140));
  check("报告已配置的 provider", d.providers_ready.includes("GLM_API_KEY"));

  const bad = await call("/v1/models", { key: "sk-wrong" });
  check("错误 key → 401", bad.status === 401);
  const shaped = await bad.json();
  check(
    "401 错误体是 OpenAI 形状（对象而非字符串）",
    typeof shaped.error === "object" && !!shaped.error.message
  );
}

// ---------- 2. /v1/models ----------
console.log("\n== 2. 模型列表 ==");
{
  const r = await call("/v1/models", { key: "sk-local" });
  const d = await r.json();
  check("200 且 object=list", r.status === 200 && d.object === "list");
  check(
    "带 context_length / capabilities / available",
    d.data.every((m) => "context_length" in m && Array.isArray(m.capabilities) && typeof m.available === "boolean")
  );
  check("已配密钥的 provider 标为可用", d.data.find((m) => m.id.startsWith("glm/")).available === true);
  check("未配密钥的 provider 标为不可用", d.data.find((m) => m.id.startsWith("groq/")).available === false);
}

// ---------- 3. 非流式 ----------
console.log("\n== 3. 非流式对话 ==");
{
  const r = await call("/v1/chat/completions", {
    method: "POST",
    key: "sk-local",
    body: { model: "glm/glm-4.6-flash", messages: [{ role: "user", content: "你好" }] }
  });
  const d = await r.json();
  check("200", r.status === 200, JSON.stringify(d).slice(0, 160));
  check(
    "choices[0].message.content 有内容",
    typeof d.choices?.[0]?.message?.content === "string" && d.choices[0].message.content.length > 0
  );
  check(
    "usage 三字段齐全",
    ["prompt_tokens", "completion_tokens", "total_tokens"].every((k) => typeof d.usage?.[k] === "number")
  );
  // 注意：上游返回的是它自己的模型名（`glm-4.6-flash`，已剥掉 provider 前缀），
  // 我们原样透传 —— 这是上游的字段，不是我们编的。
  check("model 字段被原样透传（不伪造）", d.model === "glm-4.6-flash", d.model);
}

// ---------- 4. 真流式 ----------
console.log("\n== 4. 流式（含跨分片的半行）==");
{
  const r = await call("/v1/chat/completions", {
    method: "POST",
    key: "sk-local",
    body: { model: "glm/glm-4.6-flash", stream: true, messages: [{ role: "user", content: "hi" }] }
  });
  check("Content-Type 是事件流", (r.headers.get("Content-Type") || "").includes("text/event-stream"));
  const payloads = await ssePayloads(r);
  check("以字面量 [DONE] 收尾", payloads[payloads.length - 1] === "[DONE]", payloads[payloads.length - 1]);
  const frames = payloads
    .filter((p) => p !== "[DONE]")
    .map((p) => {
      try {
        return JSON.parse(p);
      } catch {
        return null;
      }
    });
  check("每个 data: 都是合法 JSON", frames.length > 0 && frames.every(Boolean));
  check("首帧声明 role", frames[0]?.choices?.[0]?.delta?.role === "assistant");
  const text = frames.map((f) => f?.choices?.[0]?.delta?.content ?? "").join("");
  check("被切成两半的行被正确拼接", text === "分片", JSON.stringify(text));
  check("末帧带 finish_reason", frames[frames.length - 1]?.choices?.[0]?.finish_reason === "stop");
}

// ---------- 5. 上游无视 stream（新修的降级路径）----------
console.log("\n== 5. 上游不听 stream:true 时的降级 ==");
{
  const r = await call("/v1/chat/completions", {
    method: "POST",
    key: "sk-local",
    body: { model: "qwen/qwen3-coder-flash", stream: true, messages: [{ role: "user", content: "hi" }] }
  });
  // 假上游只对 *slow- 开头 + stream=1 回 SSE，其余一律 JSON。
  // 这里故意用一个不会回 SSE 的路径，等价于「上游违约」。
  check("不再宣称是事件流", !(r.headers.get("Content-Type") || "").includes("text/event-stream"));
  const d = await r.json();
  check(
    "仍能拿到完整回答（不是空壳）",
    typeof d.choices?.[0]?.message?.content === "string" && d.choices[0].message.content.length > 0
  );
  check("把降级这件事显式标出来了", d._proxy?.streamDowngraded === true);
  check("响应头也标了", r.headers.get("X-IceProxy-Stream-Downgraded") === "1");
}

// ---------- 6. 流式不能被总时长超时掐掉 ----------
console.log("\n== 6. 流式长思考不被超时掐断 ==");
{
  const t0 = Date.now();
  const r = await call("/v1/chat/completions", {
    method: "POST",
    key: "sk-local",
    body: { model: "glm/glm-4.5-flash", stream: true, messages: [{ role: "user", content: "think" }] }
  });
  const payloads = await ssePayloads(r);
  check("上游憋了一会儿仍能正常交付", payloads[payloads.length - 1] === "[DONE]", `用了 ${Date.now() - t0}ms`);
  check("内容没丢", payloads.some((p) => p.includes("慢但正常")));
}

// ---------- 7. 错误归因 ----------
console.log("\n== 7. 未知模型 / 缺凭据的诊断信息 ==");
{
  const r = await call("/v1/chat/completions", {
    method: "POST",
    key: "sk-local",
    body: { model: "nope/nope", messages: [{ role: "user", content: "hi" }] }
  });
  const d = await r.json();
  check("未知模型 → 400 model_not_found", r.status === 400 && d.error.code === "model_not_found");
  check("错误里列了可用模型（用户能自救）", d.error.message.includes("glm/glm-4.6-flash"));

  // 核心承诺：**零配置可用**。
  // 一个 provider 密钥都没配、也没有 KV —— 请求不许失败，必须自动
  // 回退到免密钥的 pollinations。这是「fork 完直接能用」这句话的实测。
  const r2 = await worker.fetch(
    new Request("https://ice-proxy.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local" },
      body: JSON.stringify({ model: "cerebras/llama-3.3-70b", messages: [{ role: "user", content: "hi" }] })
    }),
    { OPENAI_API_KEYS: "sk-local" }, // 一个 provider 密钥都没有，也没有 KV
    {}
  );
  const d2 = await r2.json();
  check(
    "零配置（无任何密钥）也能拿到 200，而不是失败",
    r2.status === 200 && (d2.choices?.[0]?.message?.content || "").length > 0,
    d2.error?.message || d2._proxy?.servedModel
  );
  check(
    "零配置时自动回退到免密钥 provider",
    (d2._proxy?.servedModel || "").includes("pollinations/"),
    d2._proxy?.servedModel
  );

  // 反例：配了 KV 但账号池空 —— 不该说成「你没配凭据」，该指向「加账号」
  const r3 = await worker.fetch(
    new Request("https://ice-proxy.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen/qwen3-coder-flash", messages: [{ role: "user", content: "hi" }] })
    }),
    { ACCOUNTS: { list: async () => ({ keys: [] }), get: async () => null, put: async () => {}, delete: async () => {} } },
    {}
  );
  const d3 = await r3.json();
  check("账号池空 → 提示指向「加账号」", /账号/.test(d3.error?.message || ""), d3.error?.message);
}

// ---------- 7.5 回退链（README 承诺的头号特性）----------
console.log("\n== 7.5 跨模型回退 ==");
{
  // cerebras 的第一个模型（qwen-3-32b，性格 ok）正常，第二个（llama-3.3-70b）回 429。
  // 应该：第一个成功，不触发任何回退。
  const r = await call("/v1/chat/completions", {
    method: "POST",
    key: "sk-local",
    body: { model: "cerebras/qwen-3-32b", messages: [{ role: "user", content: "hi" }] }
  });
  const d = await r.json();
  check("首选模型正常时不回退", d._proxy?.fellBack === false, d._proxy?.servedModel);
  check("没有回退响应头", r.headers.get("X-IceProxy-Fallback") === null);

  // 反过来：直接点名那个会 429 的模型。
  // cerebras 两个模型都扮演「429」，所以候选链会一路走出 provider 之外 ——
  // 这正是 README 承诺的「跨 provider 回退」，也是最该端到端验一次的东西。
  const r2 = await call("/v1/chat/completions", {
    method: "POST",
    key: "sk-local",
    body: { model: "cerebras/llama-3.3-70b", messages: [{ role: "user", content: "hi" }] }
  });
  const d2 = await r2.json();
  check("429 时真的换了模型", d2._proxy?.fellBack === true, d2._proxy?.servedModel);
  check("回退后仍拿到内容", (d2.choices?.[0]?.message?.content || "").length > 0);
  // 注意回退顺序：同 provider 的另一个模型排在别的 provider 前面（同一份凭据，
  // 最便宜的一次重试）。所以这里先修到同 provider —— 想验「跨 provider」
  // 得让整个 cerebras 都失败，见下一条。
  check(
    "先试同 provider 的另一个模型（最便宜的重试）",
    (d2._proxy?.servedModel || "").includes("cerebras/"),
    d2._proxy?.servedModel
  );
  // 头是 ASCII，body 是可读版（`→`）——两者内容相同、编码不同
  check(
    "非流式回退也带 X-IceProxy-Fallback 头（ASCII 安全）",
    r2.headers.get("X-IceProxy-Fallback") === d2._proxy.servedModel.replace(/[^\x20-\x7e]/g, "->"),
    r2.headers.get("X-IceProxy-Fallback")
  );
  check("记录了 429 的尝试原因", (d2._proxy?.attempts || []).some((a) => /429/.test(a.error)));

  // 跨 provider：撤掉 cerebras 的密钥，用户却点名 cerebras 的模型。
  // 候选链里 cerebras 被标成 no，链子必然跨到别的 provider —— 现在第一顺位
  // 是免密钥的 pollinations（Qwen 也在链里，但免密钥的优先级更靠前）。
  const r3 = await worker.fetch(
    new Request("https://ice-proxy.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cerebras/llama-3.3-70b", messages: [{ role: "user", content: "hi" }] })
    }),
    // 有 Qwen 账号、但没有 cerebras 密钥 → 只能跨到别的 provider
    { ACCOUNTS: env.ACCOUNTS },
    {}
  );
  const d3 = await r3.json();
  check(
    "原 provider 不可用时跨到其它 provider",
    /^cerebras\/llama-3\.3-70b→(pollinations|qwen)\//.test(d3._proxy?.servedModel || ""),
    d3._proxy?.servedModel
  );
  check("跨 provider 后仍拿到内容", (d3.choices?.[0]?.message?.content || "").length > 0);
}

// ---------- 8. CORS / 404 ----------
console.log("\n== 8. CORS 与 404 ==");
{
  const pre = await call("/v1/chat/completions", { method: "OPTIONS" });
  check("OPTIONS → 204 + CORS", pre.status === 204 && pre.headers.get("Access-Control-Allow-Origin") === "*");
  const nf = await call("/nope", { key: "sk-local" });
  check("未知路由 → 404（不是未捕获异常）", nf.status === 404);
}

// ---------- 收尾 ----------
upstream.close();
console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
console.log(`（本轮共向假上游发起 ${hits.length} 次请求，没碰任何真实 provider）`);
process.exitCode = failed ? 1 : 0;
