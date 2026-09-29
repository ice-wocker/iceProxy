/**
 * iceProxy - OpenAI-compatible API for 5 free AI models
 * 
 * Models:
 *   - qwen/qwen3-coder-plus       (Qwen code, 2000 req/day, OAuth)
 *   - qwen/qwen3-coder-flash      (Qwen code fast)
 *   - qwen/vision-model           (Qwen vision)
 *   - gemini/gemini-2.0-flash     (Google free)
 *   - gemini/gemini-1.5-flash     (Google free)
 *   - glm/glm-4.5-flash           (Zhipu BigModel free)
 *   - cerebras/qwen-3-32b         (Cerebras mirror free)
 *   - openrouter/*                (OpenRouter free models)
 *
 * Deploy: npx wrangler deploy
 * Auth:   node scripts/auth.js add
 * Secrets:
 *   OPENAI_API_KEYS  (comma-sep) - who can call your proxy
 *   ADMIN_SECRET     (optional)  - for /admin/health
 *   KV namespace ice_proxy (free 100k keys)
 */

const DEFAULT_MODEL = "qwen/qwen3-coder-flash";

// ---- Provider Config ----
const PROVIDERS = {
  "qwen/qwen3-coder-plus": {
    type: "qwen-oauth",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    oauth: "https://chat.qwen.ai"
  },
  "qwen/qwen3-coder-flash": {
    type: "qwen-oauth",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    oauth: "https://chat.qwen.ai"
  },
  "qwen/vision-model": {
    type: "qwen-oauth",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    oauth: "https://chat.qwen.ai"
  },
  "gemini/gemini-2.0-flash": {
    type: "gemini-key",
    base: "https://generativelanguage.googleapis.com/v1beta"
  },
  "gemini/gemini-1.5-flash": {
    type: "gemini-key",
    base: "https://generativelanguage.googleapis.com/v1beta"
  },
  "glm/glm-4.5-flash": {
    type: "openai-key",
    base: "https://open.bigmodel.cn/api/paas/v4"
  },
  "cerebras/qwen-3-32b": {
    type: "openai-key",
    base: "https://api.cerebras.ai/v1"
  },
  "openrouter/auto": {
    type: "openai-key",
    base: "https://openrouter.ai/api/v1"
  }
};

// ---- Qwen OAuth helpers ----
const QWEN_OAUTH = {
  deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
  tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
  clientId: "f0304373b74a44d2b584a3fb70ca9e56",
  scope: "openid profile email model.completion"
};

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

async function startQwenAuth() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await sha256(verifier));
  const body = new URLSearchParams({
    client_id: QWEN_OAUTH.clientId,
    scope: QWEN_OAUTH.scope,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  const r = await fetch(QWEN_OAUTH.deviceCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error("auth init failed: " + r.status);
  const d = await r.json();
  return { ...d, code_verifier: verifier };
}

async function pollQwenToken(deviceCode, verifier) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: QWEN_OAUTH.clientId,
    device_code: deviceCode,
    code_verifier: verifier
  });
  const r = await fetch(QWEN_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return { status: r.status, data: await r.json() };
}

// ---- Multi-account manager ----
class AccountPool {
  constructor(env) {
    this.env = env;
    this.failedToday = new Set();
  }
  
  // List all account ids stored in KV
  async listAccounts() {
    const list = await this.env.ACCOUNTS.list({ prefix: "acc:" });
    return list.keys.map(k => k.name.replace(/^acc:/, ""));
  }
  
