/**
 * agent_auto · 注入入口
 *
 * 三个对外函数对应 server.cjs 的三处注入点（第④处与第③处同形）：
 *   declare(model, native, ctx)  → 第①行：对外模型名 → 候选 (渠道, 上游模型)
 *   apply(binding, ctx)          → 第②行：逐次尝试改写 binding + 钉号
 *   list(snapshot)               → 第③/④行：/v1/models 只暴露 rules.json 里的名字
 *   translateKey(raw)            → 第⑤行：验权前把外部旧 Token 换成真 Token
 *
 * 铁律：任何异常都必须降级为「不做任何事」，绝不能把网关搞挂。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../../config.cjs");
const store = require("../../proxy/store.cjs");
const resolver = require("./resolver.cjs");

const BUDGET_FALLBACK = 3;

function lgwConfig() {
  try { return require("../config.cjs"); } catch { return null; }
}

/** 取当前路由重试预算：declared 超过预算的部分永远试不到（方案 §12-A4） */
function retryBudget() {
  try {
    const c = lgwConfig();
    const v = c && c.get ? c.get() : null;
    const raw = v && v.routing ? v.routing.maxRetriesPerRequest : null;
    return Math.max(1, Math.min(10, Math.floor(Number(raw) || BUDGET_FALLBACK)));
  } catch {
    return BUDGET_FALLBACK;
  }
}

function proxyConfig() {
  try {
    const c = config.loadConfig();
    return (c && c.proxy) || {};
  } catch {
    return {};
  }
}

function isDisabledName(name) {
  const list = proxyConfig().disabledModels || [];
  const lower = String(name || "").toLowerCase();
  return list.some((m) => String(m).toLowerCase() === lower);
}

function metaOf(realModel, channel, snapshot) {
  try {
    if (!snapshot || !snapshot.catalog || typeof snapshot.catalog.modelMetadata !== "function") return {};
    return snapshot.catalog.modelMetadata(realModel, channel) || {};
  } catch {
    return {};
  }
}

function warn(message) {
  try {
    console.warn(`[agent_auto] ${message}`);
  } catch { /* 日志失败不影响转发 */ }
}

// ===== 决策日志（默认关闭，rules.debug=true 时写本地 JSONL） =====

function logPath() {
  try {
    return path.join(config.dataDir(), "agent_auto", "decisions.jsonl");
  } catch {
    return "";
  }
}

let logWarned = false;

function decisionLog(rules, payload) {
  if (!rules || !rules.debug) return;
  const p = logPath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try {
      if (fs.statSync(p).size > 2 * 1024 * 1024) fs.renameSync(p, `${p}.1`);
    } catch { /* 文件不存在或轮转失败都继续写 */ }
    fs.appendFileSync(p, `${JSON.stringify({ ts: Date.now(), ...payload })}\n`);
  } catch (e) {
    if (!logWarned) {
      logWarned = true;
      warn(`决策日志写入失败：${String((e && e.message) || e)}`);
    }
  }
}

// ===== 渠道字典 channels.json =====

let dictState = { fingerprint: "", at: 0, summary: null };
let dictBuilding = false;

function dictPath() {
  try {
    return path.join(config.dataDir(), "agent_auto", "channels.json");
  } catch {
    return "";
  }
}

function agentRows() {
  try {
    return store.listAgents() || [];
  } catch {
    return [];
  }
}

function channelFingerprint(rows) {
  return rows.map((a) => `${a.id}:${a.enabled ? 1 : 0}`).join(",");
}

function channelNameMap() {
  const out = new Map();
  try {
    for (const c of store.channelList() || []) out.set(c.id, c.display || c.id);
  } catch { /* 名字取不到就用 key */ }
  return out;
}

/** 生成「渠道 key + 中文名 + 该渠道原生模型 + 账号档位统计」的说明书。
 *  只是给填 rules.json 用的元信息，resolver 从不依赖它。
 *  只在网关启动时生成一次（server.cjs 的 doStart 钩子），请求路径不再触发。 */
