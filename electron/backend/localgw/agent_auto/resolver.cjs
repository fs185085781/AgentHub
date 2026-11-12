/**
 * agent_auto · 策略引擎（纯读，不写库、不调 pickAccount）
 *
 * 职责：
 *   1. 读取并热加载 rules.json（mtime+size 判定，解析失败保留上一份有效规则）
 *   2. 把「对外模型名」解析成候选 (渠道, 上游模型名) 列表
 *   3. 在候选之上做「跨渠道」的账号阶梯排序：免费 → 到期积分 → 永久积分 → 期限未知
 *   4. 给出目标号（accountId），供上层用 excludeAccounts 钉号
 *
 * 设计约束（见方案 §12）：
 *   · 不自己重写账号门禁，一律复用 pool.accountPlan() 的 eligible/reason 判定
 *   · 只做「排序」这一件事：号是不是可用，上游说了算
 *   · 所有对外函数都不抛异常，异常一律降级为空结果
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../../config.cjs");
const store = require("../../proxy/store.cjs");
const pool = require("../../proxy/pool.cjs");

const RULE_DEFAULTS = {
  models: {},
  free_channels: [],
  api_keys: {},
  ladder: ["free", "expiring", "permanent"],
  expose: "only", // only | merge
  exclusive: false,
  strictRules: true,
  sticky: { enabled: true, ttlSec: 600 },
  penalize: { coolSec: 120 },
  debug: false,
};

/** 规则文件路径：数据目录优先，回退模块目录（模块目录那份只是模板，空 models 等于不生效） */
function rulesPath() {
  try {
    const dir = path.join(config.dataDir(), "agent_auto");
    const p = path.join(dir, "rules.json");
    if (fs.existsSync(p)) return p;
  } catch { /* 数据目录不可用时走模块目录 */ }
  return path.join(__dirname, "rules.json");
}

let cache = { key: "", raw: null, rules: null };
let brokenKey = "";

function normalize(raw) {
  const out = { ...RULE_DEFAULTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)) {
    out.models = {};
    for (const [name, list] of Object.entries(raw.models)) {
      const key = String(name || "").trim();
      if (!key || !Array.isArray(list)) continue;
      out.models[key] = list
        .map((item) => ({
          channel: String((item && item.channel) || "").trim(),
          model: String((item && item.model) || "").trim(),
        }))
        .filter((item) => item.channel && item.model);
    }
  }
  out.free_channels = Array.isArray(raw.free_channels) ? raw.free_channels.map((v) => String(v).trim()).filter(Boolean) : [];
  // Token 映射：值为空或映射到自己都视为无效项丢弃（丢空值是为了避免空 token 匹配走火）。
  // 用无原型对象，防止 token 字面量恰好是 __proto__ / constructor 时触发原型链读写。
  out.api_keys = Object.create(null);
  if (raw.api_keys && typeof raw.api_keys === "object" && !Array.isArray(raw.api_keys)) {
    for (const [from, to] of Object.entries(raw.api_keys)) {
      const a = String(from == null ? "" : from).trim();
      const b = String(to == null ? "" : to).trim();
      if (!a || !b || a === b) continue;
      out.api_keys[a] = b;
    }
  }
  out.ladder = Array.isArray(raw.ladder) && raw.ladder.length ? raw.ladder.map((v) => String(v)) : RULE_DEFAULTS.ladder;
  out.expose = raw.expose === "merge" ? "merge" : "only";
  out.exclusive = raw.exclusive === true;
  out.strictRules = raw.strictRules !== false;
  if (raw.sticky && typeof raw.sticky === "object") {
    out.sticky = {
      enabled: raw.sticky.enabled !== false,
      ttlSec: Number.isFinite(Number(raw.sticky.ttlSec)) ? Math.max(0, Number(raw.sticky.ttlSec)) : 600,
    };
  }
  if (raw.penalize && typeof raw.penalize === "object") {
    out.penalize = { coolSec: Number.isFinite(Number(raw.penalize.coolSec)) ? Math.max(0, Number(raw.penalize.coolSec)) : 120 };
  }
  out.debug = raw.debug === true;
  return out;
}

/** 读取规则（带缓存）。解析失败时保留上一份有效规则，并记下 brokenKey 供 lint/日志使用 */
function loadRules() {
  const p = rulesPath();
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    cache = { key: "", raw: null, rules: null };
    return { rules: null, path: p, ready: false, broken: false };
  }
  const key = `${p}|${st.mtimeMs}|${st.size}`;
  if (key === cache.key) {
    return { rules: cache.rules, path: p, ready: !!cache.rules, broken: brokenKey === key };
  }
  try {
    // 去 BOM：Windows 记事本/PowerShell 另存的 UTF-8 会带 BOM，JSON.parse 会直接抛
    const raw = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    cache = { key, raw, rules: normalize(raw) };
    brokenKey = "";
  } catch (e) {
    // 热加载撞上半截文件时不要静默回原生：保留上一份有效规则，只标记 broken
    brokenKey = key;
    cache = { key, raw: cache.raw, rules: cache.rules };
    return { rules: cache.rules, path: p, ready: !!cache.rules, broken: true, error: String((e && e.message) || e) };
  }
  return { rules: cache.rules, path: p, ready: true, broken: false };
}

