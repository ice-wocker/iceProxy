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

/** 判断一个 provider 配置是否需要静态密钥，并取出它。 */
export function resolveApiKey(provider, env) {
  if (provider.auth !== "key") return null;
  const key = env?.[provider.keyEnv];
  return key ? String(key).trim() : null;
}

/** 上游 HTTP 状态 → 我们的失败原因分类，用于决定冷却时长。 */
export function classifyStatus(status) {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth_failure";
  if (status >= 500) return "server_error";
  return "server_error";
}

export { AuthFailure };
