#!/usr/bin/env node
/**
 * 真实可用性探测：把 worker.fetch 当 servlet 跑起来，用一个真客户端
 * 打一遍 `/v1/models` 和 `/v1/chat/completions`，看**哪些模型真的能回话**。
 *
 * 和 `verify-local.mjs` 的分工：
 *   verify-local  假上游，验「我们的报文对不对」，离线、无密钥
 *   probe-models  真上游，验「上游到底能不能用」，需要密钥/账号，会出网
 *
 * 为什么需要它：`/v1/models` 里的 `available` 只回答「凭据配没配」，
 * 不回答「这个模型名上游还认不认」。免费档的模型 ID 是会下线的，
 * 而这类失效**在本地永远是绿的**。
 *
 * 用法：
 *   node scripts/probe-models.mjs                    # 只用已配置的凭据
 *   node scripts/probe-models.mjs --model glm/glm-4.6-flash
 *   node scripts/probe-models.mjs --json             # 机器可读
 *   node scripts/probe-models.mjs --timeout 20000
 *
 * 密钥从环境变量读（和 worker 的 keyEnv 同名）：
 *   GEMINI_API_KEY / GLM_API_KEY / CEREBRAS_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY
 * Qwen 走 OAuth 账号池，没有 KV 时自动跳过。
 *
 * 没有密钥的 provider **不报错、不猜**，直接标 `skipped`（没凭据），
 * 因为「没测」和「测了不行」是两件事。
 */

import { setTimeout as sleep } from "node:timers/promises";
import { PROVIDERS, MODELS, DEFAULT_MODEL } from "../src/providers.js";

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1];
};
const only = flag("--model");
const asJson = args.includes("--json");
const timeoutMs = Number(flag("--timeout", 30000));

// ---------- 运行环境：把密钥从 process.env 搬进 worker 的 env ----------
const KEY_VARS = Object.values(PROVIDERS)
  .filter((p) => p.auth === "key")
  .map((p) => p.keyEnv);

const env = {};
const configured = [];
for (const name of KEY_VARS) {
  if (process.env[name]) {
    env[name] = process.env[name];
    configured.push(name);
  }
}

const { default: worker } = await import("../src/worker.js");

const call = (path, body) =>
  worker.fetch(
    new Request("https://ice-proxy.test" + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    }),
    env,
    {}
  );

/** 单次对话：返回 { ok, ms, detail }。不抛异常 —— 探测结果本身就是数据。 */
async function probe(model) {
  const t0 = Date.now();
  let r;
  try {
    r = await call("/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      max_tokens: 16,
      // 关掉思考，越快出结论越好
      ...(model.startsWith("gemini/") ? {} : { reasoning_effort: "low" })
    });
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: `请求异常：${e?.message || e}` };
  }
  const ms = Date.now() - t0;
  const raw = await r.text().catch(() => "");
  let d = null;
  try {
    d = JSON.parse(raw);
  } catch {
    /* 上游可能回纯文本（网关拒绝），下面按文本处理 */
  }
  if (!r.ok || d?.error) {
    const msg = d?.error?.message || raw || JSON.stringify(d);
    const detail = `HTTP ${r.status}：${String(msg).slice(0, 220)}`;
    // 「没有凭据」和「这个模型名不存在」必须分开报 —— 合成一句「不可用」，
    // 会让人以为模型下线了，实际上只是没填 key。
    // OpenRouter 在有 key 但 key 无效时也回 401，所以还要看 key 是不是我们自己
    // 塞进去的占位值（CI 用的就是那个）。
    const credentialIssue = /Missing Authentication|No cookie auth|Incorrect API key|invalid_api_key/i.test(msg);
    return {
      ok: false,
      ms,
      detail,
      reason: credentialIssue ? "credentials" : "upstream"
    };
  }
  if (!d) return { ok: false, ms, detail: `HTTP ${r.status}，响应不是 JSON：${raw.slice(0, 120)}` };
  const text = d.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) return { ok: false, ms, detail: "空回答（上游 200 但没有内容）" };
  const served = d._proxy?.servedModel || model;
  const via = served !== model ? `（实际由 ${served} 回答）` : "";
  return { ok: true, ms, detail: text.trim().slice(0, 40) + via };
}

// ---------- /v1/models：代码认为哪些可用 ----------
const modelsResp = await call("/v1/models");
const listing = await modelsResp.json();
const advertised = new Map((listing.data ?? []).map((m) => [m.id, m.available]));

const targets = MODELS.map((m) => m.id).filter((id) => !only || id === only);

if (!asJson) {
  console.log("iceProxy 真实可用性探测");
  console.log(`默认模型：${DEFAULT_MODEL}`);
  console.log(
    configured.length
      ? `已配置凭据：${configured.join(", ")}`
      : "已配置凭据：无（只会探测 Qwen 账号池）"
  );
  console.log(`探测 ${targets.length} 个模型，单个超时 ${timeoutMs}ms\n`);
}

const results = [];
for (const id of targets) {
  const prefix = id.slice(0, id.indexOf("/"));
  const provider = PROVIDERS[prefix];
  const hasCred = provider.auth === "qwen-oauth" ? !!env.ACCOUNTS : !!env[provider.keyEnv];

  if (!hasCred) {
    results.push({ id, status: "skipped", detail: `未配置 ${provider.auth === "qwen-oauth" ? "Qwen 账号池" : provider.keyEnv}` });
    if (!asJson) console.log(`⏭  ${id}  —— 跳过（没有凭据）`);
    continue;
  }

  const out = await Promise.race([
    probe(id),
    sleep(timeoutMs).then(() => ({ ok: false, ms: timeoutMs, detail: `超过 ${timeoutMs}ms 无响应` }))
  ]);
  results.push({ id, status: out.ok ? "ok" : "fail", ms: out.ms, detail: out.detail, reason: out.reason ?? null, advertised: advertised.get(id) });
  if (!asJson) {
    console.log(`${out.ok ? "✔" : "✖"}  ${id}  ${out.ms}ms  —— ${out.detail}`);
  }
}

const summary = {
  ok: results.filter((r) => r.status === "ok").length,
  fail: results.filter((r) => r.status === "fail").length,
  skipped: results.filter((r) => r.status === "skipped").length,
  default_model: DEFAULT_MODEL,
  default_ok: results.find((r) => r.id === DEFAULT_MODEL)?.status ?? "unknown"
};

if (asJson) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  const credFail = results.filter((r) => r.reason === "credentials").length;
  console.log(
    `\n合计 ${results.length}：可用 ${summary.ok} / 不可用 ${summary.fail} / 未测 ${summary.skipped}`
  );
  if (credFail) {
    console.log(`  其中 ${credFail} 个是**凭据无效**（🔑），不是模型下线 —— 换个真 key 再跑。`);
  }
  if (summary.fail) {
    console.log("\n不可用的：");
    for (const r of results.filter((x) => x.status === "fail")) {
      console.log(`  ${r.id} —— ${r.detail}`);
    }
  }
  console.log(
    `\n注意：未测的 ${summary.skipped} 个不是「不可用」，只是这台机器上没配对应凭据。`
  );
}

// 有失败就非零退出？不 —— 探测是诊断工具，不该让 CI 因为别人的免费档波动而红。
// 需要机器可读结论时用 --json 自己判断。
