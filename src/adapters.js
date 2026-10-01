/**
 * 各家上游的适配器。
 *
 * 契约：所有适配器都返回**上游的原始 Response**，交由调用方决定
 * 透传还是转换。这样做的原因是流式和非流式共用一条路径 ——
 * 上一版把 `stream: false` 硬编码在 openai-compat 里，
 * 结果客户端要流式、实际收到一个 JSON，聊天界面直接卡死。
 *
 * 适配器只做两件事：把请求改写成上游认识的形状；在需要时把
 * 上游的响应翻译回 OpenAI 形状（只有 Gemini 需要）。
 */

import { iterSsePayloads } from "./openai.js";
import { AuthFailure } from "./accounts.js";

/** 把 messages 规范化：过滤空项、统一 content 为字符串或 parts 数组。 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => m && typeof m === "object");
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text ?? "";
        if (p?.type === "image_url") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

/**
 * OpenAI 形状 → Gemini 形状。
 *
 * 这里的教训值得留一行：上一版只取 `messages` 的最后一条，
 * 而 Cline / Cursor 每次请求都带完整历史，等于每轮都让模型失忆。
 */
export function toGeminiPayload(req) {
  const contents = [];
  const systemParts = [];
  for (const m of normalizeMessages(req.messages)) {
    const text = contentToText(m.content);
    if (m.role === "system" || m.role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }
    // Gemini 的助手角色叫 model，不叫 assistant
    const role = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text }] });
  }
  // Gemini 要求 contents 非空；空请求会给 400，给个空 user 更友好
  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "" }] });

  const generationConfig = {};
  const map = {
    temperature: "temperature",
    top_p: "topP",
    topP: "topP",
    max_tokens: "maxOutputTokens",
    max_completion_tokens: "maxOutputTokens"
  };
  for (const [from, to] of Object.entries(map)) {
    if (typeof req[from] === "number") generationConfig[to] = req[from];
  }
  // 只保留非空，否则 Gemini 会对空对象报错
  const payload = { contents };
  if (systemParts.length) payload.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;
  return payload;
}

/**
 * Gemini 的非流式响应 → OpenAI 形状。
 */
export function fromGeminiResponse(d, model) {
  const cand = d?.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  const usage = d?.usageMetadata
    ? {
        prompt_tokens: d.usageMetadata.promptTokenCount ?? 0,
        completion_tokens: d.usageMetadata.candidatesTokenCount ?? 0,
        total_tokens: d.usageMetadata.totalTokenCount ?? 0
      }
    : null;
  const finish = cand?.finishReason === "MAX_TOKENS" ? "length" : "stop";
  return { text, usage, finishReason: finish };
}

/**
 * 解析 Gemini 的流式响应体（`alt=sse` 时是标准 SSE，data 里是 JSON）。
 */
export async function* iterGeminiDeltas(body) {
  for await (const payload of iterSsePayloads(body)) {
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue;
    }
    const parts = frame?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("");
    const finish = frame?.candidates?.[0]?.finishReason;
    const usage = frame?.usageMetadata
      ? {
          prompt_tokens: frame.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: frame.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: frame.usageMetadata.totalTokenCount ?? 0
        }
      : null;
    if (text || finish || usage) yield { text, finish, usage };
  }
}

/**
 * 解析 OpenAI 兼容上游的流式响应体。
 * 上游已经是 OpenAI 形状，所以基本是透传，只做一次解析以便统计 usage。
 */
export async function* iterOpenAiDeltas(body) {
  for await (const payload of iterSsePayloads(body)) {
    if (payload === "[DONE]") return;
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue;
    }
    const choice = frame?.choices?.[0];
    const text = choice?.delta?.content ?? choice?.text ?? "";
    // 有些上游（如 OpenRouter 的推理模型）把思维链放在这个字段
    const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? null;
    yield {
      text,
      reasoning,
      finish: choice?.finish_reason ?? null,
      usage: frame?.usage ?? null
    };
  }
}

/**
 * 判断一个 provider 配置是否需要静态密钥，并取出它。
 *
 * 返回 `null` 有两种完全不同的含义，别混：
 *   - `auth === "none"`：**不需要**密钥，这是正常状态（如 pollinations）
 *   - `auth === "key"` 但环境里没配：需要密钥但缺失，是错误状态
 * 调用方要区分它们，请用 `providerNeedsKey()`，不要只看这个返回值。
 */
export function resolveApiKey(provider, env) {
  if (provider.auth !== "key") return null;
  const key = env?.[provider.keyEnv];
  return key ? String(key).trim() : null;
}

/** 这个 provider 是否必须配密钥才能用。 */
export function providerNeedsKey(provider) {
  return provider?.auth === "key";
}

/** 上游 HTTP 状态 → 我们的失败原因分类，用于决定冷却时长。 */
export function classifyStatus(status) {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth_failure";
  if (status >= 500) return "server_error";
  return "server_error";
}

/**
 * 非流式的上游响应体可能**不是 JSON**。
 *
 * 为什么必须在读之前先看 Content-Type：网关/边缘节点拒掉请求时
 * （GFW 的 RST、Cloudflare 的 1009、nginx 的 502 页）回的都是 HTML 或纯文本，
 * 而且 Content-Type 常常是宣称不了的 `text/plain` / 缺失。
 * 这些响应的 body 里**有诊断信息**（`error code: 1009` 一眼就能看出是被墙了）。
 *
 * ⚠️ 这里有个坑，值得写下来：**先 `resp.json()` 再落到 `resp.text()` 是拿不到东西的。**
 * 实测（Node 24）：
 *   const r = new Response("error code: 1009", {status:500});
 *   await r.json().catch(() => null);   // null
 *   await r.text();                     // throw: Body is unusable: Body has already been read
 * 失败的 `json()` 会先 `discard()` 掉 body，于是后面的 `text()` 永远抛错、
 * 被兜成空串 —— 「保留了原文」是假的，只是恰好没报错。
 * 所以**必须先 `text()` 把原始字节拿到手，再自己 `JSON.parse`**。
 * 顺序反过来，这个函数就是摆设。
 *
 * 实测（这些域名在容器里就是被拒的）：
 *   api.cerebras.ai  → 403 `text/plain` `error code: 1009`
 *   api.groq.com     → 403 `{"error":{"message":"Forbidden"}}`
 */
export async function readJsonOrText(resp) {
  const raw = await resp.text().catch(() => "");
  try {
    return JSON.parse(raw);
  } catch {
    return { _nonJson: true, text: raw.slice(0, 200) };
  }
}
