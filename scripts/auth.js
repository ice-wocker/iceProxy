#!/usr/bin/env node
/**
 * iceProxy Qwen OAuth 辅助脚本
 *
 *   add [id]   扫码添加一个 Qwen 账号
 *   list       列出本地账号
 *   deploy     把本地账号推到 Cloudflare KV
 *   list-kv    列出 KV 里的账号
 *
 * 与 worker 共用同一份 OAuth 常量（src/accounts.js），避免两边写死的
 * clientId 哪天改了只改一处。之前是复制粘贴的两份，属于隐患。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

import { QWEN_CLIENT_ID, QWEN_DEVICE_CODE_URL, QWEN_TOKEN_URL } from "../src/accounts.js";

const STORE_DIR = path.join(process.cwd(), ".iceProxy");
const SCOPE = "openid profile email model.completion";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64url");

async function postForm(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: r.status, data };
}

async function initDevice() {
  const verifier = b64url(crypto.randomBytes(64));
  const r = await postForm(QWEN_DEVICE_CODE_URL, {
    client_id: QWEN_CLIENT_ID,
    scope: SCOPE,
    code_challenge: sha256(verifier),
    code_challenge_method: "S256"
  });
  if (r.status !== 200) throw new Error(`device init failed: ${r.status} ${JSON.stringify(r.data)}`);
  return { ...r.data, code_verifier: verifier };
}

const pollToken = (deviceCode, verifier) =>
  postForm(QWEN_TOKEN_URL, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: QWEN_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: verifier
  });

async function addAccount(accountId) {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const id = accountId || `qwen_${Date.now()}`;
  const device = await initDevice();

  console.log("\n扫码登录 Qwen");
  console.log("  用户码:", device.user_code);
  console.log("  链接:  ", device.verification_uri_complete || device.verification_uri);
  console.log("");
  openInBrowser(device.verification_uri_complete || device.verification_uri);

  const interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expires_in || 600) * 1000;
  let wait = interval;

  while (Date.now() < deadline) {
    await sleep(wait);
    const r = await pollToken(device.device_code, device.code_verifier);
    if (r.status === 200 && r.data.access_token) {
      const file = path.join(STORE_DIR, `account_${id}.json`);
      await fs.writeFile(
        file,
        JSON.stringify(
          {
            access_token: r.data.access_token,
            refresh_token: r.data.refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + (r.data.expires_in || 3600),
            type: "qwen-oauth",
            created_at: new Date().toISOString()
          },
          null,
          2
        ),
        { mode: 0o600 } // 这是等同账号权限的凭据，别让同机别的用户读到
      );
      console.log(`账号 ${id} 已保存到 ${file}`);
      return;
    }
    const err = r.data?.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      // 规范要求每次 slow_down 后把间隔再加 5 秒
      wait += 5000;
      continue;
    }
    if (err) throw new Error(`auth error: ${err} ${r.data.error_description || ""}`);
  }
  throw new Error("auth timeout —— 没在有效期内完成登录");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openInBrowser(url) {
  const tries = [
    ["termux-open-url", [url]],
    ["xdg-open", [url]],
    ["open", [url]]
  ];
  for (const [cmd, args] of tries) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return;
    } catch {
      // 换下一个；全都失败也无所谓，用户手上有链接
    }
  }
}

async function listLocal() {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const files = (await fs.readdir(STORE_DIR)).filter((f) => f.startsWith("account_") && f.endsWith(".json"));
  if (!files.length) {
    console.log("本地没有账号。先跑: node scripts/auth.js add");
    return;
  }
  console.log(`本地账号 (${files.length}):`);
  for (const f of files) {
    const id = f.replace(/^account_/, "").replace(/\.json$/, "");
    try {
      const d = JSON.parse(await fs.readFile(path.join(STORE_DIR, f), "utf8"));
      const mins = d.expires_at ? Math.max(0, Math.floor((d.expires_at - Date.now() / 1000) / 60)) : 0;
      console.log(`  - ${id}  (token 剩余 ${mins} 分钟${d.refresh_token ? "，可刷新" : "，无 refresh_token"})`);
    } catch {
      console.log(`  - ${id}  (文件损坏，跳过)`);
    }
  }
}

/**
 * 把本地账号推到 KV。
 *
 * 用 execFileSync 传参，不用 shell 拼接 —— 上一版是
 * `execSync(\`... "${key}" - <<< '${data.replace(...)}'\`)`，
 * 对含引号的 JSON 做手工转义，既容易出错也是个命令注入面。
 * 这里改成把值写进临时文件，让 wrangler 从文件读。
 */
async function deployAll() {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const files = (await fs.readdir(STORE_DIR)).filter((f) => f.startsWith("account_") && f.endsWith(".json"));
  if (!files.length) {
    console.log("没有本地账号。先运行: node scripts/auth.js add");
    return;
  }
  let failed = 0;
  for (const f of files) {
    const id = f.replace(/^account_/, "").replace(/\.json$/, "");
    const src = path.join(STORE_DIR, f);
    try {
      JSON.parse(await fs.readFile(src, "utf8")); // 先自检，别把坏数据推上去
      execFileSync(
        "npx",
        ["wrangler", "kv", "key", "put", "--binding=ACCOUNTS", `acc:${id}`, "--path", src, "--remote"],
        { stdio: "inherit", shell: process.platform === "win32" }
      );
      console.log(`已部署 ${id}`);
    } catch (e) {
      failed++;
      console.error(`部署 ${id} 失败:`, e.message);
    }
  }
  if (failed) process.exitCode = 1;
}

async function listKv() {
  try {
    const out = execFileSync("npx", ["wrangler", "kv", "key", "list", "--binding=ACCOUNTS", "--remote"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const ids = [...out.matchAll(/acc:(\S+)/g)].map((m) => m[1]);
    console.log(ids.length ? `KV 中的账号 (${ids.length}):\n` + ids.map((i) => "  - " + i).join("\n") : "KV 里没有账号");
  } catch {
    console.error("无法列出 KV。请确认已 wrangler login 且 wrangler.toml 里配好了 ACCOUNTS binding。");
    process.exitCode = 1;
  }
}

function usage() {
  console.log(`用法:
  node scripts/auth.js add [id]   添加 Qwen 账号（扫码）
  node scripts/auth.js list       列出本地账号
  node scripts/auth.js deploy     把所有本地账号推到 Cloudflare KV
  node scripts/auth.js list-kv    列出 KV 中的账号`);
}

const [cmd, arg] = process.argv.slice(2);
const commands = { add: addAccount, list: listLocal, deploy: deployAll, "deploy-all": deployAll, "list-kv": listKv };

try {
  const fn = commands[cmd];
  if (!fn) {
    usage();
    process.exitCode = cmd ? 2 : 0;
  } else {
    await fn(arg);
  }
} catch (e) {
  console.error("Error:", e.message);
  process.exitCode = 1;
}
