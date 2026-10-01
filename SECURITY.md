# 安全说明

## 报告漏洞

请**不要**开公开 Issue。用 GitHub 的私密漏洞报告：
仓库页 → Security → Advisories → "Report a vulnerability"。

## 这个项目的信任边界

理解这几条能省下很多来回：

**1. 你的 API key 就是账号权限。**
`OPENAI_API_KEYS`、`ADMIN_SECRET` 以及各家 provider 的密钥，都通过
`wrangler secret` 存放，不进代码库。它们一旦泄露，别人可以用你的免费额度，
或者通过 `/admin/health` 看到你的账号列表。

**2. Cloudflare 会看到你的密钥。**
这是 Workers 的固有属性 —— 在别人的运行时里跑的代码，密钥对运行时可见。
不要用它代理你不愿托付给 Cloudflare 的东西。

**3. Qwen 账号 token 存在 KV 里。**
`access_token` / `refresh_token` 以明文存在 Cloudflare KV，前缀 `acc:`。
它能访问你的 Qwen 账号。如果绑定了其它有权限的 Cloudflare 服务，
注意 KV 的访问范围。

**4. 上游会看到请求内容。**
这是代理的本来面目。免费额度换来的是「请求经过第三方」。

**5. 不要把 `ADMIN_SECRET` 留空。**
未配置时本项目直接关闭管理端点（而不是开放它）。
旧版本的行为是「未配置即放行」，那会泄露账号 id 和健康状态。

## 如果 key 泄露了

1. 立刻在对应厂商后台**吊销并重发**（Cloudflare 的用
   `wrangler secret put <NAME>` 覆盖，旧的即失效）。
2. 如果 `ADMIN_SECRET` 泄露，同样覆盖它 —— 不需要重新部署。
3. 如果 Qwen 账号 token 泄露，在 Qwen 侧退出该设备会话，
   然后 `node scripts/auth.js add` 重新添加账号。
4. 顺手看一眼 Cloudflare 的请求量，确认没有异常调用。

## 我们主动避开的坑

- **常量时间比较** API key 和 `ADMIN_SECRET`，避免通过响应时间逐字节猜。
- **`/health` 只报「哪些密钥已配置」，绝不回显值。**
- **`/admin/health` 不返回 token 明文**，只有是否存在和过期时间。
- **`scripts/auth.js` 用 `execFileSync` 传参**，不拼 shell 字符串
  （旧版手工转义 JSON，既是隐患也是注入面）。
- **本地凭据文件权限 `0600`。**
- **运行时零依赖** —— `dependencies` 为空，供应链面几乎为零。
- **响应头值全部过一遍 ASCII 白名单。** HTTP 头只能是 latin-1，而我们的值里
  可能带上游/模型带来的字符（`servedModel` 里的 `→` 就是真炸过的一个）。
  不经处理直接塞进 `headers` 会抛异常，或者更糟 —— 拼出注入。

## 不接受的报告

- 「免费额度可以跑满」—— 那是设计如此，别滥用就行。
- 「上游可以封掉这个用法」—— 见 README 的「局限」一节，这是已知的。
