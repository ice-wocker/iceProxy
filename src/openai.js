/**
 * OpenAI 协议的「形状」相关工具：错误体、SSE 帧、响应规范化。
 *
 * 单独抽出来是因为这些是最容易被忽略、又最影响兼容性的部分：
 * 客户端（openai-python / LangChain / Cline）会按固定形状解析，
 * 少一个字段就报 KeyError，而错误信息往往指向客户端自己，很难查。
 */

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra }
  });

/**
 * OpenAI 的错误体是 `{"error": {"message", "type", "code"}}`。
 * 旧版直接返回 `{"error": "unknown model: xxx"}` —— 字符串而非对象，
 * 官方 SDK 会在解析时抛异常，用户看到的是 SDK 的报错而不是真实原因。
 */
export function errorResponse(message, { status = 400, type = "invalid_request_error", code = null, param = null } = {}) {
  return json({ error: { message, type, code, param } }, status);
}

export function upstreamError(message, status = 502) {
  return errorResponse(message, { status, type: "upstream_error" });
}

export function ok(obj, extra = {}) {
  return json(obj, 200, extra);
}

/** 生成一个 OpenAI 风格的 chatcmpl id。 */
export function completionId() {
  return "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/**
 * 把一个流式 delta 包成 OpenAI 的 chunk 帧。
 * 客户端只认 `data: {...}\n\n`，最后必须是字面量 `[DONE]`。
 */
export function sseChunk({ id, created, model, delta, finishReason = null }) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`;
}

export function sseDone() {
  return "data: [DONE]\n\n";
}

/**
 * 非流式的 chat.completion 响应体。
 * usage 缺失时补零而不是省略 —— 有些客户端会直接读 total_tokens。
 */
export function chatCompletion({ id, created, model, content, finishReason = "stop", usage = null, reasoning = null }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {})
        },
        finish_reason: finishReason
      }
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

/**
 * 流式响应头。
 *
 * 这里必须显式声明 Transfer-Encoding: chunked。Workers 运行时在
 * 没有 Content-Length 时默认也是 chunked，但显式写出来有两个好处：
 * 一是自证意图，二是某些中间层（带缓冲的网关）看到这个头会更保守。
 */
export function streamHeaders(extra = {}) {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(),
    ...extra
  };
}

export function streamResponse(body, extra = {}) {
  return new Response(body, { status: 200, headers: streamHeaders(extra) });
}

/**
 * 把上游的 SSE 字节流转成「逐条 data 负载」的字符串流。
 *
 * 上游（不管哪家）的 SSE 分帧规则都一样：按行读，`data:` 之后是负载，
 * 空行是分隔。这里只负责拆帧，不理解负载内容。
 *
 * 注意跨块的半行：一次 read() 可能停在 `data: {"a":` 中间，
 * 所以后面必须留 buffer，不能直接按 chunk 解析。
 */
export async function* iterSsePayloads(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /**
   * 从 buffer 里切出所有完整行，逐个交给调用方。
   *
   * 抽成生成器是为了能在「上游中途断开」时先冲刷已缓冲的数据 ——
   * 这件事必须做，否则用户会看到「模型说到一半突然没了」，
   * 而且断在哪一半是随机的，最难查。
   */
  function* drain() {
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload) yield payload;
    }
  }

  let readError = null;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        // 上游在流中途报错（连接被重置之类）。先别急着抛 ——
        // buffer 里可能还压着已经收到、但还没交付给客户端的内容。
        readError = e;
        break;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      yield* drain();
    }
  } finally {
    reader.releaseLock?.();
  }

  // 收尾：上游没以换行结束时，最后一行也要吐出来
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload) yield payload;
  }

  // 冲刷完缓冲，再把上游的错误交给调用方去决定怎么呈现
  if (readError) throw readError;
}
