# Changelog

## 2.0.0

重写。这一版的重点不是「加功能」，而是**修掉上一版里几个「本地绿、线上必挂」的问题**，
并把模型清单收敛到单一真相源。

### 修复（每条都有对应回归测试）

- **流式请求没有真的流式。** OpenAI 兼容分支里 `stream` 被硬编码成 `false`，
  于是客户端请求 `stream: true` 时收到一个普通 JSON。聊天类客户端（Cline、Cursor、
  各种 Web UI）会一直等一个不会到来的 SSE，表现为卡死。**这是 18 个模型里
  13 个的默认路径。**

- **Gemini 完全没有流式。** 上一版只实现了 `generateContent`，没有
  `streamGenerateContent`。

- **有效的 Qwen 账号被判定为不可用。** 账号池判断「token 是否有效」时读的是
  `acc.token`，而账号存的是 `access_token`。这个分支永远不会命中，所以每个请求
  都走「拿 refresh_token 去换」的路径。后果有两层：一是每个请求白白多一次上游往返；
  二是 refresh 一旦失败（这个 grant 不是稳定的公开接口，失败很常见），
  一个还有一小时寿命的**有效 token 会被冷藏一整天**，用户看到的是
  「no Qwen account available」。而 Qwen 是默认模型家族。

- **`README` 声称的「跨 provider 自动故障转移」并不存在。** 代码里只有 Qwen 的
  账号轮换。现在真的实现了：按「同模型 → 同 provider 其它模型 → 其它已配置
  provider」构建候选链，只在 429/401/403/5xx 时往下走。

- **错误体不是 OpenAI 形状。** 返回的是 `{"error": "unknown model: x"}`（字符串），
  而官方 SDK 会按 `{"error": {"message": ...}}` 解析。结果是用户看到客户端 SDK
  自己的解析异常，而不是真实原因。

- **Gemini 把多轮历史整段丢弃。** 只取 `messages` 的最后一条，而 Cline/Cursor
  每轮都带完整历史 —— 等于每轮都让模型失忆。

- **上游中途断开时，已收到的内容被丢掉。** SSE 拆帧函数在 `read()` 抛错时直接
  向上抛，缓冲区里已经读到、还没交付的那部分就被丢了。表现是「模型说到一半
  突然没了」，而且断在哪一半是随机的。

### 新增

- **模型目录与 provider 注册表分离**（`src/providers.js`），18 个模型 / 6 个 provider。
  新增模型不再需要复制 base/type/auth 三份配置。
- **`Groq`**。至此 6 个 provider。
- **`scripts/check-docs.mjs`** —— CI 里强制 README 与代码的模型清单一致。
  上一版 README 标题写 7 个模型、正文表格写 8+、`package.json` 写 5 个、
  代码里实际 8 个，四份数字没有一个对得上。
- **响应里标注实际服务的模型**：`_proxy` 字段 + `X-IceProxy-Fallback` 头。
- **`/v1/models` 带 `context_length` / `capabilities` / `available`。**
- **账号池按失败原因分级冷却**：限流一分钟、服务端错误十几秒、认证失败几小时。
  不再「一次 429 封一整天」。
- **并发刷新去重**：KV 没有原子操作，同时刷新同一账号会互相覆盖。
- **82 个单测**（上一版 15 个），全部离线、零依赖。

### 变更（可能影响你）

- **模型 ID 有增删**。`gemini/gemini-1.5-flash`、`openrouter/auto`、
  `qwen/vision-model` 被替换成实际可用的 ID。README 里那批「Qwen3-Max /
  GLM-5.3 / Kimi-K3」从来就不存在于代码里，已从文档中删除。
- **错误响应结构变了**（从字符串改成对象）。这是修 bug，但如果你写了
  针对旧格式的解析代码，需要跟着改。
- **`deploy.sh` 不再用 `sed` 改 `wrangler.toml`**。上一版的正则匹配的是
  注释行 `# id = "your_kv_id"`，一旦那行被改过格式，`sed` 会静默不匹配
  （退出码仍是 0），KV id 留在占位符上，部署出来的 Worker 每个 Qwen 请求都失败。
- **`scripts/auth.js` 改用 `execFileSync`**，不再手工拼 shell 字符串 ——
  上一版对含引号的 JSON 做手工转义，既容易出错也是命令注入面。
- **`package.json` 标记 `"type": "module"`**，Node >= 20。
