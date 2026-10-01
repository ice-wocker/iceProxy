# 贡献指南

## 这个项目的底线

1. **运行时零依赖。** `package.json` 的 `dependencies` 必须一直是空的。
   `devDependencies` 里只有 `wrangler`（部署工具，不参与运行时）。
   单测用 Node 自带的 `node:test`，不引测试框架。
2. **单一真相源。** 模型清单只写在 `src/providers.js`。README 里的表格由
   CI（`scripts/check-docs.mjs`）强制与它保持一致。不要在别处再抄一份。
3. **不硬编码会过期的事实。** 免费额度、模型数量这类会变的东西，
   要么从代码推导，要么不写。README 里写死的「2000 req/day」是上一版的教训。
4. **每修一个 bug，补一条会红的测试。** 见下文。

## 关于测试

跑：

```bash
npm run check      # 语法 + 单测 + 文档一致性 + 本地端到端（全程不出网）
npm run probe      # 真的打上游一次，看模型名还在不在（唯一出网的检查）
```

三层，缺一不可：

- **`npm test`**（单测，零依赖、离线）测的是函数级契约；
- **`scripts/verify-local.mjs`**（端到端）把 Worker 挂在一个本地假上游上，
  用真实 HTTP 跑一遍客户端会走的路，看的是原始报文 —— 响应头、
  分块边界、`[DONE]`。

为什么必须有第二层：这个项目修掉的两个 bug（`X-IceProxy-Fallback` 只在流式
路径上设、header 里的 `→` 让回退变成 500）**单测全绿、端到端第一次跑就炸**。
函数返回值都对，错的是「发给客户端的那个报文」。凡是涉及响应头、
报文形状、分块边界的东西，都要能在 `verify-local.mjs` 里看到一条断言。

第三层（`npm run probe`）回答的是前两层**永远回答不了**的问题：
**上游还认不认这个模型名。** 免费档会悄悄下线模型 ID，而这种腐坏在本地
永远是绿的 —— 假上游只按你写的规则回话，它不会告诉你「这个 id 已经没了」。
给 PR 加模型时，请把 `npm run probe -- --model <你的新模型>` 的结果贴上来。

写测试时请遵守一条：**先确认你的测试在 bug 存在时会变红。**

做法是把修复临时还原，跑一遍，看它是否失败。例如：

```bash
# 假设你修了一个字段名 bug
cp src/accounts.js /tmp/acc.bak
# 手动把修复改回去
npm test        # 这一步必须看到失败
cp /tmp/acc.bak src/accounts.js
npm test        # 恢复后必须全绿
```

没做过这一步的测试，很可能是一条**橡皮图章**：断言写得看着合理，
但缺陷存在时它也照样通过。本项目上一版的测试基本都是这个毛病
——测的全是「配置项自洽」（比如「base 是不是 https」），
而真实发生的故障（流式返回 JSON、有效 token 被判失效）一条都没覆盖。

所以测试按**故障现象**组织，不按代码结构组织。文件里的分节标题就是
「这类故障」，每条 `test()` 的名字就是「用户看到的现象」。

## 加一个新模型

1. 在 `src/providers.js` 的 `MODELS` 里加一行：

   ```js
   { id: "provider/model-name", ctx: 131072, caps: ["tools", "stream"] },
   ```

   如果 provider 已存在，只加这一行就够。新增 provider 才需要在
   `PROVIDERS` 里加声明（含 `base` / `protocol` / `auth` / `keyEnv`）。

2. **实测确认这个模型的 id 在真上游存在。** 不要凭印象写。
   `unknown model` 这类错误用户是没法自救的。OpenRouter 的模型可以直接查：

   ```bash
   curl -s https://openrouter.ai/api/v1/models | node -e '
     let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
       const ids=JSON.parse(s).data.map(m=>m.id);
       console.log(ids.filter(i=>i.includes("你的关键词")).join("\n"));
     })'
   ```

3. 更新 `README.md` 的模型表，然后：

   ```bash
   node scripts/check-docs.mjs   # 不一致会直接告诉你差在哪
   ```

4. **真发一次请求确认它回话。** 上一步只证明「文档和代码一致」，
   不证明「上游认这个名字」：

   ```bash
   node scripts/probe-models.mjs --model provider/your-new-model
   ```

   看到 `🔑` 说明是凭据问题（换个真 key 再试），看到 `✖` 才是模型名有问题。
   **把结果贴进 PR 描述** —— 这是唯一能证明这个 id 存在的证据。

## 改协议相关的东西

`src/openai.js`（SSE 帧与错误形状）和 `src/adapters.js`（各家协议转换）
是兼容性的地基。改动这两处时，请：

- 不要依赖「一次 `read()` 就是一行」。真实网络会把一行切成任意碎片。
  测试里有对应的用例，别删。
- 错误体必须是 `{"error": {"message", "type", "code"}}` 对象。
- 流式响应必须以字面量 `data: [DONE]` 收尾，否则客户端会一直等。
- **`Response` 的 body 是一次性的，读法有顺序。** 想「先试 JSON、失败再拿文本」，
  必须**先 `text()` 再自己 `JSON.parse`**。反过来写（`json()` 失败后调 `text()`）
  会踩到：失败的 `json()` 已经 `discard()` 了 body，后面的 `text()` 抛
  `Body is unusable`，被 `catch` 兜成空串 —— 代码看着在保留原文，
  实际什么都没保留，而且**不报错**。3.1.0 第一版就是这么写的，
  变异测试才发现。

## 提交前

```bash
npm run check                  # 语法 + 单测 + 文档一致性 + 端到端
bash -n deploy.sh
```

## 加一个新的「行为」

`scripts/check-docs.mjs` 会校验「README 提到的行为在源码里有没有落点」。
新增一个能写进 README 的行为时，往那张 `BEHAVIOR_ANCHORS` 表里加一条：
一个 README 里会出现的说法（正则）、一两个实现符号。
删功能时它会先红，提醒你同步文档 —— 上一版 README 描述了一个不存在的
「跨 provider 自动故障转移」，就是这么飘掉的。

## 提交信息

用 `fix:` / `feat:` / `chore:` / `docs:` 开头，正文说清**现象**和**根因**，
不只是结论。「修了流式」是废话，「stream 被硬编码成 false，导致客户端卡死」才有用。
