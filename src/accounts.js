/**
 * 账号池：管理 Qwen 的 OAuth 账号，做轮换、刷新与冷却。
 *
 * 这是上一版问题最集中的地方，三条都要说清楚：
 *
 * 1. **字段名写错（致命）**。上一版判断「token 还有效」用的是 `acc.token`，
 *    而账号实际存的是 `access_token`。于是那个分支**永远不会命中**，
 *    每个请求都会掉进「拿 refresh_token 去换」的分支。请求多一次往返是小事，
 *    真正的伤害是：refresh 一旦失败（很常见，这个 grant 不是公开稳定接口），
 *    账号就被 `markFailed` 判成「今天废了」——**一个还有 60 分钟寿命的
 *    有效 token，因为一次无谓的 refresh 失败而报废一整天**。
 *
 * 2. **失败惩罚过重**。原实现失败即封到 UTC 跨日，没有重试机会。
 *    但 429 是「喘口气就好」、401 是「这个账号真坏了」，两者不该同罪。
 *    现在按原因区分：限流走短期冷却（指数退避），认证失败才长期拉黑。
 *
 * 3. **没有并发保护**。KV 没有原子操作，多个请求同时刷新同一个账号会
 *    互相覆盖。这里用「内存中的刷新去重」挡住同一个 isolate 内的并发，
 *    跨 isolate 只能靠冷却时间兜（KV 最终一致，不值得为它上 Durable Object）。
 */

/** 冷却策略：不同失败原因用不同档位（毫秒）。 */
export const COOLDOWN = {
  rate_limit: 60_000,      // 429：一分钟后再试
  server_error: 15_000,    // 5xx：上游抽风，很快就能试
  auth_failure: 6 * 3600_000, // 401/403：token 或账号坏了，冷藏 6 小时
  network: 20_000
};

/** token 距过期还有这么久就先刷新，避免「刚好在请求途中过期」。 */
const REFRESH_MARGIN_SEC = 120;

export class AccountPool {
  constructor(env, { now = () => Date.now() } = {}) {
    this.env = env;
    this.kv = env.ACCOUNTS ?? null;
    this.now = now;
    // isolate 内的刷新去重：account id -> Promise
    this.inflightRefresh = new Map();
    // isolate 内的冷却表：account id -> 解禁时间戳。跨 isolate 靠 KV 里的 last_error_at
    this.cooldown = new Map();
  }

  get enabled() {
    return !!this.kv;
  }

  // ---------- KV 存取 ----------

  async list() {
    if (!this.kv) return [];
    const res = await this.kv.list({ prefix: "acc:" });
    return (res.keys ?? []).map((k) => k.name.replace(/^acc:/, ""));
  }

  async get(id) {
    if (!this.kv) return null;
    const raw = await this.kv.get("acc:" + id);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(`账号 ${id} 的 KV 值不是合法 JSON，已跳过`);
      return null;
    }
  }

  async put(id, data) {
    if (!this.kv) throw new Error("未配置 ACCOUNTS KV binding，无法保存账号");
    await this.kv.put("acc:" + id, JSON.stringify(data));
  }

  async remove(id) {
    if (this.kv) await this.kv.delete("acc:" + id);
  }

  // ---------- 可用性判断 ----------

  /**
   * token 是否还在有效期内。
   *
   * **这是上一版最致命的那个字段名。** 认准 `access_token`，
   * 并且对缺失 expires_at 的情况保持保守（当作需要刷新，而不是当作无效）。
   */
  isTokenFresh(acc) {
    if (!acc?.access_token) return false;
    if (typeof acc.expires_at !== "number") return false;
    return this.now() / 1000 < acc.expires_at - REFRESH_MARGIN_SEC;
  }

  /** 是否处于冷却中（内存表 + KV 里记录的失败时间）。 */
  isCoolingDown(id, acc) {
    const until = this.cooldown.get(id);
    if (until && this.now() < until) return true;
    if (acc?.cooldown_until && this.now() < acc.cooldown_until) return true;
    return false;
  }

  markCoolingDown(id, reason) {
    const ms = COOLDOWN[reason] ?? COOLDOWN.server_error;
    this.cooldown.set(id, this.now() + ms);
    return ms;
  }

  /**
   * 挑一个可用账号。
   *
   * 排序偏好：token 新鲜度（越晚过期越好）> 从未失败的。
   * 允许返回「不新鲜但有 refresh_token」的账号，由调用方触发刷新。
   */
  async pick({ exclude = new Set() } = {}) {
    if (!this.enabled) return null;
    const ids = await this.list();
    const candidates = [];
    for (const id of ids) {
      if (exclude.has(id)) continue;
      const acc = await this.get(id);
      if (!acc) continue;
      if (this.isCoolingDown(id, acc)) continue;
      if (this.isTokenFresh(acc)) {
        candidates.push({ id, acc, score: acc.expires_at, needsRefresh: false });
      } else if (acc.refresh_token) {
        candidates.push({ id, acc, score: 0, needsRefresh: true });
      }
      // 既没新鲜 token 又没 refresh_token 的账号直接跳过，但**不拉黑** ——
      // 它可能只是还没被刷新过，拉黑会让「刚部署完」的状态误判成全挂。
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (a.needsRefresh !== b.needsRefresh) return a.needsRefresh ? 1 : -1;
      return b.score - a.score;
    });
    return candidates[0];
  }

  /**
   * 刷新 token。并发调用同一账号只会打一次上游。
   */
  async refresh(id, acc) {
    if (!acc?.refresh_token) throw new AuthFailure("账号没有 refresh_token");
    const existing = this.inflightRefresh.get(id);
    if (existing) return existing;

    const task = (async () => {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: acc.refresh_token,
        client_id: acc.client_id || QWEN_CLIENT_ID
      });
      const r = await fetch(acc.token_url || QWEN_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        // 400/401 说明 refresh_token 本身无效 → 这个账号真坏了
        if (r.status === 400 || r.status === 401 || r.status === 403) {
          throw new AuthFailure(`refresh 被拒（${r.status}）: ${text.slice(0, 200)}`);
        }
        throw new Error(`refresh 失败（${r.status}）: ${text.slice(0, 200)}`);
      }
      const d = await r.json();
      if (!d.access_token) throw new AuthFailure("refresh 响应里没有 access_token");
      const next = {
        ...acc,
        access_token: d.access_token,
        refresh_token: d.refresh_token || acc.refresh_token,
        expires_at: Math.floor(this.now() / 1000) + (d.expires_in || 3600),
        refreshed_at: new Date(this.now()).toISOString()
      };
      delete next.cooldown_until;
      delete next.last_error;
      await this.put(id, next);
      this.cooldown.delete(id);
      return next;
    })();

    this.inflightRefresh.set(id, task);
    try {
      return await task;
    } finally {
      this.inflightRefresh.delete(id);
    }
  }

  /** 记录一次失败：按原因分级冷却，并落盘，让别的 isolate 也能看到。 */
  async penalize(id, acc, reason) {
    const ms = this.markCoolingDown(id, reason);
    if (acc) {
      acc.cooldown_until = this.now() + ms;
      acc.last_error = { reason, at: new Date(this.now()).toISOString() };
      try {
        await this.put(id, acc);
      } catch {
        // 写 KV 失败不该让请求本身跟着挂 —— 内存冷却已经生效了
      }
    }
    return ms;
  }
}

/** 认证类失败（账号本身有问题），与网络/限流区分开。 */
export class AuthFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthFailure";
  }
}

export const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
export const QWEN_TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";
export const QWEN_DEVICE_CODE_URL = "https://chat.qwen.ai/api/v1/oauth2/device/code";