function ensureDict(snapshot) {
  const now = Date.now();
  if (dictBuilding) return dictState.summary;
  const rows = agentRows();
  const fingerprint = channelFingerprint(rows);
  dictBuilding = true;
  try {
    const { rules } = resolver.loadRules();
    const effective = rules || resolver.RULE_DEFAULTS;
    const names = channelNameMap();
    const modelsMod = safeModels();
    const channels = [];
    const warnings = [];
    const freeTier = [];
    const referenced = new Set(effective.free_channels);
    for (const list of Object.values(effective.models || {})) {
      for (const c of list) referenced.add(c.channel);
    }
    // 启动这次没有模型目录（snapshot 为空），不能把上次 channels --refresh 填好的清单抹空
    const prevModels = (() => {
      try {
        const p = dictPath();
        if (!p || !fs.existsSync(p)) return new Map();
        const prev = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
        return new Map((prev.channels || [])
          .filter((c) => Array.isArray(c.models) && c.models.length)
          .map((c) => [c.key, c.models]));
      } catch {
        return new Map();
      }
    })();
    for (const row of rows) {
      const id = String(row.id || "");
      if (!id) continue;
      const planned = resolver.planChannel(id, "", effective, now);
      const counts = { total: planned.rows.length, eligible: 0, free: 0, expiring: 0, permanent: 0, unknown: 0 };
      for (const r of planned.rows) {
        if (!r.eligible) continue;
        counts.eligible += 1;
        if (r.tier === "free") counts.free += 1;
        else if (r.tier === "expiring") counts.expiring += 1;
        else if (r.tier === "permanent") counts.permanent += 1;
        else counts.unknown += 1;
      }
      let models = [];
      let modelsHint = "";
      if (!snapshot) {
        models = prevModels.get(id) || [];
        if (!models.length) modelsHint = "尚未加载模型目录：运行 install-bridge.cjs channels --refresh 补全";
      } else if (modelsMod && typeof modelsMod.channelModelList === "function") {
        try {
          models = (modelsMod.channelModelList(id, snapshot) || []).map((m) => String(m.realModel || m.id)).filter(Boolean);
        } catch {
          modelsHint = "模型目录读取失败";
        }
      }
      if (row.enabled && counts.total === 0 && referenced.has(id)) warnings.push(`渠道 ${id} 没有账号，规则里引用它不会命中`);
      channels.push({
        key: id,
        name: names.get(id) || row.display || id,
        domain: row.domain || "",
        kind: row.kind || "",
        enabled: !!row.enabled,
        routingEnabled: routingEnabled(id),
        costTier: row.costTier || "",
        poolStrategy: row.poolStrategy || "",
        freeChannel: effective.free_channels.includes(id),
        accounts: counts,
        models,
        ...(modelsHint ? { modelsHint } : {}),
      });
      if (effective.free_channels.includes(id)) freeTier.push(id);
    }
    const summary = {
      generatedAt: new Date(now).toISOString(),
      complete: channels.length > 0 && channels.every((c) => c.models && c.models.length > 0),
      rulesPath: resolver.rulesPath(),
      rulesReady: !!rules,
      channelCount: channels.length,
      freeChannelList: freeTier,
      channels,
      warnings,
    };
    const p = dictPath();
    if (p) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = `${p}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`);
        fs.renameSync(tmp, p);
      } catch (e) {
        warn(`渠道字典写入失败：${String((e && e.message) || e)}`);
      }
    }
    dictState = { fingerprint, at: now, summary };
    return summary;
  } catch (e) {
    warn(`渠道字典生成失败：${String((e && e.message) || e)}`);
    return dictState.summary;
  } finally {
    dictBuilding = false;
  }
}

/** 延迟生成：字典只是给人看的说明书，绝不占用请求线程。
 *  同一 tick 内多次调用只排一次，后到的 snapshot 覆盖先到的（保证带模型目录的版本优先）。 */
let pendingDict = null;
let pendingScheduled = false;

function ensureDictLater(snapshot) {
  pendingDict = snapshot || null;
  if (pendingScheduled) return;
  pendingScheduled = true;
  setImmediate(() => {
    pendingScheduled = false;
    const s = pendingDict;
    pendingDict = null;
    try { ensureDict(s); } catch (e) { warn(`渠道字典生成失败：${String((e && e.message) || e)}`); }
  });
}

function routingEnabled(channel) {
  try {
    const r = require("../routing.cjs");
    return typeof r.isChannelEnabled === "function" ? !!r.isChannelEnabled(channel) : true;
  } catch {
    return true;
  }
}

function safeModels() {
  try {
    return require("../models.cjs");
  } catch {
    return null;
  }
}

// ===== 第①行：对外模型名 → 候选绑定 =====

