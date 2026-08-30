#!/usr/bin/env node
/**
 * iceProxy Qwen OAuth helper
 *  - add:   add a new account via QR code
 *  - list:  list all accounts in local .iceProxy/ folder
 *  - deploy: push all accounts to Cloudflare KV
 *  - list-kv: list accounts already in Cloudflare KV
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const readline = require("readline");
const http = require("http");

const QWEN = {
  base: "https://chat.qwen.ai",
  clientId: "f0304373b74a44d2b584a3fb70ca9e56",
  scope: "openid profile email model.completion"
};

const STORE_DIR = path.join(process.cwd(), ".iceProxy");

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("base64url");
}

async function postForm(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  return { status: r.status, data: await r.json() };
}

async function initDevice() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = sha256(verifier);
  const r = await postForm(QWEN.base + "/api/v1/oauth2/device/code", {
    client_id: QWEN.clientId,
    scope: QWEN.scope,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  if (r.status !== 200) throw new Error("device init failed: " + JSON.stringify(r.data));
  return { ...r.data, code_verifier: verifier };
}

async function pollToken(deviceCode, verifier) {
  const r = await postForm(QWEN.base + "/api/v1/oauth2/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: QWEN.clientId,
    device_code: deviceCode,
    code_verifier: verifier
  });
  return r;
}

async function addAccount(accountId) {
  await fs.promises.mkdir(STORE_DIR, { recursive: true });
  if (!accountId) accountId = "qwen_" + Date.now();
  const device = await initDevice();
  
  console.log("\n📱 扫码登录 Qwen:");
  console.log("  用户码:", device.user_code);
  console.log("  链接:", device.verification_uri_complete || device.verification_uri);
  console.log("");
  
  // Try to open browser
  try {
    const open = require("child_process");
    const url = device.verification_uri_complete || device.verification_uri;
    open.execSync(`am start -a android.intent.action.VIEW -d "${url}" 2>/dev/null || xdg-open "${url}" 2>/dev/null || open "${url}" 2>/dev/null`, { stdio: "ignore" });
  } catch (e) {}
  
  const interval = (device.interval || 5) * 1000;
  const start = Date.now();
  const timeout = (device.expires_in || 600) * 1000;
  
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, interval));
    const r = await pollToken(device.device_code, device.code_verifier);
    if (r.status === 200) {
      const data = {
        access_token: r.data.access_token,
        refresh_token: r.data.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (r.data.expires_in || 3600),
        resource_url: r.data.resource_url,
        type: "qwen-oauth",
        created_at: new Date().toISOString()
      };
      const file = path.join(STORE_DIR, `account_${accountId}.json`);
      await fs.promises.writeFile(file, JSON.stringify(data, null, 2));
      console.log(`✅ 账号 ${accountId} 已保存到 ${file}`);
      return data;
    }
    if (r.data.error === "authorization_pending") continue;
    if (r.data.error === "slow_down") {
      await new Promise(r => setTimeout(r, interval));
      continue;
    }
    if (r.data.error) {
      throw new Error("auth error: " + r.data.error + " " + (r.data.error_description || ""));
    }
  }
  throw new Error("auth timeout");
}

async function listLocal() {
  await fs.promises.mkdir(STORE_DIR, { recursive: true });
  const files = await fs.promises.readdir(STORE_DIR);
  const accounts = files.filter(f => f.startsWith("account_") && f.endsWith(".json"));
  console.log(`本地账号 (${accounts.length}):`);
  for (const f of accounts) {
    const id = f.replace(/^account_/, "").replace(/\.json$/, "");
    const data = JSON.parse(await fs.promises.readFile(path.join(STORE_DIR, f), "utf8"));
    console.log(`  - ${id} (expires in ${Math.max(0, Math.floor((data.expires_at - Date.now()/1000) / 60))} min)`);
  }
}

async function deployAll() {
  await fs.promises.mkdir(STORE_DIR, { recursive: true });
  const files = await fs.promises.readdir(STORE_DIR);
  const accounts = files.filter(f => f.startsWith("account_") && f.endsWith(".json"));
  if (accounts.length === 0) {
    console.log("没有本地账号。先运行: node scripts/auth.js add");
    return;
  }
  for (const f of accounts) {
    const id = f.replace(/^account_/, "").replace(/\.json$/, "");
    const data = await fs.promises.readFile(path.join(STORE_DIR, f), "utf8");
    const key = `acc:${id}`;
    try {
      execSync(`npx wrangler kv key put --binding=ACCOUNTS "${key}" - <<< '${data.replace(/'/g, "'\\''")}'`, { stdio: "inherit" });
      console.log(`✅ ${id} 已部署`);
    } catch (e) {
      console.error(`❌ ${id} 部署失败:`, e.message);
    }
  }
}

async function listKv() {
  try {
    const out = execSync(`npx wrangler kv list --binding=ACCOUNTS 2>/dev/null`, { encoding: "utf8" });
    console.log("Cloudflare KV 中的账号:");
    out.split("\n").forEach(l => {
      const m = l.match(/acc:(\S+)/);
      if (m) console.log("  -", m[1]);
    });
  } catch (e) {
    console.error("无法列出 KV。请先部署 Worker 并配置 ACCOUNTS KV binding。");
  }
}

const cmd = process.argv[2];
const arg = process.argv[3];

(async () => {
  try {
    if (cmd === "add") await addAccount(arg);
    else if (cmd === "list") await listLocal();
    else if (cmd === "deploy" || cmd === "deploy-all") await deployAll();
    else if (cmd === "list-kv") await listKv();
    else {
      console.log(`用法:
  node scripts/auth.js add [account-id]   - 添加 Qwen 账号 (扫码)
  node scripts/auth.js list              - 列出本地账号
  node scripts/auth.js deploy            - 部署所有账号到 CF KV
  node scripts/auth.js list-kv           - 列出 KV 中的账号`);
    }
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
})();