  // Get a specific account
  async getAccount(id) {
    const raw = await this.env.ACCOUNTS.get("acc:" + id);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  
  // Save account
  async saveAccount(id, data) {
    await this.env.ACCOUNTS.put("acc:" + id, JSON.stringify(data));
  }
  
  async deleteAccount(id) {
    await this.env.ACCOUNTS.delete("acc:" + id);
  }
  
  // Pick best account for a model type
  async pickAccount(providerType) {
    const today = new Date().toISOString().slice(0, 10);
    // Reset failed list if new day
    if (this._lastReset !== today) {
      this._lastReset = today;
      this.failedToday = new Set();
    }
    
    const ids = await this.listAccounts();
    const candidates = [];
    for (const id of ids) {
      if (this.failedToday.has(id)) continue;
      const acc = await this.getAccount(id);
      if (!acc) continue;
      // Check token expiry
      if (acc.token && acc.expires_at && Date.now() / 1000 < acc.expires_at - 60) {
        candidates.push({ id, acc, score: acc.expires_at });
      } else if (acc.refresh_token) {
        // Try to refresh
        try {
          const newAcc = await this.refreshToken(acc);
          await this.saveAccount(id, newAcc);
          candidates.push({ id, acc: newAcc, score: newAcc.expires_at });
        } catch (e) {
          this.failedToday.add(id);
        }
      } else {
        this.failedToday.add(id);
      }
    }
    if (candidates.length === 0) return null;
    // Pick the freshest
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }
  
  markFailed(id) {
    this.failedToday.add(id);
  }
  
  async refreshToken(acc) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: acc.refresh_token,
      client_id: QWEN_OAUTH.clientId
    });
    const r = await fetch(QWEN_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!r.ok) throw new Error("refresh failed: " + r.status);
    const d = await r.json();
    return {
      ...acc,
      access_token: d.access_token,
      refresh_token: d.refresh_token || acc.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600)
    };
  }
}

// ---- Auth gate ----
function checkApiKey(req, env) {
  if (!env.OPENAI_API_KEYS) return true; // open mode
  const allowed = env.OPENAI_API_KEYS.split(",").map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  return allowed.includes(m[1]);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };
}

// ---- Provider calls ----
async function callQwenOAuth(req, env, pool) {
  const acc = await pool.pickAccount("qwen");
  if (!acc) {
    throw new Error("no Qwen account available. Add one via /v1/auth/start");
  }
  const modelId = req.model.replace(/^qwen\//, "");
  const upstream = {
    ...req,
    model: modelId,
    stream: !!req.stream
  };
  const r = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + acc.acc.access_token
    },
    body: JSON.stringify(upstream)
  });
  if (!r.ok) {
    const text = await r.text();
    if (r.status === 429 || r.status === 401) {
      pool.markFailed(acc.id);
    }
    throw new Error("qwen upstream " + r.status + ": " + text);
  }
  return r;
}

async function callGemini(req, env) {
  const modelId = req.model.replace(/^gemini\//, "");
  const msg = req.messages[req.messages.length - 1];
  const contents = [{
    role: "user",
    parts: [{ text: msg.content || "" }]
  }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
    })
  });
  if (!r.ok) throw new Error("gemini " + r.status + ": " + await r.text());
  const d = await r.json();
  // Convert to OpenAI format
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return new Response(JSON.stringify({
    id: "chatcmpl-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }), { headers: { "Content-Type": "application/json" } });
}

async function callOpenAICompat(req, env, base, modelId, keyName) {
  const apiKey = env[keyName];
  if (!apiKey) throw new Error("missing secret: " + keyName);
  const upstream = { ...req, model: modelId, stream: false };
  const r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify(upstream)
  });
  if (!r.ok) throw new Error("upstream " + r.status + ": " + await r.text());
  return r;
}