function declare(model, native, ctx = {}) {
  const nativeRows = Array.isArray(native) ? native : [];
  try {
    const { rules, ready, broken } = resolver.loadRules();
    if (!ready) return nativeRows;
    if (broken) warn(`rules.json 解析失败，已沿用上一份有效规则（${resolver.rulesPath()}）`);

    const spec = resolver.modelSpec(rules, model);
    if (!spec) return rules.exclusive ? [] : nativeRows;

    // 与原生同口径：停用的对外名直接按「模型不存在」处理（方案 §12-F5）
    if (isDisabledName(model)) return [];

    // 同名模型组存在时让上游接管：组是更强的显式声明，不抢
    const modelsMod = safeModels();
    if (modelsMod && typeof modelsMod.groupSpec === "function" && modelsMod.groupSpec(model, ctx.snapshot)) return nativeRows;

    const allowed = ctx.allowed || null;
    const enabled = spec.list.filter((c) => routingEnabled(c.channel) && (!allowed || allowed.has(c.channel)));
    const budget = retryBudget();
    const picked = enabled.slice(0, budget);
    if (enabled.length > picked.length) {
      warn(`规则「${model}」有 ${enabled.length} 个候选，超过重试预算 ${budget}，只声明前 ${picked.length} 个`);
    }
    if (!picked.length) return [];

    const rows = picked.map((c) => ({
      id: model,
      display: model,
      channel: c.channel,
      realModel: c.model,
      source: "agent_auto",
      ...metaOf(c.model, c.channel, ctx.snapshot),
    }));
    return rows;
  } catch (e) {
    warn(`declare 降级为原生行为：${String((e && e.message) || e)}`);
    return nativeRows;
  }
}

// ===== 第②行：逐次尝试改写 binding + 钉号 =====

function unionTried(triedAccounts) {
  const out = new Set();
  try {
    if (triedAccounts && typeof triedAccounts.forEach === "function") {
      for (const set of triedAccounts.values()) {
        if (set && typeof set.forEach === "function") set.forEach((id) => out.add(id));
      }
    }
  } catch { /* 结构异常时按空集合处理 */ }
  return out;
}

function apply(binding, ctx = {}) {
  try {
    if (!binding || binding.source !== "agent_auto") return null;
    const { rules, ready } = resolver.loadRules();
    if (!ready) return null;

    const triedAccounts = ctx.triedAccounts;
    const tried = unionTried(triedAccounts);
    const t0 = process.hrtime.bigint();
    const pick = resolver.choose(rules, ctx.model, {
      excluded: ctx.excluded,
      tried,
      bindings: ctx.bindings,
    });
    const chooseMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!pick) return null;

    const row = (ctx.bindings || []).find((m) => m.channel === pick.channel && m.realModel === pick.realModel);
    if (!row) {
      // 声明的行里没有这个组合：判死该渠道，交给下一轮
      try { ctx.excluded && ctx.excluded.add(pick.channel); } catch { /* 忽略 */ }
      return null;
    }

    // 钉号：把该渠道除目标号以外的可用号全部塞进 triedAccounts，
    // 转发器会把它们变成 excludeAccounts，执行器只能落到目标号上。
    if (triedAccounts && typeof triedAccounts.set === "function") {
      const set = triedAccounts.get(pick.channel) || new Set();
      for (const id of pick.eligibleIds || []) {
        if (id !== pick.accountId) set.add(id);
      }
      triedAccounts.set(pick.channel, set);
    }
    resolver.remember(rules, ctx.model, pick, Date.now());
    decisionLog(rules, {
      model: ctx.model,
      attempt: ctx.attempt || 0,
      channel: pick.channel,
      realModel: pick.realModel,
      accountId: pick.accountId,
      tier: pick.tier,
      rank: pick.rank,
      chooseMs: Math.round(chooseMs * 100) / 100,
      candidates: (ctx.bindings || []).map((m) => `${m.channel}/${m.realModel}`),
    });
    // 必须返回新对象：binding 是 bindings 数组里的元素引用，原地改会污染候选数组
    return { ...row };
  } catch (e) {
    warn(`apply 降级为不接管：${String((e && e.message) || e)}`);
    return null;
  }
}

// ===== 第⑤行：外部旧 Token → 本机真实 Token（验权前替换） =====

/** 命中 api_keys 就换成真 Token，否则原样返回。
 *  位置在 keysStore.authenticate 之前，所以外部客户端继续用老 key 即可，
 *  本机密钥库里只需要存在映射右边的那个真 key。 */
function translateKey(raw) {
  const input = String(raw == null ? "" : raw);
  if (!input) return input;
  try {
    const { rules, ready } = resolver.loadRules();
    if (!ready || !rules) return input;
    const map = rules.api_keys;
    if (!map || !Object.prototype.hasOwnProperty.call(map, input)) return input;
    const target = map[input];
    return typeof target === "string" && target ? target : input;
  } catch {
    return input;
  }
}

