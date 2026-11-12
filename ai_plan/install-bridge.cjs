#!/usr/bin/env node
/**
 * AgentHub × agent_auto 补丁器
 *
 * 用法（在 d:\projects\tools\agent_proxy 下）：
 *   node install-bridge.cjs check      # 只检查 4 个锚点是否完好 / 是否已打补丁
 *   node install-bridge.cjs apply      # 幂等打补丁
 *   node install-bridge.cjs revert     # 还原成作者原样（同步上游代码后跑这个，或直接 git checkout）
 *   node install-bridge.cjs lint       # 离线校验 rules.json ↔ channels.json
 *   node install-bridge.cjs channels   # 打印渠道词典摘要
 *   node install-bridge.cjs channels --refresh --token <只读令牌> [--base http://127.0.0.1:9528]
 *
 * 锚点全部按「整行精确匹配」判定：找不到或不唯一就拒绝改，绝不模糊替换。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SERVER = path.join(__dirname, "AgentHub", "electron", "backend", "localgw", "server.cjs");

const DECL_ORIG = "    const declared = models.bindings(model, new Set(), snapshot).filter((m) => !allowed || allowed.has(m.channel));";
const DECL_PATCH = "    const declared = require(\"./agent_auto/index.cjs\").declare(model, models.bindings(model, new Set(), snapshot).filter((m) => !allowed || allowed.has(m.channel)), { allowed, snapshot });";

const APPLY_ORIG = "      }\n      const channel = binding.channel;";
const APPLY_PATCH = "      }\n      binding = require(\"./agent_auto/index.cjs\").apply(binding, { bindings, model, excluded, triedAccounts, attempt: attemptLedger.used + 1 }) || binding;\n      const channel = binding.channel;";

const LIST_ORIG = "const rows = [...new Map(models.list(snapshot).filter((m) => (!allowed || allowed.has(m.channel)) && serviceReady(m.channel)).map((m) => [m.display, m])).values()].map((m) => ({";
const LIST_PATCH = "const rows = [...new Map(require(\"./agent_auto/index.cjs\").list(snapshot).filter((m) => (!allowed || allowed.has(m.channel)) && serviceReady(m.channel)).map((m) => [m.display, m])).values()].map((m) => ({";

const ANTH_ORIG = "const rows = [...new Map(models.list(snapshot).filter((m) => (!allowed || allowed.has(m.channel)) && serviceReady(m.channel)).map((m) => [m.display, m])).values()];";
const ANTH_PATCH = "const rows = [...new Map(require(\"./agent_auto/index.cjs\").list(snapshot).filter((m) => (!allowed || allowed.has(m.channel)) && serviceReady(m.channel)).map((m) => [m.display, m])).values()];";

const AUTH_ORIG = "  const raw = (m ? m[1] : (req.headers[\"x-api-key\"] || \"\")).trim();";
const AUTH_PATCH = "  const raw = require(\"./agent_auto/index.cjs\").translateKey((m ? m[1] : (req.headers[\"x-api-key\"] || \"\")).trim());";

const BOOT_ORIG = "async function doStart() {\n  const c = lgwConfig.get();";
const BOOT_PATCH = "async function doStart() {\n  try { require(\"./agent_auto/index.cjs\").ensureDictLater(null); } catch { /* 启动时先落一份渠道字典；失败不影响启动 */ }\n  const c = lgwConfig.get();";

const PATCHES = [
  { name: "① 模型解析 (L350)", orig: DECL_ORIG, patched: DECL_PATCH },
  { name: "② 选号改写 (L431/432)", orig: APPLY_ORIG, patched: APPLY_PATCH },
  { name: "③ /v1/models (L540)", orig: LIST_ORIG, patched: LIST_PATCH },
  { name: "④ Anthropic /v1/models (L555)", orig: ANTH_ORIG, patched: ANTH_PATCH },
  { name: "⑤ Token 映射 (L65)", orig: AUTH_ORIG, patched: AUTH_PATCH },
  { name: "⑥ 启动生成字典 (doStart)", orig: BOOT_ORIG, patched: BOOT_PATCH },
];