// ---- Routes ----
async function handleHealth() {
  return new Response(JSON.stringify({ status: "ok", service: "iceProxy" }), {
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function handleModels() {
  const models = Object.keys(PROVIDERS).map(id => ({
    id, object: "model", created: 0, owned_by: id.split("/")[0]
  }));
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function handleChat(req, env, pool) {
  const model = req.model || DEFAULT_MODEL;
  const provider = PROVIDERS[model];
  if (!provider) {
    return new Response(JSON.stringify({ error: "unknown model: " + model }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  }
  let upstreamResp;
  try {
    if (provider.type === "qwen-oauth") {
      upstreamResp = await callQwenOAuth(req, env, pool);
    } else if (provider.type === "gemini-key") {
      upstreamResp = await callGemini(req, env);
    } else if (provider.type === "openai-key") {
      const modelId = model.split("/").slice(1).join("/");
      let base = provider.base;
      let keyName = "OPENAI_COMPAT_KEY";
      if (model.startsWith("glm/")) keyName = "GLM_API_KEY";
      else if (model.startsWith("cerebras/")) keyName = "CEREBRAS_API_KEY";
      else if (model.startsWith("openrouter/")) keyName = "OPENROUTER_API_KEY";
      upstreamResp = await callOpenAICompat(req, env, base, modelId, keyName);
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message, type: "proxy_error" } }), {
      status: 502, headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  }
  // Pass through with CORS
  const headers = new Headers(upstreamResp.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers });
}

async function handleAuthStart(env) {
  const data = await startQwenAuth();
  return new Response(JSON.stringify({
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    verification_uri_complete: data.verification_uri_complete,
    expires_in: data.expires_in,
    interval: data.interval || 5,
    code_verifier: data.code_verifier
  }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleAuthPoll(req, env, pool) {
  const { device_code, code_verifier, account_id } = req;
  if (!device_code || !code_verifier) {
    return new Response(JSON.stringify({ error: "missing device_code or code_verifier" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  }
  const r = await pollQwenToken(device_code, code_verifier);
  if (r.status === 200) {
    const id = account_id || ("qwen_" + Date.now());
    await pool.saveAccount(id, {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (r.data.expires_in || 3600),
      type: "qwen-oauth",
      created_at: new Date().toISOString()
    });
    return new Response(JSON.stringify({ status: "ok", account_id: id }), {
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  }
  return new Response(JSON.stringify(r.data), {
    status: r.status, headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function handleAdminHealth(req, env, pool) {
  if (env.ADMIN_SECRET) {
    const auth = req.headers.get("Authorization") || "";
    if (auth !== "Bearer " + env.ADMIN_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
  }
  const ids = await pool.listAccounts();
  const accounts = [];
  for (const id of ids) {
    const acc = await pool.getAccount(id);
    accounts.push({
      id,
      has_token: !!acc?.access_token,
      expires_in_min: acc ? Math.max(0, Math.floor((acc.expires_at - Date.now() / 1000) / 60)) : 0,
      failed: pool.failedToday.has(id)
    });
  }
  return new Response(JSON.stringify({ total: ids.length, accounts }), {
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

// ---- Main handler ----
// 供单元测试使用的具名导出（Cloudflare Worker 运行时只认 default）
export { PROVIDERS, DEFAULT_MODEL, checkApiKey, corsHeaders };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    
    if (url.pathname === "/" || url.pathname === "/health") {
      return handleHealth();
    }
    if (url.pathname === "/v1/models") {
      return handleModels();
    }
    if (url.pathname === "/v1/chat/completions") {
      if (!checkApiKey(request, env)) {
        return new Response(JSON.stringify({ error: "invalid api key" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }
      const body = await request.json();
      const pool = new AccountPool(env);
      return handleChat(body, env, pool);
    }
    if (url.pathname === "/v1/auth/start" && request.method === "POST") {
      return handleAuthStart(env);
    }
    if (url.pathname === "/v1/auth/poll" && request.method === "POST") {
      if (!checkApiKey(request, env)) {
        return new Response("unauthorized", { status: 401, headers: corsHeaders() });
      }
      const body = await request.json();
      const pool = new AccountPool(env);
      return handleAuthPoll(body, env, pool);
    }
    if (url.pathname === "/admin/health") {
      const pool = new AccountPool(env);
      return handleAdminHealth(request, env, pool);
    }
    return new Response("not found", { status: 404, headers: corsHeaders() });
  }
};