// ===== 第③/④行：/v1/models 只暴露 rules.json 里的名字 =====

function list(snapshot) {
  let native = [];
  const modelsMod = safeModels();
  try {
    native = modelsMod && typeof modelsMod.list === "function" ? modelsMod.list(snapshot) : [];
  } catch {
    native = [];
  }
  try {
    const { rules, ready } = resolver.loadRules();
    if (!ready) return native;
    const names = Object.keys(rules.models);
    if (!names.length) return native;
    const rows = [];
    for (const [name, candidates] of Object.entries(rules.models)) {
      if (isDisabledName(name)) continue;
      for (const c of candidates) {
        if (!routingEnabled(c.channel)) continue;
        rows.push({ id: name, display: name, channel: c.channel, realModel: c.model, source: "agent_auto" });
      }
    }
    return rules.expose === "merge" ? [...native, ...rows] : rows;
  } catch (e) {
    warn(`list 降级为原生行为：${String((e && e.message) || e)}`);
    return native;
  }
}

// ===== 诊断 =====

/** lint：拿 channels.json 对照 rules.json，返回可读的问题列表 */
function lint() {
  const { rules, path: rp, ready, broken } = resolver.loadRules();
  const out = [];
  if (!ready) return { ok: false, rulesPath: rp, problems: [{ level: "error", message: "rules.json 不存在或不可解析" }] };
  if (broken) out.push({ level: "warn", message: "rules.json 当前解析失败，正在沿用上一份有效规则" });
  let dict = null;
  try {
    const p = dictPath();
    if (p && fs.existsSync(p)) dict = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { /* 字典读不到就只做结构校验 */ }
  const known = new Map();
  if (dict && Array.isArray(dict.channels)) for (const c of dict.channels) known.set(c.key, c);
  const budget = retryBudget();

  for (const [name, list] of Object.entries(rules.models)) {
    if (isDisabledName(name)) out.push({ level: "warn", message: `模型「${name}」已被 proxy.disabledModels 停用，规则不会生效` });
    if (list.length > budget) out.push({ level: "warn", message: `模型「${name}」有 ${list.length} 个候选，超过重试预算 ${budget}，多出的永远不会被尝试` });
    const perChannel = new Map();
    for (const c of list) {
      perChannel.set(c.channel, (perChannel.get(c.channel) || 0) + 1);
      const ch = known.get(c.channel);
      if (!ch) {
        out.push({ level: "error", message: `模型「${name}」引用了不存在的渠道「${c.channel}」` });
        continue;
      }
      if (!ch.enabled) out.push({ level: "warn", message: `渠道「${c.channel}」已停用，候选永远不会命中` });
      if (!ch.routingEnabled) out.push({ level: "warn", message: `渠道「${c.channel}」在网关路由里被关闭，pick 不会发入场券（请求会 503）` });
      if (Array.isArray(ch.models) && ch.models.length && !ch.models.includes(c.model)) {
        out.push({ level: "warn", message: `渠道「${c.channel}」的目录里没有「${c.model}」，可能是名字写错或目录未刷新` });
      }
    }
    for (const [channel, n] of perChannel) {
      if (n > 1) out.push({ level: "warn", message: `模型「${name}」在渠道「${channel}」上声明了 ${n} 个上游模型；普通模式下账号排重键是渠道级，第二个模型会白避开第一个用过的号` });
    }
  }
  for (const ch of rules.free_channels) {
    if (!known.has(ch)) out.push({ level: "error", message: `free_channels 里的「${ch}」不是有效渠道 key` });
  }
  return { ok: !out.some((p) => p.level === "error"), rulesPath: rp, dictPath: dictPath(), problems: out };
}

function status() {
  const { rules, path: rp, ready, broken } = resolver.loadRules();
  return {
    rulesPath: rp,
    rulesReady: ready,
    rulesBroken: broken,
    dictPath: dictPath(),
    dict: dictState.summary ? { generatedAt: dictState.summary.generatedAt, channelCount: dictState.summary.channelCount, complete: dictState.summary.complete } : null,
    models: rules ? Object.keys(rules.models).length : 0,
    apiKeys: rules ? Object.keys(rules.api_keys || {}).length : 0,
    retryBudget: retryBudget(),
  };
}

function reload() {
  resolver.loadRules();
  ensureDict(null);
  return status();
}


module.exports = {
  declare,
  apply,
  list,
  translateKey,
  lint,
  status,
  reload,
  ensureDict,
  ensureDictLater,
  // 供安装器/脚本使用
  rulesPath: resolver.rulesPath,
};
