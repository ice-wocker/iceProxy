#!/usr/bin/env node
/**
 * 校验 README 与 src/providers.js 的模型清单是否一致。
 *
 * 为什么需要这个：上一版 README 的标题写「7 free AI models」，
 * 正文表格列了 5 providers / 8+ models，package.json 写 5 个，
 * 而 worker.js 里实际是 8 个 —— 四份文档、四个数字，没有一个对得上。
 * 用户照着 description 填模型名会直接报 unknown model。
 *
 * 这类「文档漂移」用眼睛是看不住的（每次改动都觉得自己对），
 * 所以交给 CI。任何一方漂移就红。
 */
import { readFile } from "node:fs/promises";
import { MODELS, PROVIDERS, DEFAULT_MODEL } from "../src/providers.js";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const errors = [];
const warnings = [];

// ---- 1. 每个模型都必须在 README 里出现 ----
for (const m of MODELS) {
  if (!readme.includes("`" + m.id + "`")) {
    errors.push(`README 缺少模型 ${m.id}（代码里有，文档里没有）`);
  }
}

// ---- 2. README 里不该出现代码里没有的模型名 ----
// 抓 README 中所有看起来像「provider/model」的行内代码
const inlineCodes = [...readme.matchAll(/`([a-z0-9_.-]+\/[a-z0-9_.:/-]+)`/gi)].map((m) => m[1]);
const knownIds = new Set(MODELS.map((m) => m.id));
const knownPrefixes = new Set(Object.keys(PROVIDERS));
for (const code of new Set(inlineCodes)) {
  if (!code.includes("/")) continue;
  const prefix = code.split("/")[0];
  // 只关心「前缀是已知 provider」的那些，其余（路径、命令）跳过
  if (!knownPrefixes.has(prefix)) continue;
  if (knownIds.has(code)) continue;
  // 允许 README 里出现同族但不存在的 id 吗？不允许 —— 那正是用户会照抄的东西
  errors.push(`README 里的 ${code} 在代码里不存在（用户照抄会报 unknown model）`);
}

// ---- 3. 模型数量必须对得上 ----
const countPatterns = [
  /(\d+)\s*free\s+(?:AI\s+)?models/gi,
  /(\d+)\s*(?:个)?(?:免费)?模型/g,
];
const claimed = new Set();
for (const re of countPatterns) {
  for (const m of readme.matchAll(re)) claimed.add(Number(m[1]));
}
if (claimed.size) {
  const wrong = [...claimed].filter((n) => n !== MODELS.length);
  if (wrong.length) {
    errors.push(
      `README 声称有 ${wrong.join(" / ")} 个模型，代码里是 ${MODELS.length} 个`
    );
  }
}

// ---- 4. provider 数量 ----
const usedPrefixes = new Set(MODELS.map((m) => m.id.slice(0, m.id.indexOf("/"))));
const provPatterns = [/(\d+)\s*providers?/gi, /(\d+)\s*(?:家|个)\s*(?:provider|上游|服务商)/g];
const claimedProv = new Set();
for (const re of provPatterns) {
  for (const m of readme.matchAll(re)) claimedProv.add(Number(m[1]));
}
if (claimedProv.size) {
  const wrong = [...claimedProv].filter((n) => n !== usedPrefixes.size);
  if (wrong.length) {
    errors.push(
      `README 声称有 ${wrong.join(" / ")} 个 provider，实际用到 ${usedPrefixes.size} 个`
    );
  }
}

// ---- 5. 默认模型要写清楚 ----
if (!readme.includes(DEFAULT_MODEL)) {
  errors.push(`README 没提到默认模型 ${DEFAULT_MODEL}`);
}

// ---- 6. 每个 provider 都该在 README 里被介绍到 ----
for (const prefix of usedPrefixes) {
  if (!new RegExp(`\\b${prefix}\\b`, "i").test(readme)) {
    errors.push(`README 没有介绍 provider "${prefix}"`);
  }
}