/** 对外名查找：精确优先，回落大小写不敏感（客户端大小写随意） */
function modelSpec(rules, model) {
  if (!rules || !rules.models) return null;
  const name = String(model || "").trim();
  if (!name) return null;
  if (rules.models[name]) return { name, list: rules.models[name] };
  const lower = name.toLowerCase();
  for (const [key, list] of Object.entries(rules.models)) {
    if (key.toLowerCase() === lower) return { name: key, list };
  }
  return null;
}

/** 逐包派生四档额度（有效包才计）：
 *   unlimited = 任一有效包 remaining === -1
 *   timed     = 未过期且 expiresAt > 0 的剩余之和
 *   perm      = 未过期且 expiresAt === 0 的剩余之和
 *   soonest   = 未过期、还有余量、带到期时间的包里最早的那个到期时刻
 * 注意：这里**不能**用派生后的 account.credits/expiresAt —— 那是把所有包塌缩成一个数，
 * 到期积分与永久积分的分界在派生后就丢了（pool.deriveAccountCredits）。 */
function creditStats(packages, now) {
  const out = { unlimited: false, timed: 0, perm: 0, soonest: Infinity };
  for (const p of packages || []) {
    const remaining = Number(p && p.remaining);
    const expiresAt = Number(p && p.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt <= now) continue; // 已过期
    if (remaining === -1) {
      out.unlimited = true;
      continue;
    }
    if (!(remaining > 0)) continue;
    if (expiresAt > 0) {
      out.timed += remaining;
      if (expiresAt < out.soonest) out.soonest = expiresAt;
    } else {
      out.perm += remaining;
    }
  }
  return out;
}

/** 单号档位：免费渠道整渠道按免费；否则按积分包形态分档 */
function rankOf(stats, isFreeChannel, ladder) {
  const order = Array.isArray(ladder) && ladder.length ? ladder : RULE_DEFAULTS.ladder;
  if (isFreeChannel) return { kind: "free", rank: order.indexOf("free") };
  // 到期积分优先于永久积分：同一个号两种都有时，先把会过期的花掉
  if (stats.timed > 0) return { kind: "expiring", rank: order.indexOf("expiring") };
  if (stats.unlimited || stats.perm > 0) return { kind: "permanent", rank: order.indexOf("permanent") };
  return { kind: "unknown", rank: order.length };
}

function rankIdx(order, kind) {
  const i = order.indexOf(kind);
  return i < 0 ? order.length : i;
}

/** 单渠道的可用号列表（已按「档位 + 快过期先榨 + 余额少先榨 + 并发少 + 最久未用」排序）
 *  @returns {{rows: Array, packages: Map, isFree: boolean}} */
function planChannel(channel, realModel, rules, now) {
  const isFree = rules.free_channels.includes(channel);
  let rows;
  try {
    rows = pool.accountPlan(channel, undefined, [], 0, realModel);
  } catch {
    return { rows: [], packages: new Map(), isFree };
  }
  let packages = new Map();
  try {
    packages = store.listAllCreditPackages(channel) || new Map();
  } catch { /* 无包时按 0 处理 */ }
  const enriched = rows.map((row) => {
    const stats = creditStats(packages.get(row.account.id), now);
    const tier = rankOf(stats, isFree, rules.ladder);
    return { ...row, stats, tier: tier.kind, rank: tier.rank };
  });
  enriched.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return (a.rank - b.rank)
      || (Number(b.stats.unlimited) - Number(a.stats.unlimited))   // 无限额度优先
      || (a.stats.soonest - b.stats.soonest)                        // 快过期的先榨
      || (credits(a) - credits(b))                                  // 同档余额少的先榨
      || (a.inFlight - b.inFlight)
      || ((a.account.lastUsed || 0) - (b.account.lastUsed || 0))
      || String(a.account.id).localeCompare(String(b.account.id));
  });
  return { rows: enriched, packages, isFree };
}

/** 可比较的余额：无限 = Infinity（配合 unlimited 标志，仅在两者都无限时参与比较） */
function credits(row) {
  const c = Number(row.account.credits);
  if (c === -1) return Infinity;
  return Number.isFinite(c) ? c : 0;
}

