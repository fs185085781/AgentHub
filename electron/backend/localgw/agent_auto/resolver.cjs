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
  cacheMs: 500,
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
  out.cacheMs = Number.isFinite(Number(raw.cacheMs)) ? Math.max(0, Math.min(5000, Number(raw.cacheMs))) : 500;
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
 *  nativeRank 保留上游 accountPlan 的原始顺序：改写 binding 时只要把「上游排在目标号前面」
 *  的那些号排除掉，就能钉住目标号，同时不牺牲同渠道内后续的换号重试。
 *  结果带 TTL 缓存（rules.cacheMs，默认 500ms）：同一请求的重试、并发请求共享一次扫描。
 *  @returns {{rows: Array, packages: Map, isFree: boolean}} */
const planCache = new Map();

function planChannel(channel, realModel, rules, now) {
  const ttl = Number(rules && rules.cacheMs);
  const cacheMs = Number.isFinite(ttl) && ttl > 0 ? Math.min(5000, ttl) : 0;
  const key = `${channel}\u0000${realModel}`;
  if (cacheMs) {
    const hit = planCache.get(key);
    if (hit && now - hit.at <= cacheMs) return hit.value;
  }
  const value = buildPlan(channel, realModel, rules, now);
  if (cacheMs) {
    if (planCache.size > 256) {
      for (const [k, v] of planCache) if (now - v.at > cacheMs) planCache.delete(k);
    }
    planCache.set(key, { at: now, value });
  }
  return value;
}

function buildPlan(channel, realModel, rules, now) {
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
  const enriched = rows.map((row, index) => {
    const stats = creditStats(packages.get(row.account.id), now);
    const tier = rankOf(stats, isFree, rules.ladder);
    return { ...row, stats, tier: tier.kind, rank: tier.rank, nativeRank: index };
  });
  enriched.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return (a.rank - b.rank)
      || (Number(b.stats.unlimited) - Number(a.stats.unlimited))   // 无限额度优先
      || (a.stats.soonest - b.stats.soonest)                        // 快过期的先榨
      || (credits(a) - credits(b))                                  // 同档余额少的先榨
      || (a.inFlight - b.inFlight)
      || ((a.account.lastUsed || 0) - (b.account.lastUsed || 0))
      || String(a.account.id).localeCompare(String(b.account.id))
      || (a.nativeRank - b.nativeRank);
  });
  return { rows: enriched, packages, isFree };
}

/** 可比较的余额：无限 = Infinity（配合 unlimited 标志，仅在两者都无限时参与比较） */
function credits(row) {
  const c = Number(row.account.credits);
  if (c === -1) return Infinity;
  return Number.isFinite(c) ? c : 0;
}

// ===== 进程内状态：上次选号结果 + 本地惩罚 =====
// sticky 记录「某个外部模型上一次选中的 (渠道, 上游模型, 账号)」：
// 下次同一个外部模型进来时直接复用，不再做跨渠道排序；只有它不可用了（失败被冷却/下线/换映射）才重排。
const sticky = new Map();   // model → { channel, realModel, accountId, at }
const penalty = new Map();  // accountId → until

const EMPTY_SET = new Set();

function penaltyAlive(accountId, now) {
  const until = penalty.get(accountId) || 0;
  if (until <= now) {
    penalty.delete(accountId);
    return false;
  }
  return true;
}

function notePenalty(accountId, rules, now) {
  const sec = Math.max(0, Number(rules && rules.penalize && rules.penalize.coolSec) || 0);
  if (!accountId || !sec) return;
  penalty.set(accountId, now + sec * 1000);
}

function channelEnabled(channel) {
  try {
    const routing = require("../routing.cjs");
    return typeof routing.isChannelEnabled === "function" ? !!routing.isChannelEnabled(channel) : true;
  } catch {
    return true;
  }
}

/** 上游模型目录的账号级排除（executor 会把它们并进 excludeAccounts）。
 *  选号时必须同口径过滤：否则会钉到一个「该号没声明支持这个模型」的号上，
 *  再把别的号全排除 ⇒ 执行器一个号都选不到，报 503「渠道当前无可用账号」。 */
function catalogExclusions(ctx, channel, realModel) {
  try {
    const catalog = ctx && ctx.catalog;
    if (!catalog || typeof catalog.excludedAccounts !== "function") return EMPTY_SET;
    const ids = catalog.excludedAccounts(channel, realModel);
    return Array.isArray(ids) && ids.length ? new Set(ids) : EMPTY_SET;
  } catch {
    return EMPTY_SET;
  }
}