// ---- 7. 行为清单：README 说有的，代码里必须真的有 ----
//
// 为什么要单独守这个：模型清单有 check-docs 守着（因为模型是「数据」，
// 能从 providers.js 读），但**行为**类的东西没人守。上一版就是这么飘的 ——
// README 写着「跨 provider 自动故障转移」，代码里只有 Qwen 的账号轮换，
// 文档描述了一个不存在的功能，而所有测试都是绿的。
//
// 这里做的是一个廉价的「存在性锚点」：README 里提到某个行为，
// 就必须能在源码里找到对应的实现符号。它挡不住「实现了但实现错了」，
// 但能挡住「文档在描述一个根本不存在的东西」——这恰恰是上一版发生的。
//
// 用法：在 README 里正常写功能描述，锚点写在这张表里。
// 删功能时这张表会先红，提醒你去同步文档。
const BEHAVIOR_ANCHORS = [
  {
    // README 提到「跨 provider 回退」时，必须真的有候选链构建
    doc: /failover|回退|故障转移/i,
    sources: ["src/worker.js"],
    symbols: ["buildFallbackChain", "isRetryable"],
    what: "跨 provider 回退"
  },
  {
    doc: /多账号|multi-account|Account rotation|账号轮换/i,
    sources: ["src/accounts.js"],
    symbols: ["isTokenFresh", "pick", "refresh", "penalize"],
    what: "Qwen 账号轮换"
  },
  {
    doc: /Streaming|流式/i,
    sources: ["src/openai.js", "src/worker.js"],
    symbols: ["iterSsePayloads", "sseChunk", "streamResponse"],
    what: "SSE 流式"
  },
  {
    doc: /stream.*downgrad|降级|event-stream/i,
    sources: ["src/worker.js"],
    symbols: ["assertStreamingResponse"],
    what: "上游不给事件流时的降级"
  },
  {
    // README 说 `/health` 只报「哪些密钥已配置」，那就不能回显密钥值
    doc: /health/i,
    sources: ["src/worker.js"],
    symbols: ["handleHealth"],
    what: "健康检查"
  }
];

const sourceCache = new Map();
async function readSource(rel) {
  if (!sourceCache.has(rel)) {
    sourceCache.set(rel, await readFile(new URL("../" + rel, import.meta.url), "utf8"));
  }
  return sourceCache.get(rel);
}

const missingAnchors = [];
for (const rule of BEHAVIOR_ANCHORS) {
  if (!rule.doc.test(readme)) continue; // README 没提这个功能，无需验证
  for (const rel of rule.sources) {
    let src;
    try {
      src = await readSource(rel);
    } catch {
      missingAnchors.push(`${rule.what}：找不到 ${rel}`);
      continue;
    }
    for (const sym of rule.symbols) {
      if (!new RegExp(`\\b${sym}\\b`).test(src)) {
        missingAnchors.push(`${rule.what}：README 提到了它，但 ${rel} 里没有 ${sym}`);
      }
    }
  }
}
for (const m of missingAnchors) {
  errors.push(`README 描述的行为在代码里找不到落点 —— ${m}`);
}

// ---- 7. 提醒：README 里不该出现硬编码的免费额度数字 ----
// 额度是会变的，写死了哪天就变成假信息。改成软提醒，不阻断。
for (const m of readme.matchAll(/(\d[\d,]*)\s*(req|requests)\s*\/\s*(day|min)/gi)) {
  warnings.push(`README 里有硬编码额度 "${m[0]}" —— 上游会改，建议去掉具体数字`);
}

if (warnings.length) {
  console.log("提醒（不阻断）：");
  for (const w of warnings) console.log("  ⚠️  " + w);
}

if (errors.length) {
  console.error("\nREADME 与代码不一致：");
  for (const e of errors) console.error("  ❌ " + e);
  console.error(`\n代码里实际有 ${MODELS.length} 个模型、${usedPrefixes.size} 个 provider。`);
  console.error("请同步 README.md，或修正 src/providers.js。");
  process.exit(1);
}

console.log(`README 与代码一致：${MODELS.length} 个模型 / ${usedPrefixes.size} 个 provider / 默认 ${DEFAULT_MODEL}`);
