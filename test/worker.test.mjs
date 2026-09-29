// iceProxy 单元测试 —— 用 Node 内置 test runner，零依赖
// 运行：npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, DEFAULT_MODEL, checkApiKey, corsHeaders } from "../src/worker.js";

// 每个 provider 前缀对应的密钥环境变量名，与 handleChat 里的分支保持一致
const KEY_ENV_BY_PREFIX = {
  gemini: "GEMINI_API_KEY",
  glm: "GLM_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
};

test("DEFAULT_MODEL 必须是 PROVIDERS 里真实存在的模型", () => {
  assert.ok(
    PROVIDERS[DEFAULT_MODEL],
    `DEFAULT_MODEL=${DEFAULT_MODEL} 不在 PROVIDERS 中，不传 model 的请求会直接 400`
  );
});

test("每个模型 ID 都带 provider 前缀，且前缀与 type 自洽", () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const prefix = id.split("/")[0];
    assert.ok(prefix && id.includes("/"), `模型 ${id} 缺少 provider 前缀`);
    if (p.type === "gemini-key") assert.equal(prefix, "gemini", `${id} 前缀应为 gemini`);
    if (p.type === "qwen-oauth") assert.equal(prefix, "qwen", `${id} 前缀应为 qwen`);
    if (p.type === "openai-key") assert.match(prefix, /^(glm|cerebras|openrouter)$/);
  }
});

test("所有 provider 的 base 都是 https", () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.base?.startsWith("https://"), `${id} 的 base 不是 https：${p.base}`);
  }
});

test("openai-key 类型的 provider 前缀必须在密钥映射表里有对应项", () => {
  // 这条能挡住「新增了 provider 但忘了在 handleChat 里加 keyName 分支」这类回归：
  // 漏加分支时 keyName 会退化成 OPENAI_COMPAT_KEY，运行时才报 missing secret
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (p.type !== "openai-key") continue;
    const prefix = id.split("/")[0];
    assert.ok(
      KEY_ENV_BY_PREFIX[prefix],
      `${id} 的前缀 ${prefix} 没有对应密钥环境变量，handleChat 里需要加分支`
    );
  }
});

test("每个 provider 前缀都出现在 README 的模型表里（文档与代码同步）", async () => {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  for (const id of Object.keys(PROVIDERS)) {
    assert.ok(
      readme.includes("`" + id + "`"),
      `README 模型表里缺少 ${id} —— 文档与 worker.js 的 PROVIDERS 不一致`
    );
  }
});

test("checkApiKey：未配置 OPENAI_API_KEYS 时放行（本地开发）", () => {
  assert.equal(checkApiKey(new Request("https://x/v1/models"), {}), true);
});

test("checkApiKey：配置后必须带匹配的 Bearer", () => {
  const env = { OPENAI_API_KEYS: "sk-aaa,sk-bbb" };
  assert.equal(checkApiKey(new Request("https://x/v1/models"), env), false);
  assert.equal(
    checkApiKey(new Request("https://x/v1/models", {
      headers: { Authorization: "Bearer sk-ccc" }
    }), env),
    false
  );
  assert.equal(
    checkApiKey(new Request("https://x/v1/models", {
      headers: { Authorization: "Bearer sk-bbb" }
    }), env),
    true
  );
});

test("checkApiKey：只配 OPENAI_API_KEYS 时 admin secret 不放行", () => {
  // 当前实现只校验 OPENAI_API_KEYS，ADMIN_SECRET 并未参与鉴权。
  // 保留这条断言是为了把现状固定下来：改实现时必须同步改这里。
  const env = { OPENAI_API_KEYS: "sk-aaa", ADMIN_SECRET: "adm-1" };
  assert.equal(
    checkApiKey(new Request("https://x/admin/health", {
      headers: { Authorization: "Bearer adm-1" }
    }), env),
    false
  );
});

test("corsHeaders 允许 POST 与 Authorization 头", () => {
  const h = corsHeaders();
  assert.match(h["Access-Control-Allow-Methods"], /POST/);
  assert.match(h["Access-Control-Allow-Headers"], /Authorization/);
});