function count(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return n;
    n += 1;
    from = i + needle.length;
  }
}

function inspect(src) {
  // 多行锚点要跟随源文件换行符（仓库里是 CRLF，脚本里写的是 LF）
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  return PATCHES.map((raw) => {
    const p = { ...raw, orig: raw.orig.replace(/\n/g, eol), patched: raw.patched.replace(/\n/g, eol) };
    const orig = count(src, p.orig);
    const patched = count(src, p.patched);
    const state = patched === 1 && orig === 0 ? "patched" : patched === 0 && orig === 1 ? "clean" : "broken";
    return { ...p, state, origCount: orig, patchedCount: patched };
  });
}

function readServer() {
  if (!fs.existsSync(SERVER)) {
    console.error(`找不到 ${SERVER}`);
    process.exit(2);
  }
  return fs.readFileSync(SERVER, "utf8");
}

function cmdCheck() {
  const src = readServer();
  const rows = inspect(src);
  let bad = 0;
  for (const r of rows) {
    const mark = r.state === "patched" ? "PATCHED" : r.state === "clean" ? "clean  " : "BROKEN ";
    console.log(`${mark} ${r.name}  (orig=${r.origCount}, patched=${r.patchedCount})`);
    if (r.state === "broken") bad += 1;
  }
  if (bad) {
    console.error(`\n${bad} 个锚点状态异常：上游代码可能改过，先人工确认再 apply。`);
    process.exit(1);
  }
  console.log("\n全部锚点完好。");
}

function cmdApply() {
  let src = readServer();
  const before = inspect(src);
  if (before.some((r) => r.state === "broken")) {
    console.error("锚点状态异常，拒绝打补丁：");
    for (const r of before) if (r.state === "broken") console.error(`  ${r.name} (orig=${r.origCount}, patched=${r.patchedCount})`);
    process.exit(1);
  }
  let changed = 0;
  for (const r of before) {
    if (r.state === "patched") continue;
    src = src.replace(r.orig, r.patched);
    changed += 1;
    console.log(`patched ${r.name}`);
  }
  if (!changed) {
    console.log("已经是补丁状态，无需修改。");
    return;
  }
  fs.writeFileSync(SERVER, src);
  console.log(`\n写入完成：${changed} 处。随后请跑 npm run verify:gateway 或 node --check。`);
}

function cmdRevert() {
  let src = readServer();
  const rows = inspect(src);
  let changed = 0;
  for (const r of rows) {
    if (r.state !== "patched") continue;
    src = src.split(r.patched).join(r.orig);
    changed += 1;
    console.log(`reverted ${r.name}`);
  }
  if (!changed) {
    console.log("当前不是补丁状态。");
    return;
  }
  fs.writeFileSync(SERVER, src);
  console.log(`\n还原完成：${changed} 处。`);
}