// ===== 进程内状态：粘性会话 + 本地惩罚 =====
const sticky = new Map();   // key → { channel, realModel, accountId, at }
const penalty = new Map();  // accountId → until

function penaltyAlive(accountId, now) {
  const until = penalty.get(accountId) || 0;
  if (until <= now) {
    penalty.delete(accountId);
    return false;
  }
  return true;
}

function notePenalty(accountId, rules, now) {
  const sec = Math.max(0, Number(rules.penalize.coolSec) || 0);
  if (!accountId || !sec) return;
  penalty.set(accountId, now + sec * 1000);
}

/** 在候选集里挑目标：{channel, realModel, accountId, tier, ...} 或 null
 *  @param {{excluded?:Set<string>, tried?:Set<string>, bindings?:Array, now?:number}} ctx */
function choose(rules, model, ctx = {}) {
  const spec = modelSpec(rules, model);
  if (!spec) return null;
  const excluded = ctx.excluded || new Set();
  const tried = ctx.tried || new Set();
  const declared = Array.isArray(ctx.bindings) ? ctx.bindings : null;
  const now = ctx.now || Date.now();
  const isFree = (ch) => rules.free_channels.includes(ch);

  let routing;
  try {
    routing = require("../routing.cjs");
  } catch {
    return null;
  }

  const picks = [];
  for (const cand of spec.list) {
    if (excluded.has(cand.channel)) continue;
    // 与 routing.candidates() 同一道门：渠道被关掉时 pick 不会发入场券（方案 §12-F1）
    try {
      if (typeof routing.isChannelEnabled === "function" && !routing.isChannelEnabled(cand.channel)) continue;
    } catch { /* 配置未就绪时不阻塞 */ }
    // 声明的行里必须真的有这个 (渠道, 上游模型)，否则改写后下游找不到 serviceRef
    if (declared && !declared.some((m) => m.channel === cand.channel && m.realModel === cand.model)) continue;

    const planned = planChannel(cand.channel, cand.model, rules, now);
    const row = planned.rows.find((r) => r.eligible && !tried.has(r.account.id) && !penaltyAlive(r.account.id, now));
    if (!row) continue;
    picks.push({
      channel: cand.channel,
      realModel: cand.model,
      accountId: row.account.id,
      // 该渠道当前所有可用号：上层拿它做「除目标号外全部排除」的钉号
      eligibleIds: planned.rows.filter((r) => r.eligible).map((r) => r.account.id),
      tier: row.tier,
      rank: row.rank,
      unlimited: row.stats.unlimited,
      soonest: row.stats.soonest,
      credits: credits(row),
      inFlight: row.inFlight,
      lastUsed: row.account.lastUsed || 0,
      reason: row.reason,
      isFree: planned.isFree,
    });
  }
  if (!picks.length) return null;

  picks.sort((a, b) => (a.rank - b.rank)
    || (Number(b.unlimited) - Number(a.unlimited))
    || (a.soonest - b.soonest)
    || (a.credits - b.credits)
    || (a.inFlight - b.inFlight)
    || (a.lastUsed - b.lastUsed)
    || a.channel.localeCompare(b.channel));

  const best = picks[0];
  // 粘性只做「同档内的 tie-break」：不因为上次用过就放弃更便宜的档位
  const key = String(model || "");
  if (rules.sticky && rules.sticky.enabled) {
    const hit = sticky.get(key);
    const ttl = Math.max(0, Number(rules.sticky.ttlSec) || 0) * 1000;
    if (hit && now - hit.at <= ttl) {
      const same = picks.find((p) => p.channel === hit.channel && p.accountId === hit.accountId);
      // 同档 + 不比当前最优更忙才粘：否则并发会被全压到同一个号上，表现为"越用越慢"
      if (same && same.rank === best.rank && (same.inFlight || 0) <= (best.inFlight || 0)) {
        sticky.set(key, { ...hit, at: now });
        return same;
      }
    }
  }
  return best;
}

/** 记录本次选择（粘性账本）。失败不抛。 */
function remember(rules, model, pick, now) {
  if (!pick || !rules.sticky || !rules.sticky.enabled) return;
  sticky.set(String(model || ""), { channel: pick.channel, realModel: pick.realModel, accountId: pick.accountId, at: now || Date.now() });
}

/** 上游判定某号已不可用时，本地也压一段时间，避免它刚复活又被粘回去 */
function penalizeUnavailable(rules, accountId, now) {
  notePenalty(accountId, rules, now || Date.now());
}

module.exports = {
  RULE_DEFAULTS,
  rulesPath,
  loadRules,
  normalize,
  modelSpec,
  creditStats,
  planChannel,
  choose,
  remember,
  penalizeUnavailable,
  sticky,
  penalty,
};