function makePick(channel, realModel, plan, row, skip) {
  // 只排除「上游排在目标号前面」的号：既能把执行器逼到目标号，又保留同渠道内后续换号重试的机会。
  // pinExcludes 为空 ⇔ 目标号本来就是上游的首选，此时完全不用钉号，原生换号逻辑原样保留。
  const pinExcludes = plan.rows
    .filter((r) => r.eligible && !skip.has(r.account.id) && r.nativeRank < row.nativeRank)
    .map((r) => r.account.id);
  return {
    channel,
    realModel,
    accountId: row.account.id,
    pinExcludes,
    tier: row.tier,
    rank: row.rank,
    unlimited: row.stats.unlimited,
    soonest: row.stats.soonest,
    credits: credits(row),
    inFlight: row.inFlight,
    lastUsed: row.account.lastUsed || 0,
    reason: row.reason,
    isFree: plan.isFree,
  };
}

/** 复用上次选中的号：只校验这一个渠道的这一个号现在还活着，不重排。
 *  @returns {object|null} 可直接使用的 pick；返回 null 表示上次的号已不可用 */
function reuseLastPick(rules, key, spec, ctx, now) {
  const hit = sticky.get(key);
  if (!hit) return null;
  const ttl = Math.max(0, Number(rules.sticky && rules.sticky.ttlSec) || 0) * 1000;
  if (ttl > 0 && now - hit.at > ttl) return null;

  const excluded = ctx.excluded || EMPTY_SET;
  const tried = ctx.tried || EMPTY_SET;
  if (excluded.has(hit.channel) || tried.has(hit.accountId) || penaltyAlive(hit.accountId, now)) return null;
  if (!channelEnabled(hit.channel)) return null;
  if (!spec.list.some((c) => c.channel === hit.channel && c.model === hit.realModel)) return null;
  const declared = Array.isArray(ctx.bindings) ? ctx.bindings : null;
  if (declared && !declared.some((m) => m.channel === hit.channel && m.realModel === hit.realModel)) return null;

  const skip = catalogExclusions(ctx, hit.channel, hit.realModel);
  if (skip.has(hit.accountId)) return null;
  const plan = planChannel(hit.channel, hit.realModel, rules, now);
  const row = plan.rows.find((r) => r.account.id === hit.accountId);
  if (!row || !row.eligible) return null;
  return makePick(hit.channel, hit.realModel, plan, row, skip);
}

/** 在候选集里挑目标：{channel, realModel, accountId, tier, pinExcludes, ...} 或 null
 *  @param {{excluded?:Set<string>, tried?:Set<string>, bindings?:Array, catalog?:object, now?:number}} ctx */
function choose(rules, model, ctx = {}) {
  const spec = modelSpec(rules, model);
  if (!spec) return null;
  const excluded = ctx.excluded || EMPTY_SET;
  const tried = ctx.tried || EMPTY_SET;
  const declared = Array.isArray(ctx.bindings) ? ctx.bindings : null;
  const now = ctx.now || Date.now();
  const key = String(model || "");

  // 1) 上次选好的号还能用：直接返回，跳过跨渠道排序
  if (rules.sticky && rules.sticky.enabled) {
    const last = reuseLastPick(rules, key, spec, ctx, now);
    if (last) {
      sticky.set(key, { channel: last.channel, realModel: last.realModel, accountId: last.accountId, at: now });
      return last;
    }
    sticky.delete(key); // 上次的号失败/不可用：本次重排
  }

  // 2) 跨渠道全量排序：候选渠道的可用号全部摆出来，按档位 / 到期 / 余额 / 并发 / 最久未用排序
  const picks = [];
  for (const cand of spec.list) {
    if (excluded.has(cand.channel)) continue;
    // 与 routing.candidates() 同一道门：渠道被关掉时 pick 不会发入场券（方案 §12-F1）
    if (!channelEnabled(cand.channel)) continue;
    // 声明的行里必须真的有这个 (渠道, 上游模型)，否则改写后下游找不到 serviceRef
    if (declared && !declared.some((m) => m.channel === cand.channel && m.realModel === cand.model)) continue;

    const skip = catalogExclusions(ctx, cand.channel, cand.model);
    const planned = planChannel(cand.channel, cand.model, rules, now);
    const row = planned.rows.find((r) => r.eligible && !tried.has(r.account.id)
      && !penaltyAlive(r.account.id, now) && !skip.has(r.account.id));
    if (!row) continue;
    picks.push(makePick(cand.channel, cand.model, planned, row, skip));
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
  if (rules.sticky && rules.sticky.enabled) {
    sticky.set(key, { channel: best.channel, realModel: best.realModel, accountId: best.accountId, at: now });
  }
  return best;
}

/** 上游判定某号已不可用时，本地也压一段时间，避免它刚复活又被粘回去 */
function penalizeUnavailable(rules, accountId, now) {
  notePenalty(accountId, rules, now || Date.now());
}

/** 清除某个外部模型的选号缓存：下一次请求必定重新跨渠道排序 */
function invalidate(model) {
  sticky.delete(String(model || ""));
  return true;
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
  invalidate,
  penalizeUnavailable,
  sticky,
  penalty,
};
