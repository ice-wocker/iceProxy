/**
 * Provider 注册表 —— 单一真相源。
 *
 * 新增一个免费模型只需要在 MODELS 里加一行：
 *   - 若属于已有 provider（qwen / gemini / glm / cerebras / openrouter），
 *     只加 id 即可，其余字段继承该 provider 的默认值；
 *   - 若是新 provider，先往 PROVIDERS 里加一条。
 *
 * 之所以把「模型」和「provider」拆开，是因为原先两者揉在
 * 一个对象里，导致「同一个 provider 下加模型」要复制 base/type/auth
 * 三份，改一处漏两处 —— README 与代码对不上就是这么来的。
 */

/** 上游 provider 定义。key 是模型 id 的 `::` 前缀。 */
export const PROVIDERS = {
  qwen: {
    label: "Qwen (Alibaba)",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai",
    // OAuth device flow：token 存在 KV 里轮换，不走静态密钥
    auth: "qwen-oauth",
    homepage: "https://chat.qwen.ai"
  },
  gemini: {
    label: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "gemini",
    auth: "key",
    keyEnv: "GEMINI_API_KEY",
    homepage: "https://aistudio.google.com/apikey"
  },
  glm: {
    label: "Zhipu GLM (智谱)",
    base: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai",
    auth: "key",
    keyEnv: "GLM_API_KEY",
    homepage: "https://bigmodel.cn/"
  },
  cerebras: {
    label: "Cerebras",
    base: "https://api.cerebras.ai/v1",
    protocol: "openai",
    auth: "key",
    keyEnv: "CEREBRAS_API_KEY",
    homepage: "https://cloud.cerebras.ai/"
  },
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    protocol: "openai",
    auth: "key",
    keyEnv: "OPENROUTER_API_KEY",
    homepage: "https://openrouter.ai/",
    // OpenRouter 用这两个头做来源标识，免费额度分配到时有用
    extraHeaders: { "X-Title": "iceProxy" }
  },
  groq: {
    label: "Groq",
    base: "https://api.groq.com/openai/v1",
    protocol: "openai",
    auth: "key",
    keyEnv: "GROQ_API_KEY",
    homepage: "https://console.groq.com/keys"
  }
};

/**
 * 模型目录。id 形如 `provider/model`，provider 段必须在上面的 PROVIDERS 里。
 *
 * ctx = 上下文窗口（tokens），注明是为了让客户端能判断该塞多少历史；
 * 免费额度的实测值不可靠，所以**不写具体额度数字**，只写是否免费
 * —— 写死了迟早过期，而 README 里写过期数字正是上一版的教训。
 */
export const MODELS = [
  // ---- Qwen（OAuth，多账号轮换，唯一不需要密钥的 provider）----
  { id: "qwen/qwen3-coder-flash", ctx: 1000000, caps: ["tools", "stream"] },
  { id: "qwen/qwen3-coder-plus", ctx: 1000000, caps: ["tools", "stream"] },
  { id: "qwen/qwen3-max", ctx: 262144, caps: ["tools", "stream"] },
  { id: "qwen/qwen-vl-max", ctx: 131072, caps: ["vision", "stream"] },

  // ---- Gemini ----
  { id: "gemini/gemini-2.5-flash", ctx: 1048576, caps: ["vision", "audio", "tools", "stream"] },
  { id: "gemini/gemini-2.5-flash-lite", ctx: 1048576, caps: ["vision", "tools", "stream"] },
  { id: "gemini/gemini-2.0-flash", ctx: 1048576, caps: ["vision", "tools", "stream"] },

  // ---- GLM ----
  { id: "glm/glm-4.6-flash", ctx: 204800, caps: ["tools", "stream"] },
  { id: "glm/glm-4.5-flash", ctx: 131072, caps: ["tools", "stream"] },

  // ---- Cerebras（推理速度是它的卖点）----
  { id: "cerebras/qwen-3-32b", ctx: 131072, caps: ["tools", "stream"] },
  { id: "cerebras/llama-3.3-70b", ctx: 131072, caps: ["tools", "stream"] },

  // ---- Groq ----
  { id: "groq/llama-3.3-70b-versatile", ctx: 131072, caps: ["tools", "stream"] },
  { id: "groq/qwen-3-32b", ctx: 131072, caps: ["tools", "stream"] },

  // ---- OpenRouter 免费池（id 带 :free 后缀才是免费档）----
  // 这些 id 是**从 /v1/models 实测抓出来的**，不是照印象写的。
  // 上一版 README 里那批「Qwen3-Max / GLM-5.3 / Kimi-K3」就是凭印象写的，
  // 结果一个都不存在于代码里 —— 用户照着填必然报 unknown model。
  { id: "openrouter/qwen/qwen3.8-27b:free", ctx: 262144, caps: ["vision", "stream"] },
  { id: "openrouter/google/gemma-4-31b-it:free", ctx: 262144, caps: ["vision", "stream"] },
  { id: "openrouter/nvidia/nemotron-3-super-120b-a12b:free", ctx: 262144, caps: ["stream"] },
  { id: "openrouter/cohere/north-mini-code:free", ctx: 256000, caps: ["tools", "stream"] },
  { id: "openrouter/inclusionai/ling-3.0-flash-sante:free", ctx: 262144, caps: ["tools", "stream"] }
];

/** 默认模型：挑个「不需要任何密钥就能跑」的，这样 fork 完直接可用。 */
export const DEFAULT_MODEL = "qwen/qwen3-coder-flash";

/** 把 MODELS 展开成 id -> {provider, modelId, upstreamBase, ...} 的查找表。 */
export function buildCatalog() {
  const catalog = new Map();
  for (const m of MODELS) {
    const slash = m.id.indexOf("/");
    if (slash === -1) throw new Error(`模型 id 缺少 provider 前缀: ${m.id}`);
    const prefix = m.id.slice(0, slash);
    const provider = PROVIDERS[prefix];
    if (!provider) throw new Error(`模型 ${m.id} 的 provider "${prefix}" 未在 PROVIDERS 中注册`);
    catalog.set(m.id, {
      id: m.id,
      prefix,
      // `::` 之后才是真正发给上游的 model 名（OpenRouter 的 id 本身含 /，所以只剥一层）
      upstreamModel: m.id.slice(slash + 1),
      ctx: m.ctx ?? null,
      caps: m.caps ?? [],
      provider
    });
  }
  if (!catalog.has(DEFAULT_MODEL)) {
    throw new Error(`DEFAULT_MODEL=${DEFAULT_MODEL} 不在模型目录里`);
  }
  return catalog;
}

/** 按 provider 前缀分组，用于 /v1/models 的 owned_by 与文档生成。 */
export function groupByProvider() {
  const out = new Map();
  for (const m of MODELS) {
    const prefix = m.id.slice(0, m.id.indexOf("/"));
    if (!out.has(prefix)) out.set(prefix, []);
    out.get(prefix).push(m);
  }
  return out;
}