function dataDir() {
  const i = process.argv.indexOf("--data");
  if (i > 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  if (process.env.AGENTHUB_DATA_DIR) return path.resolve(process.env.AGENTHUB_DATA_DIR);
  // 与 electron/backend/config.cjs 的 dataDir() 同口径：桌面与纯 Node 都落在 %APPDATA%\AgentHub
  return path.join(process.env.APPDATA || require("node:os").homedir(), "AgentHub");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function rulesFile() {
  const primary = path.join(dataDir(), "agent_auto", "rules.json");
  if (fs.existsSync(primary)) return primary;
  return path.join(__dirname, "AgentHub", "electron", "backend", "localgw", "agent_auto", "rules.json");
}

/** 日志里不打印完整 token：只留头尾 */
function maskKey(v) {
  const s = String(v == null ? "" : v);
  if (s.length <= 8) return "*".repeat(s.length || 1);
  return `${s.slice(0, 4)}***${s.slice(-3)}`;
}

/** 用本机密钥库校验映射目标（只读 authenticate，不写计数）。
 *  加载失败（缺依赖 / 密钥库不可用）时静默跳过，不阻塞 lint。 */
function verifyMappedKeys(targets) {
  if (!targets.length) return [];
  let ks = null;
  try {
    if (!process.env.AGENTHUB_DATA_DIR) process.env.AGENTHUB_DATA_DIR = dataDir();
    ks = require("./AgentHub/electron/backend/localgw/keys-store.cjs");
  } catch {
    return [];
  }
  const out = [];
  for (const t of targets) {
    try {
      const r = ks.authenticate(t);
      if (!r || !r.ok) out.push(`api_keys 目标「${maskKey(t)}」不是本机可用密钥（${(r && r.reason) || "unknown"}），映射后必然 401`);
    } catch { /* 单条校验失败不影响其它条目 */ }
  }
  return out;
}

function cmdLint() {
  const rp = rulesFile();
  const rules = readJson(rp);
  if (!rules) {
    console.error(`rules.json 不可读：${rp}`);
    process.exit(2);
  }
  const dictPath = path.join(dataDir(), "agent_auto", "channels.json");
  const dict = readJson(dictPath);
  const known = new Map((dict && dict.channels ? dict.channels : []).map((c) => [c.key, c]));
  const problems = [];
  const models = rules.models && typeof rules.models === "object" ? rules.models : {};
  const budget = 3;
  for (const [name, list] of Object.entries(models)) {
    if (!Array.isArray(list) || !list.length) {
      problems.push({ level: "error", message: `模型「${name}」的候选为空` });
      continue;
    }
    if (list.length > budget) problems.push({ level: "warn", message: `模型「${name}」有 ${list.length} 个候选，超过默认重试预算 ${budget}` });
    const per = new Map();
    for (const c of list) {
      per.set(c.channel, (per.get(c.channel) || 0) + 1);
      if (!dict) continue;
      const ch = known.get(c.channel);
      if (!ch) {
        problems.push({ level: "error", message: `模型「${name}」引用了不存在的渠道「${c.channel}」` });
        continue;
      }
      if (!ch.enabled) problems.push({ level: "warn", message: `渠道「${c.channel}」已停用` });
      if (ch.routingEnabled === false) problems.push({ level: "warn", message: `渠道「${c.channel}」在网关路由里被关闭，请求会 503` });
      const list2 = Array.isArray(ch.models) ? ch.models : [];
      if (list2.length && c.model && !list2.includes(c.model)) {
        problems.push({ level: "warn", message: `渠道「${c.channel}」目录里没有「${c.model}」（可能写错或目录未刷新）` });
      }
    }
    for (const [ch, n] of per) if (n > 1) problems.push({ level: "warn", message: `模型「${name}」在渠道「${ch}」上声明了 ${n} 个上游模型，第二個会白避开第一个用过的号` });
  }
  for (const ch of Array.isArray(rules.free_channels) ? rules.free_channels : []) {
    if (dict && !known.has(ch)) problems.push({ level: "error", message: `free_channels 里的「${ch}」不是有效渠道 key` });
  }
  // Token 映射：左边是外部客户端在用的，右边必须是本机密钥库里真实有效的 key
  const apiKeys = rules.api_keys && typeof rules.api_keys === "object" && !Array.isArray(rules.api_keys) ? rules.api_keys : {};
  const targets = [];
  for (const [from, to] of Object.entries(apiKeys)) {
    const t = typeof to === "string" ? to.trim() : "";
    if (!t) {
      problems.push({ level: "error", message: `api_keys 里「${maskKey(from)}」的目标为空，映射后必然 401` });
      continue;
    }
    if (t === String(from).trim()) problems.push({ level: "warn", message: `api_keys 里「${maskKey(from)}」映射到自己，等于没配` });
    targets.push(t);
  }
  for (const m of verifyMappedKeys(targets)) problems.push({ level: "warn", message: m });
  if (!dict) problems.push({ level: "warn", message: `还没有 ${dictPath}：先在网关里打一条请求，或跑 channels --refresh` });
  console.log(`rules: ${rp}`);
  console.log(`dict : ${dictPath}${dict ? "" : " (缺失)"}`);
  if (!problems.length) {
    console.log("\n没有发现问题。");
    return;
  }
  for (const p of problems) console.log(`${p.level === "error" ? "ERROR" : "WARN "}  ${p.message}`);
  if (problems.some((p) => p.level === "error")) process.exit(1);
}

function cmdInit() {
  const dir = path.join(dataDir(), "agent_auto");
  const target = path.join(dir, "rules.json");
  if (fs.existsSync(target)) {
    console.log(`已存在，未覆盖：${target}`);
    return;
  }
  const template = path.join(__dirname, "AgentHub", "electron", "backend", "localgw", "agent_auto", "rules.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(template, target);
  console.log(`已生成：${target}\n按 channels.json 里的渠道 key 填 models / free_channels 即可。`);
}

function cmdChannels() {
  const dictPath = path.join(dataDir(), "agent_auto", "channels.json");
  const dict = readJson(dictPath);
  if (!dict) {
    console.error(`还没有 ${dictPath}。先启动网关并打一条请求，或执行 channels --refresh。`);
    process.exit(1);
  }
  const rows = Array.isArray(dict.channels) ? dict.channels : [];
  console.log(`渠道数 ${rows.length}，生成于 ${dict.generatedAt}，模型目录${dict.complete ? "已加载" : "未加载"}`);
  for (const c of rows) {
    const a = c.accounts || {};
    console.log(`${c.key.padEnd(24)} ${String(c.name).padEnd(20)} 号 ${a.eligible}/${a.total}  免费${a.free} 到期${a.expiring} 永久${a.permanent}  模型 ${Array.isArray(c.models) ? c.models.length : 0}`);
  }
  if (Array.isArray(dict.warnings) && dict.warnings.length) {
    console.log("\n警告：");
    for (const w of dict.warnings) console.log(`  ${w}`);
  }
}

async function rpc(base, token, cmd, args) {
  const res = await fetch(`${base.replace(/\/$/, "")}/api/rpc/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ args }),
  });
  if (!res.ok) throw new Error(`${cmd} HTTP ${res.status}`);
  return res.json();
}

async function cmdRefresh() {
  const i = process.argv.indexOf("--token");
  const token = i > 0 ? process.argv[i + 1] : process.env.AGENTHUB_ADMIN_READONLY_TOKEN || process.env.AGENTHUB_ADMIN_TOKEN;
  const b = process.argv.indexOf("--base");
  const base = b > 0 ? process.argv[b + 1] : "http://127.0.0.1:9528";
  if (!token) {
    console.error("缺少令牌：加 --token <只读令牌>，或设置 AGENTHUB_ADMIN_READONLY_TOKEN。");
    process.exit(2);
  }
  const dictPath = path.join(dataDir(), "agent_auto", "channels.json");
  const dict = readJson(dictPath);
  if (!dict || !Array.isArray(dict.channels)) {
    console.error(`还没有 ${dictPath}：先启动网关并打一条请求。`);
    process.exit(1);
  }
  let done = 0;
  let failed = 0;
  const queue = [...dict.channels];
  const worker = async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      try {
        const r = await rpc(base, token, "localgw_models_channel_models", { channel: c.key });
        const list = (r && (r.models || r.data || r.result || r)) || [];
        c.models = (Array.isArray(list) ? list : []).map((m) => String(m.realModel || m.id || m)).filter(Boolean);
        delete c.modelsHint;
        done += 1;
      } catch (e) {
        c.modelsHint = `刷新失败：${String((e && e.message) || e)}`;
        failed += 1;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  dict.complete = true;
  dict.generatedAt = new Date().toISOString();
  fs.writeFileSync(dictPath, `${JSON.stringify(dict, null, 2)}\n`);
  console.log(`刷新完成：成功 ${done}，失败 ${failed} → ${dictPath}`);
}

(async () => {
  const cmd = process.argv[2] || "check";
  if (cmd === "check") return cmdCheck();
  if (cmd === "apply") return cmdApply();
  if (cmd === "revert") return cmdRevert();
  if (cmd === "lint") return cmdLint();
  if (cmd === "init") return cmdInit();
  if (cmd === "channels") {
    if (process.argv.includes("--refresh")) return cmdRefresh();
    return cmdChannels();
  }
  console.error(`未知命令 ${cmd}。可用：check | apply | revert | lint | channels [--refresh]`);
  process.exit(2);
})();
