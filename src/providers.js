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
  },
  /**
   * Pollinations —— 唯一一个 `auth: "none"` 的 provider：**不需要任何密钥**。
   *
   * 它存在的意义就是让「fork 完直接能用」这句话成立。之前所有 provider
   * 都要么要静态密钥（gemini/glm/cerebras/groq/openrouter），要么要在 KV 里
   * 存一个 OAuth 账号（qwen）—— 也就是说，**刚部署完的 iceProxy 一个模型都跑不通**，
   * 必须先做一轮配置。这与「零配置反向代理」的定位是矛盾的。
   *
   * 匿名档是官方支持的档位（`tier: "anonymous"`），官方还专门声明
   * 「legacy text API 对已认证用户下线，匿名请求不受影响」。
   *
   * 代价要说清楚：匿名档有速率限制、模型只有这一个（gpt-oss-20b），
   * 而且**不支持 tools**。想要更多模型/更高额度，配上面那几家的密钥即可，
   * 它们会作为回退链的下一环自动接管。
   */
  pollinations: {
    label: "Pollinations (无密钥)",
    base: "https://text.pollinations.ai/openai",
    protocol: "openai",
    auth: "none",
    homepage: "https://pollinations.ai"
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
  // ---- Pollinations（无需任何密钥，开箱即用；默认模型就在这一档）----
  { id: "pollinations/gpt-oss-20b", ctx: 131072, caps: ["stream"] },
  { id: "pollinations/openai-fast", ctx: 131072, caps: ["stream"] },

  // ---- Qwen（OAuth 设备流，需要账号但不需要静态密钥）----
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

/**
 * 编译期默认模型：挑个「不需要任何密钥就能跑」的，这样 fork 完直接可用。
 * 运行期可以用 wrangler 的 `DEFAULT_MODEL` 变量覆盖（见 resolveDefaultModel）。
 */
export const DEFAULT_MODEL = "pollinations/gpt-oss-20b";

/**
 * 运行期的默认模型。
 *
 * 为什么要有这个函数：`wrangler.toml` 里一直有个 `DEFAULT_MODEL` 变量，
 * 注释还写着「想换默认模型改这里，不用改代码」—— 但**代码从来没读过它**。
 * 一个不生效的配置比没有配置更糟：用户改了、重启了、发现没变，然后开始
 * 怀疑自己改错了文件。
 *
 * 三条规则：
 *   1. env 里没写 / 空串 → 用编译期常量（默认行为不变）
 *   2. env 里写了且在目录里 → 用它
 *   3. env 里写了但**不在目录里** → 忽略并告警。不抛异常是刻意的：
 *      一个拼错的变量不该让整个 Worker 起不来，所有请求都挂。
 */

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

/**
 * 这个 id 在不在目录里？
 *
 * 刻意**不用模块级共享的 catalog 实例**：worker 自己持有一份（`worker.js`
 * 顶部 `const catalog = buildCatalog()`），这里再导出一份就意味着两处状态。
 * 目录是静态数据，重建一次的成本可以忽略，换来的是「只有一份真相」。
 */
export function isKnownModel(id) {
  return MODELS.some((m) => m.id === id);
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

export function resolveDefaultModel(env) {
  const configured = env?.DEFAULT_MODEL;
  if (typeof configured !== "string" || !configured.trim()) return DEFAULT_MODEL;
  const id = configured.trim();
  if (isKnownModel(id)) return id;
  console.warn(
    `env.DEFAULT_MODEL="${id}" 不在模型目录里，已忽略并回退到 ${DEFAULT_MODEL}。` +
      `可用值见 src/providers.js 的 MODELS。`
  );
  return DEFAULT_MODEL;
}
