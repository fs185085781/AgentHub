# agent_auto 桥接方案（评审稿 v1）

> 状态：**待评审，未落任何代码**。本文档是唯一的产出物。
> 目标仓库：`AgentHub` v1.1.2（AGPL-3.0，Electron + 无头 gateway 双形态）
> 运行形态：`node gateway/src/index.cjs`（本地网关 :9527 / 管理 :9528）

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 可行性 | **可行**。不需要独立服务、不需要 HTTP 桥接、不需要新语言/新运行时。 |
| 改动面 | AgentHub 源码 **改 2 行 + 增 1 行**（第 4 行按需），全部集中在 `electron/backend/localgw/server.cjs` 一个文件。 |
| 新增文件 | 全部落在 `localgw/agent_auto/` 新目录 + 仓库外一个补丁器，**均为 git 未跟踪**，`git checkout .` 即可完全回滚。 |
| 配置体验 | 启动自动生成 `channels.json`：渠道 key + 中文展示名 + 该渠道真实模型清单 + 账号档位统计，解决「rules.json 里到底该填什么」。**不新增注入行**。详见 §6.4。 |
| 需求满足 | 自定义模型名（对外 `abc`）、跨渠道候选、按积分阶梯（免费→到期→永久）选号、钉到具体账号、`/v1/models` 只暴露自定义名。 |
| 不满足 | **「同一号内先扣限时包还是永久包」由上游决定**，本方案只能决定「用哪个号」。见 §7.1。 |
| 最大风险 | 上游重构 `handleCompletion` 导致**锚点在但语义已变**（补丁器抓不到，只有行为测试能抓）。见 §8 R1。 |

原需求里「独立 agent_auto 服务 + GET 请求桥接」的形态已被否决：它解决不了并发实时性，且引入部署与跨进程一致性问题。详见 §9。

---

## 1. 现状与根因

### 1.1 转发链路（三协议单点汇聚）

`/v1/chat/completions`、`/v1/messages`、`/v1/responses` 三个入口全部汇聚到同一个 `handleCompletion`（`server.cjs` L316 起），桌面形态与 gateway 形态复用同一份实现。**因此补丁只需打一处。**

关键节点：

| 行号 | 语句 | 语义 |
| --- | --- | --- |
| L350 | `const declared = models.bindings(model, ...)` | 对外模型名 → `(渠道, 上游真实模型)` 候选集 |
| L353-360 | `if (!declared.length)` | **404 门**：名字没登记就直接拒绝 |
| L361-368 | `services.check(channel, ...)` → `serviceRef` | 剔掉未就绪渠道，补执行来源引用 |
| L402 | `const excluded = new Set(channelsWithAccounts().filter(ch => !bindings.some(...)))` | **不在 bindings 里的渠道预先全部排除** |
| L413-431 | `while` + `routing.pick(model, [...excluded])` | 选渠道（只看健康分/冷却/策略，**不看积分**） |
| L432 | `const channel = binding.channel;` | 下游所有消费点的取值起点 |
| L434 | `accountScope = groupMode ? ... : channel` | 账号排重键 |
| L453-458 | `forwarder.forward(...)` | **执行器唯一被调用的地方** |
| L457 | `excludeAccounts: [...(triedAccounts.get(accountScope) \|\| [])]` | 外部可用的唯一选号杠杆 |

### 1.2 根因（两处割裂）

1. **选渠道与选号割裂**：`routing.pick`（`routing.cjs` L167-210）按健康分/冷却选渠道，完全不看余额；积分排序只在 `pool.accountPlan(channel, ...)` **单渠道内部**生效（`account-plan.cjs` L32-45）。所以「A 渠道有免费号、B 渠道只有永久号」时，第一步就可能选到 B。
2. **模型映射割裂**：对外名必须命中 `models.custom / overrides / aliases / channelLocks / 渠道目录`之一，跨渠道多候选只能靠「模型组」表达，而组又绕过全局路由策略。用户要的「一个名字 → N 渠道 M 模型 → 按积分挑」在原设计里没有对应概念。

### 1.3 一个已被排除的顾虑（我上一轮的误判，此处更正）

`routing.cjs` 的 `candidates()` 确实与模型名基本无关（枚举所有有可用号的启用渠道），一度推导出「declared 不覆盖全部渠道 → L424 `continue` 空转到 128 轮」的挂死风险。但 L402 已在循环前把所有「不在 bindings 里」的渠道灌进 `excluded`，而 `pick()` 的每条返回路径（`usable()` 判定与 `candidates([...exceptSet])`）都尊重 `exceptSet`。**结论：空转不可达，`declared` 只给候选集即可，无需占位绑定行。**

---

## 2. 目标架构

```
外部客户端
   │ model = "abc"
   ▼
:9527/v1/chat/completions
   │
   ▼  handleCompletion
 ┌─────────────────────────────────────────────────────────┐
 │ AgentHub 原生                                            │
 │   L350 declared ◄──── ① agent_auto.declare()  ┐          │
 │   L361 services.check / serviceRef（原生）      │ 新增目录 │
 │   L413 while: routing.pick → binding            │ 未跟踪   │
 │   ★ ② agent_auto.apply(binding) ────────────────┤          │
 │   L453 forwarder.forward(binding.channel,       │          │
 │                          binding.realModel,     │          │
 │                          excludeAccounts=钉号)  │          │
 │   L540 /v1/models ◄── ③ agent_auto.list()  ─────┘          │
 └─────────────────────────────────────────────────────────┘
```

职责边界：**agent_auto 只做「读 + 排序 + 改写决策」，不做执行、不写库、不碰凭证、不发 HTTP。** 所有实际转发、错误分类、冷却记账仍由上游完成。

---

## 3. 注入点清单

### ① 模型名解析 + 候选集（改 L350 一行）

```
原： const declared = models.bindings(model, new Set(), snapshot).filter((m) => !allowed || allowed.has(m.channel));
新： const declared = agent_auto.declare(model, <原表达式>, { allowed, snapshot });
```

`declare(model, native, ctx) → rows[]`

- 无规则命中 / 内部异常 / 该名字已是模型组 → **原样返回 `native`**（fail-open）
- **必须自己应用 API Key scopes 过滤**：传入的 `native` 已被 `.filter(m => !allowed || allowed.has(m.channel))` 裁过，我们自己生成的行要再做一次同样过滤。否则会绕过密钥 scope；虽然 L365 `services.check(..., authorizeChannel)` 会二次拦下，但错误码会从 403 退化成 503，且白白浪费候选
- 命中 → 每个候选一条行：`{ id: model, display: model, channel, realModel, source: "agent_auto", rate, ...(snapshot.catalog.modelMetadata(realModel, channel) || {}) }`
  - `source: "agent_auto"` 是②③识别「本次请求归我管」的唯一标记，必须带
  - 补齐 `rate` / 元数据是为了不打断上游计费倍率、统计与目录展示
- L361-368 会自动 `services.check` 掉未就绪的候选并填 `serviceRef`，**我们一行都不用碰 services**
- 候选全被剔空 → 落 L369 的 503（文案「执行来源未就绪」），比 404 准确
- `exclusive: true` 且无规则 → 返回 `[]`，复用 L353 的 404 门实现「只认 json 里的名字」，不额外花行

### ② 逐次尝试改写 + 钉号（L431 与 L432 之间增一行）

```
binding = agent_auto.apply(binding, { bindings, model, excluded, triedAccounts, attempt: attemptLedger.used + 1 }) || binding;
```

- **必须是同步调用**（不 `await`），避免改变重试循环的时序
- **必须返回新对象，绝不能原地改写 `binding`**：`binding` 是 `bindings.find(...)` 返回的数组内元素引用（L423），原地 mutate 会把 `bindings[]` 里那一行永久改掉；下一轮 `pick` 再返回原渠道时 `find` 就匹配不到，直接 `excluded.add` + `continue`，会造成提前失败甚至空转。注入行因此写成「赋值 + `|| binding` 兜底」，`binding` 在 L415 是 `let`，重新赋值合法
- 首行守卫：`if (binding.source !== "agent_auto") return;` → 原生请求零影响
- 动作：
  1. 用**当前** `excluded` / `triedAccounts` 重跑跨渠道阶梯（①只在入口算一次，重试时号的状态已变）
  2. 目标 `(channel, realModel)` 在 `ctx.bindings` 中查到对应行 → 以 `{ ...binding, channel, realModel, serviceRef }` 的**新对象**返回；`serviceRef` 直接复用该行已捕获的 ref，绕开 `services.capture` 的 `ref.channel === channel` 前置约束
  3. 目标渠道在 `ctx.bindings` 里**不存在**（L361-368 已判为服务未就绪）→ 视为该渠道不可用，跳过并试下一个，**不能沿用旧 `serviceRef`**（不一致会在 `forwarder.cjs` L82-83 触发 403）
  4. 钉号：`pool.accountPlan(channel, undefined, [], 0, realModel)` 取该渠道**全部 eligible 且非目标**的 id → `ctx.triedAccounts.set(binding.channel, new Set(others))`，L457 的 `excludeAccounts` 会把执行器逼到目标号
  5. 目标渠道不可用 → 退到阶梯下一个，并把判死的渠道 `excluded.add()`
- 下游一致性：L432 的 `channel`、L434 的 `accountScope`、L453 的 `binding.realModel`、L462 的 `attempts[]` 日志、`routing.markSucceeded(channel)` 全部自动跟随改写后的值，**无需额外处理**

### ③ `/v1/models` 只暴露自定义名（改 L540 一行）

```
原： const rows = [...new Map(models.list(snapshot).filter(...
新： const rows = [...new Map(agent_auto.list(snapshot, models.list(snapshot)).filter(...
```

`list(snapshot, native) → rows[]`

- 命中规则 → 每个 `(对外名, 候选渠道)` 一行，只带 `{ display: "abc", channel: "mota" }`
- **既有机制自动完成剩余工作**：`allowed.has(m.channel)` 做密钥 scope 过滤、`serviceReady(m.channel)` 剔未就绪、`new Map([m.display, m])` 按对外名去重 → `abc` 自然收成一条
- 无规则且 `expose: "only"` → 返回 `[]`（列表为空，诚实反映「只认 json」）
- 已知副作用：`owned_by` 显示首个就绪候选渠道，而非真正会走的那个（选号在请求时才定）。要修正得再动 L544，**不建议为这个字段花一行**

### ④ Anthropic 列表（可选，改 L555 一行）

句式与③相同。只在你需要给 Claude Code 类客户端提供模型列表时才打。默认不打，保持 3 行。

---

## 4. 新增文件

```
AgentHub/electron/backend/localgw/agent_auto/     ← 目录整体 git 未跟踪
  index.cjs        注入入口：declare / apply / list 三个导出，全程 try/catch
  resolver.cjs     阶梯与候选计算（纯读）
  rules.json       规则 —— 人工维护（或放 ${AGENTHUB_DATA_DIR}，见 §6.1）
  channels.json    渠道字典 —— 程序启动自动生成，**勿手改**（见 §6.4）
install-bridge.cjs                                 ← 放在 AgentHub 仓库之外
```

`channels.json` 是「说明书」而非运行时输入：resolver 不读它，删掉不影响转发，重新启动即重建。

依赖：只 `require` `../proxy/pool.cjs`、`../proxy/store.cjs`、`./routing.cjs`、`./models.cjs` —— 与 `routing.cjs` 现有依赖同形，不引入新模块、不改 require 顺序（`gateway-closure-check` 依赖图不受影响）。

`rules.json` 缺失 / 解析失败 / schema 不合法 → 等同无规则（fail-open），并打一条 warn。

---

## 5. 缓存与性能

| 项 | 口径 |
| --- | --- |
| 每请求成本 | ≈ `2 × 候选渠道数` 条同步 SQL（`listAllCreditPackages` + `listAccounts`） |
| TTL 缓存 | 进程内 `channel → { rows, ladder, at }`，**300-800ms 可配**，并发请求共享一次扫描 |
| 阻塞风险 | 同步 SQLite 读跑在事件循环上。缓存未命中 + 高并发时有毛刺 |
| 护栏 | ① 只扫候选渠道，绝不扫全 33 渠道；② 缓存 TTL 上限硬封顶（避免长期陈旧）；③ `eligibility` 复用 `accountPlan` 的 `readOnly=true` 路径，**不触发上游的复活写库**（`poolAccounts` L96 有写副作用，readOnly 才安全） |

---

## 6. 规则契约

### 6.1 位置

优先 `${AGENTHUB_DATA_DIR}/agent_auto/rules.json`（数据目录，升级/换仓库不丢），回退模块同目录。mtime 热加载，改规则不重启。

### 6.2 结构

```jsonc
{
  "models": {
    "abc": [
      { "channel": "mota",  "model": "deepseek-v3" },
      { "channel": "chanb", "model": "glm-4.6" }
    ]
  },
  "free_channels": ["mota"],
  "ladder": ["free", "expiring", "permanent"],
  "expose": "only",
  "exclusive": false,
  "cacheMs": 500,
  "sticky": false,
  "penalize": { "failures": 3, "coolSec": 120 }
}
```

| 字段 | 语义 | 默认 |
| --- | --- | --- |
| `models.<名字>[]` | **仅声明候选**，数组顺序不代表优先级（口径 1），只在同档内作 tie-break | 必填 |
| `free_channels[]` | 整渠道按免费档走（口径 2） | `[]` |
| `ladder` | 档位顺序，可重排 | `free,expiring,permanent` |
| `expose` | `only`=列表只出 json 名；`merge`=并上原生 | `only` |
| `exclusive` | `true`=json 外的模型名一律 404 | `false` |
| `sticky` | 短时间内同密钥+同模型钉回上一个号 | `false` |
| `penalize` | 连续失败号临时降权 | 关闭 |

**新渠道自动发现**：规则里不存在的渠道，只要未被任何规则引用，走 AgentHub 原生路径；新增渠道不需要改 agent_auto 代码，最多在 `models.*` 里多写一行候选——与需求「渠道变多而已」一致。

### 6.3 与原生配置的关系

规则优先于 `models.custom / overrides / aliases / channelLocks / 模型组`。同名冲突时 `declare` 直接接管并在日志里记一条 `shadow: native binding ignored`，便于排查「为什么我网关里配的映射不生效了」。

### 6.4 渠道字典 `channels.json`（启动自动生成）

**解决的问题**：`rules.json` 里要写渠道 key（英文 slug，如 `mota`）和该渠道的上游真实模型名。这两样靠记忆或翻源码都不可行，写错只会得到无指向的 404/503。

**机制**：程序启动后由 `agent_auto/index.cjs` 首次被①调用时 lazy 生成——**不新增注入行，不加启动钩子**。

#### 生成时机

| 触发 | 说明 |
| --- | --- |
| 进程内任意请求（lazy） | `declare`/`list` 里做一次 `ensureDict()`，此时 `models.prepare()` 已完成，直接用手上的 `snapshot` 逐渠道读，**不额外联网** |
| 渠道集合变化 | 每次 `ensureDict` 用 `store.channelList()` 的 id 集合算指纹，与上次比对；变了就重写。整体 60s 节流，避免每请求读盘 |
| 显式命令（无需进程内调用） | `node install-bridge.cjs channels --refresh`：逐个渠道 `POST :9528/api/rpc/localgw_models_channel_models { channel }`。该命令在只读白名单里（`gateway/src/commands.cjs` L143），只读令牌即可，正好返回该渠道的 `[{id, realModel}]` |

**`GET /v1/models` 只能算触发器，不能当数据源**：它的响应体是 `models.list()` 合并去重后的平铺列表（`server.cjs` L540），而各渠道对同一模型命名各不相同，那份列表对填规则毫无价值。它唯一的作用是顺带触发一次 `models.prepare()`，把**每渠道**目录灌进内存。字典永远读 `channels[].models[]` 这种逐渠道结构，绝不从合并列表反推。

#### 落盘与安全

- 路径：`${AGENTHUB_DATA_DIR}/agent_auto/channels.json`，与 `rules.json` 同级
- 写法：先写 `channels.json.tmp` 再 `rename`，避免半截文件
- 失败处理：目录不可写 / 序列化异常 → 打 warn 后跳过，**不影响转发**（fail-open）
- **不含任何凭证、token、账号 id、邮箱**，只有数量和渠道元信息，可以安全分享给我或贴进 issue

#### 数据源（全部本地，启动零网络）

| 字段 | 来源 | 成本 |
| --- | --- | --- |
| `key` / `name` / `domain` | `store.channelList()`（`store.cjs` L792-807，memoized） | 一次 SQLite 读 |
| `tier` | `store.CHANNELS[].costTier`（`store.cjs` L252 起） | 内存 |
| `routingEnabled` | `routing.isChannelEnabled(id)`（`routing.cjs` L50） | 内存 |
| `accounts.*` | `pool.poolAccounts(id, true)` | 每渠道 2 条 SQL，**`readOnly=true` 避免触发复活写库** |
| `models[]` | `models.channelModelList(id, snapshot)`（`models.cjs` L47-65，与 UI「实际模型名」下拉**同源**） | 内存视图，**不落盘**，见下方说明 |

#### 结构（示例）

```jsonc
{
  "generatedAt": "2026-11-11T09:20:31+08:00",
  "agentHubVersion": "1.1.2",
  "channelCount": 33,
  "freeTierChannels": ["cline_free", "modelscope", "mota"],
  "channels": [
    {
      "key": "mota",
      "name": "魔塔",
      "domain": "api.mota.example",
      "tier": "free",
      "routingEnabled": true,
      "accounts": { "total": 3, "eligible": 2, "free": 1, "expiring": 1, "permanent": 1 },
      "models": ["deepseek-v3", "glm-4.6", "qwen3-max"],
      "modelsRefreshedAt": "2026-11-11T08:00:00+08:00",
      "modelsHint": null
    }
  ]
}
```

`accounts` 的四个档位与 §7.1 的阶梯同口径，直接影响你怎么写 `free_channels`：

- `free > 0` → 这个渠道确实有免费号，值得考虑进 `free_channels`
- `expiring > 0 && permanent === 0` → 全是会过期的号，建议靠前消耗
- `eligible === 0` → 规则里写它只会得到 503，先在号池补号

#### 怎么用（三步）

1. `models.abc[0].channel` ← 抄 `channels[].key`
2. `models.abc[0].model` ← 抄该渠道的 `models[]` 里一项
3. `free_channels` ← 抄 `freeTierChannels`（或按 `accounts.free > 0` 自己挑）

#### 陈旧处理

**先明确一个硬边界**：`channelModelList` 内部先判 `valid(channel)`（`model-catalog.cjs` L466），渠道**没有可用号或执行源未就绪**时恒返回 `[]`。所以 `models[]` 的准确语义是——「**你当前已经有号、且执行源已就绪的渠道，上游实际认哪些模型名**」。这恰好就是填 `rules.json` 时唯一有意义的信息：没号的渠道本来就不该写进规则。

`models: []` 有两种成因：

1. **进程刚重启且还没有任何转发请求** —— 模型目录是纯内存的（见 §12-D1），重启即空。两种补法：发一条业务请求（`ensureDict` 跑在 `prepare()` 之后，直接用手上的 snapshot 逐渠道读，**不额外联网**），或跑 `install-bridge.cjs channels --refresh`（走 9528 逐渠道拉，不需要发业务请求）。
2. **目录刷新失败或不完整** —— `prepare()` 有超时预算（`refreshMs`）与 `CATALOG_BUSY` / `CATALOG_TIMEOUT` 降级，此时是部分目录。字典记 `"complete": false` + `modelsHint`，不要把部分当全量。

注意 `channelModelList` 已按 `proxy.disabledModels` 过滤（`models.cjs` L51-53），所以字典里出现的都是**当前可执行**的名字，不会把你在网关里停用过的模型混进来。

#### 与规则的关系

- `resolver` **不读** `channels.json`：它是文档，不是配置
- `install-bridge.cjs lint` **读它**做拼写校验：`rules.json` 里的 channel key 不在字典里就报错，并用编辑距离给出最接近的候选（`moto` → 你是不是想写 `mota`）；`models.abc[].model` 不在该渠道 `models[]` 里则警告（不阻断，因为可能还没刷新目录）
- 显示名直接取上游 `display` 字段，**不做人工翻译**（`Cline Free`、`WorkBuddy CN` 原样保留）。理由是：硬编码一张中文映射表会变成第二份需要跟着上游改的常量，与本方案「少维护」的目标冲突

---

## 7. 选号阶梯算法

### 7.1 数据口径（关键实现前提）

`pool.deriveAccountCredits()`（`pool.cjs` L45-59）把逐包**塌缩成单个 `credits` + 最小 `expiresAt`，到期/永久的分界在派生后丢失**。因此 resolver **必须直接读 `store.listAllCreditPackages(channel)`** 自行分档，不能复用 `accountView` 的 `credits`。

```
valid(p)  = !(p.expiresAt > 0 && p.expiresAt <= now)
timed(p)  = valid && p.expiresAt > 0        // 到期积分
perm(p)   = valid && p.expiresAt === 0      // 永久积分（normalizeExpiryMs 把远未来脏值归 0）
unlimited = valid && p.remaining === -1

rank 0 免费      channel ∈ free_channels
rank 1 到期积分   Σ timed.remaining > 0
rank 2 永久积分   Σ perm.remaining > 0 或 unlimited
rank 3 期限未知   其余
```

同档 tie-break（默认，可评审调整）：
`unlimited 优先 → expiresAt 最早（先花要过期的）→ 该档余额最少（快过期的先榨干）→ inFlight 最少 → lastUsed 最早 → id 字典序`

`inFlight` 直接取 `pool.accountPlan` 返回行里的 `inFlight`（`account-plan.cjs` L19），这是**进程内实时值**，是放弃外部服务方案的核心理由之一。

### 7.2 eligibility 不重写

「这个号能不能用」完全复用上游判定（`account-plan.cjs` L23-29：在线 / 有凭据 / 非本轮已试 / 余额未耗尽 / 未过期 / 模型未冷却 / 并发未满），agent_auto 只负责**在 eligible 集合内部重排 + 挑第一个**。上游改了门禁，我们自动跟随。

### 7.3 边界澄清（需求侧风险）

- 我们能决定「用哪个号」；**不能**决定「同一号内先扣限时包还是永久包」——那是上游服务端的扣费顺序。若一个号同时有 100 限时 + 500 永久，实际可能先扣永久。
- 「免费号」判定存在三处冲突源：渠道级 `costTier`、账号级 `meta.gateway.billingKind`、逐包 `name/remaining`。方案以 **`free_channels` 显式配置为唯一权威**（rank 0），绕开三处打架；Cline 这类「余额恒 0 但可用」的渠道（`pool.zeroBalanceUsable` L114-119）由 eligibility 层放行，不需要特殊处理。

---

## 8. 风险清单

按「发生概率 × 影响面」排序。

### R1 · 上游重构导致锚点在但语义已变 —— **高**

- 触发：`handleCompletion` 被重写；尤其 **L402 的 `excluded` 预排除被删除或改造** → §1.3 排除掉的空转陷阱会复活，表现为请求挂死到总时限后 500，而不是明确报错。
- 补丁器**抓不到**这类问题（锚点文本仍在，插入位置合法）。
- 缓解：`install-bridge.cjs check` 只防「锚点丢失」；真正防线是 §10 的行为冒烟断言，必须进日常升级流程。
- 残余：**中**。这是本方案唯一无法静态消除的风险。

### R2 · 钉号是 best-effort，不是强制 —— **高（语义期望差）**

- 触发：执行器仍走 `pool.pickAccount(channel, undefined, excludeAccounts, ...)`（`standard/executor.cjs` L21），没有「强制 accountId」入口。若目标号被目录级 `catalogExcludeAccounts` 排除、或并发已满，会**静默换到别的号**。
- 影响：你以为钉住了，实际没有。
- 缓解：`apply` 内记录「期望 accountId」，与 `localgw_requests_list` 的 `attempts` 人工比对。
- 观测缺口：上游 `attempts[]`（L462）**不含 accountId**，无法自动断言「实际用了哪个号」。要闭环只能在上游再多打一行——不建议。
- 残余：**中**。

### R3 · 积分数据陈旧让排序失真 —— **中**

- 触发：`credit_packages` 由余额刷新/签到任务写入。长时间未刷新 → 把已过期号判为可用，或把有余额号判为不可用。
- 缓解：`expiresAt` 与 `now` 的比较是每次实时算的（过期这一维不会错）；**余量数值**这一维依赖刷新任务。缓存 TTL 只影响分钟级。
- 残余：**低-中**。

### R4 · 上游健康分/轮转被架空 —— **中**

- 触发：②每次都重排，`routing.pick` 的 `rrCursor`、`score`、`preferChannels` 不再决定实际渠道。
- 影响：网关「路由」页的统计与渠道健康分变成稀疏数据；若上游以后基于这些信号加新功能（比如自动隔离），行为会不符合直觉。
- 缓解：阶梯保留 `routing.isCooling(channel)` 作为硬过滤（只尊重冷却，不尊重打分排序），并在文档里明确「接管后路由策略失效」。
- 残余：**低**（不影响正确性，影响可解释性）。

### R5 · 规则文件写错没有任何反馈 —— **中**

- 触发：渠道 id 拼错、模型名在该渠道目录里不存在 → 表现为 404/503，不指向根因。
- 缓解：`install-bridge.cjs lint` 子命令校验：渠道存在于 `store.CHANNELS` / `listAgents`、模型在该渠道目录、`free_channels` 是合法渠道 id。
- 残余：**低**（工具化后可消除）。

### R6 · 逻辑跑在网关进程内 —— **中**

- 触发：`apply`/`declare` 抛未捕获异常会打断转发。
- 缓解：`index.cjs` 三个导出最外层 `try/catch` → 异常时返回「无规则」等价物（`declare` 回 `native`、`apply` 直接 return、`list` 回 `native`），即**故障时自动退回 AgentHub 原生行为**，不会放大成网关不可用。
- 残余：**低**。

### R7 · `npm run verify:gateway` / `npm test` 在打了补丁的工作树上跑 —— **中**

- 触发：上游冒烟脚本若对 `declared`/`bindings` 有断言，我们的改写可能让 verify 失败，误判成「上游坏了」。
- 缓解（本方案的设计优势）：**`rules.json` 不存在时三个注入点完全恒等**（`declare`/`list` 返回原值、`apply` 首行 return）。因此可以「删 rules.json → 跑上游 verify → 应当全绿；放回 rules.json → 跑 §10 自己的断言」两段式验收。
- 残余：**低**。

### R8 · 形态绑定 —— **低-中**

- 桌面 Electron 打包：`agent_auto/` 未被 git 跟踪，`electron-builder` 的 `files` 规则可能不收录 → 打包版缺文件。你走 node 直启，不触发；若哪天要打包需确认 `files` 通配。
- Docker：取决于 `COPY` 范围。你已明确走 node 直启。
- 跨机共享策略：进程内方案没有集中策略源。多台网关要各自维护 rules.json。

### R9 · 回滚与污染 —— **低**

- 回滚：`git checkout -- electron/backend/localgw/server.cjs`（3 行）+ 删目录。
- `.git/info/exclude`（本地排除，不改仓库 `.gitignore`）保证 `git status` 干净，不会误提交进上游 PR。
- `rules.json` 不含凭证，但 `${AGENTHUB_DATA_DIR}` 含。公开仓库/分发时注意别把数据目录带上。

### R10 · 许可与版权 —— **低**

AgentHub 是 AGPL-3.0，且 `pool.cjs` 等文件头部有沐晖的个人版权声明（「禁止未授权搬运」）。自用不构成再分发，通常无碍；若你日后**分发**带 agent_auto 的衍生版，AGPL 的源码提供义务会落到你头上。方案本身不复制上游代码，只新增独立模块 + 3 行调用。

### R11 · 字典文件误导配置 —— **中低**

- 触发：`channels.json` 的 `models[]` 是**目录缓存**，实例久未刷新 → 列表里全是旧模型名，你照着抄进 `rules.json`，请求时上游已下架 → 503/404。
- 另一类：渠道 `display` 名与用户口语不一致（`mota` 显示 `魔塔` 还是 `ModelScope（魔搭）` 由上游定），抄错 key。
- 缓解：① `modelsHint` 明确标注「目录未刷新」，不假装是权威；② `lint` 做 key 拼写校验 + 编辑距离纠错；③ 文档里写死「key 以 `channels[].key` 为准，不看 `name`」。
- 不修的：不做中文名→key 的模糊匹配（会引出新的猜错场景，收益低于成本）。
- 残余：**低**。

### R12 · 启动时生成字典的副作用 —— **低**

- 触发：只在**网关启动**时生成一次（`doStart` 钩子），且用 `setImmediate` 排到事件循环里，不占请求线程。
- 缓解：启动后单次生成 + 原子写；请求路径完全不触发（曾经有过「请求触发 + 60s 节流」，已按用户要求移除）。
- 残余：**低**（640 个号时约 42–49 ms，只发生在启动后一次，且无正确性影响）。

---

## 9. 明确否决的替代方案

| 方案 | 否决原因 |
| --- | --- |
| 独立 HTTP 服务 + GET 桥接（原需求设想） | ①并发数、冷却、余额是**进程内实时状态**，外部轮询必然滞后且无法解决；②每请求多一次网络往返；③要保活、要端口、要处理服务挂了怎么办；④用户真实诉求收敛为「自定义映射」，进程内文件即够。保留可插拔口：将来要远端只换 `resolver` 的策略源，注入行不动。 |
| 官方插件机制 | `extensions/pool-broker.cjs` 头部注释明确「不选号、不调其它渠道适配器、不执行 HTTP」，能力面不够。 |
| 纯前置代理（0 行改动） | 做不到账号级（无法参与 `excludeAccounts` / `inFlight` / 钉号）。 |
| `NODE_OPTIONS --require` monkey-patch（0 行改动） | 依赖模块导出与函数参数位次，比语义锚点**更脆**，且 R1 类风险变成完全不可检测。 |
| 只用原生「模型组 + cost-first」 | 组绕过全局路由策略且不做账号级积分排序；`cost-first` 只看渠道 `costTier`（`routing.cjs` L195-197），粒度不到号。 |

---

## 10. 验收方案

### 10.1 静态（每次同步上游后）

```
node install-bridge.cjs check        # 锚点存在 + 单匹配；退出码非 0 = 上游挪了代码
node install-bridge.cjs apply        # 幂等重写 3 行
node install-bridge.cjs channels     # 重写 channels.json（加 --refresh 拉实时模型目录）
node install-bridge.cjs lint         # rules.json 渠道/模型合法性（依赖 channels.json）
```

### 10.2 恒等性（先证明没破坏上游）

临时移除 `rules.json` → `npm run verify:gateway` + `npm test` **必须全绿**。这是 §R7 的主防线。

### 10.3 行为冒烟（证明补丁真的生效，R1 的主防线）

| 用例 | 期望 |
| --- | --- |
| 免费渠道有可用号，打 `abc` | `attempts[0].channel === "mota"`，`model` 为 mota 的上游名 |
| 把 mota 的号全部置 `exhausted` 后再打 | 跳到 `chanb`，上游名随之改变 |
| 打规则外的原生模型名（`exclusive: false`） | 走原生路径，行为与未打补丁一致 |
| 打规则外的原生模型名（`exclusive: true`） | 404「模型未配置或已关闭」 |
| `GET /v1/models`（`expose: only`） | 只返回 `abc` 一条，无重复 |
| 候选渠道全部未就绪 | 503 `FORWARD_PLUGIN_UNAVAILABLE`，不是空转到超时 |
| 目标号并发已满 | 请求仍成功（换号），日志出现「期望号 ≠ 实际」的 warn |
| 冷启动后跑 `channels --refresh` | 字典生成；有号渠道的 `models[]` 非空，且**彼此不同**（是各渠道自己的原生名，不是全站并集） |

第 6 条（503 而非超时挂死）就是 **R1 的行为探针**：若上游改了 `excluded` 语义，这条会变成超时。

---

## 11. 后续维护难度评估

| 场景 | 频率 | 需要做什么 | 难度 |
| --- | --- | --- | --- |
| 上游改无关模块（UI/记忆/提示词） | 最常见 | `check` → 绿 → 什么都不用做 | 极低 |
| 上游新增渠道 | 常见 | 代码零改动；`channels.json` 下次启动自动多一条；想用它在 `rules.json` 加一行候选 | 极低 |
| 上游调整 `handleCompletion` 变量名 | 偶发 | 更新 `install-bridge.cjs` 里对应的锚点常量（1-2 处），重跑 `apply` | 低 |
| 上游把 `binding` 改成不可变 / 换决策结构 | 罕见 | ②的改写方式要重设计；①③通常仍可用 | 中 |
| 上游重构 `account-plan.cjs` 分档/门禁 | 罕见 | §7.2 复用 eligibility，通常自动跟随；只有 §7.1 的逐包口径可能要跟着改 | 中 |
| 上游删改 L402 `excluded` 预排除 | 罕见但致命 | 静态 check 抓不到，靠 §10.3 第 6 条探针发现，再重审 ① 的候选集口径 | **高** |
| 改自己的策略（新档位、新 tie-break） | 自主 | 只动 `resolver.cjs`，不碰 AgentHub | 低 |
| 回滚 | 自主 | `git checkout` 一行命令 + 删目录 | 极低 |

**综合判断**：维护成本集中在「同步上游后的 3 条命令 + 一次冒烟」，绝大多数同步是零人工介入。真正的长尾成本只有两类——锚点文本改名（机械修）、以及上游语义变了但文本没变（需要人重新读 `handleCompletion`）。后者概率低、但每次都要重读上百行代码，是本方案唯一的重活。

对比原设想（独立服务）：省掉部署、保活、跨进程一致性、网络失败处理四类长期成本；换来的是「逻辑必须写在上游的内部数据结构上」这一耦合。以你的使用形态（单机自用、node 直启、要跟着作者更新吃红利），这个交换是划算的。

---

## 12. 补充梳理：第二轮 + 第三轮

### A. 会让功能直接失效的实现细节

**A1 · `binding` 不能原地改写** —— 已写进 §3②。这是本轮最严重的发现：`binding` 是 `bindings[]` 的元素引用（L423），原地 mutate 会破坏下一轮 `find` 的匹配条件。注入行必须是**赋值新对象**。

**A2 · `declare` 要自己应用 API Key scopes** —— 已写进 §3①。否则绕过 scope，且错误码从 403 退化成 503。

**A3 · `exposeInV1Models` 关着时第③行完全不执行** —— **新发现**。`handleModels` 在 L533 就 `return` 空列表了，根本走不到 L540：

```
if (!c.models.exposeInV1Models) { sendJson(res, 200, { object: "list", data: [] }); return; }
```

你会以为「只暴露 json 里的模型」，实际得到空列表。对策：启动自检读一次 `lgwConfig.get().models.exposeInV1Models`，为 false 时在日志和 `channels.json` 的 `warnings[]` 里明确写「需在网关设置里开启『在 /v1/models 暴露模型』」，别让人去怀疑补丁没打上。

**A4 · 候选渠道数 > 重试预算** —— **新发现**。`maxRetriesPerRequest` 默认 3、上限 10（L406）。`abc` 挂了 5 个渠道时，第 4、5 个**永远不会被尝试**，而你以为它们都在兜底。另外 `routing.failover === false` 时预算直接是 1。对策：`declare` 按 rules 顺序/优先级只保留前 `min(候选数, budget)` 条，或者在文档里明确要求把网关设置的「单请求最大重试」调大；`lint` 检测到「候选数 > 当前预算」时警告。

### B. 语义与体验（需要你决策）

**B1 · 同一个对外名跨不同上游模型，能力不等价**。`abc` 在 A 渠道是 deepseek、B 渠道是 glm，`tools` / `vision` / `reasoning` / 上下文长度都可能不同。更麻烦的是 L473：

```
if (committed || forwardResult.switchable === false || ac.signal.aborted) break;
```

参数类错误（如 `thinking` 不被支持）通常是 `switchable === false`，**不会换渠道**，客户端直接吃 400。所以跨渠道候选实际只对「网络/5xx/429/无号」这类故障做兜底，**不做能力等价替换**。建议：候选尽量选同家族模型；rules 里不承诺「总能成功」。

**B2 · 多轮会话漂移**。同一个会话连续请求可能落到不同号、不同上游模型，行为与上下文不一致（`triedAccounts` 只在单次请求内生效）。`sticky` 目前默认 `false`，我建议改为**默认 `true`**，键取 `apiKeyId + 对外模型名`，TTL 10 分钟，失败才换。

**B3 · `free_channels` 里写了但该渠道没有 eligible 号**。rank 0 只是排序偏好，号本身不可用照样被 eligibility 排除。`lint` 应读 `channels.json` 的 `accounts.eligible` 直接警告「mota 当前无可用号，free 档形同虚设」。

### C. 维护与观测

**C1 · 我们的失败会污染上游渠道健康分**。L485 失败时调 `routing.markFailed(channel)`，渠道会进入上游冷却，连带影响**原生请求**。行为上可接受（确实失败了），但要知道「agent_auto 的跨渠道尝试会让某些渠道整体变冷」。

**C2 · 权限撤销的监听范围**。`authorizedChannels`（L380）来自原始 `bindings`；我们切到声明集之外的渠道时，`watchKey`（L328）在 `requestState.channel` 赋值后按单渠道监听，影响很小，但严格说「渠道授权被撤销」这一类事件的覆盖面会变窄。

**C3 · `rules.json` 读到半截文件时不要静默回原生**。热加载撞上编辑器「先清空再写」的瞬间会 parse 失败；当前设计是 fail-open 回 `native`，用户会看到行为**突然变化且没有报错**。改成：**保留上一份成功解析的规则**，只有进程内从未成功加载过才回原生，并打 error 日志。

**C4 · 决策不可观测**。`attempts[]`（L462）只有 `channel` / `model` / `code`，**没有 accountId**，所以「钉号到底成没成」无法自动验证（也就是 R2 的观测缺口）。建议 agent_auto 自己维护一个带上限的 JSONL 决策日志（每次尝试一行：候选列表、选中号、跳过原因、耗时），默认关闭、`rules.json` 里可开。这是排查「为什么走了这个号」和发现「钉号失效」的唯一低成本手段。

### D. 数据时效（修正一个预期）

**D1 · 重启后模型目录不会自动回来**。`model-catalog.cjs` 的 `cache` 是**纯内存**（L63），`prepare()` 每次实时拉（L200，带 `refreshMs` 超时）；落盘的 `localgw-catalog-history.json`（L574）只服务「历史授权 / 不可用模型展示」（`models.cjs` L206 的 `source: "unavailable"`），**不是可执行模型清单**。

所以「我拉取过模型，下次启动字典里就有了」不成立。但实际不影响使用：`ensureDict` 跑在 `declare`/`list` 内部，那时 `models.prepare()` 已完成，我们对着**当次 snapshot** 逐渠道调 `channelModelList(channel, snapshot)`，读到的就是每个渠道自己的原生模型名（不是合并列表）。所以「冷启动 + 零流量」时 `models` 为空，发一条请求或跑一次 `channels --refresh` 就补齐；而**没有可用号的渠道永远是空数组**，这是 `valid(channel)` 的门禁，不是缺陷（见 §6.4）。

**D2 · 两个 `rules.json` 同时存在时的优先级**。§6.1 说「数据目录优先，回退模块目录」，要定死并在日志里打印实际加载的绝对路径，否则改了模块目录那份却不生效会很难查。

**D3 · mtime 热加载在 Windows 上可能漏判**。文件系统时间精度有限，快速连续保存可能拿到相同 `mtimeMs`。用 `mtimeMs + 大小` 双键，或直接对内容做 hash（文件很小，成本可忽略）。

### F. 第三轮：执行链路上的结构性约束

**F1 · `pick` 不是决策者，是「过场」——但必须让它过得了场**。

`routing.pick`（L421）是作者重试循环里的**既有语句**，我们那两行插在它之后（L431/L432 之间）。所以每轮都会先执行它，但它的返回值会被第②行**整体覆盖**，**不决定最终去哪个渠道**。

唯一的耦合：`pick` 返回 `null` 时 L422 直接 `break`，循环走不到第②行。它只在「有号 + 渠道启用 + 非冷却 + 有 eligible 号」的集合里挑（L102-130），而你的候选本来就是这些渠道，正常必有返回。唯一会踩的是：规则指向的渠道在网关路由里**被禁用**或被 `blockedChannels` 拉黑——那不是 pick 决策错，是规则写了一个网关层面已关闭的渠道。所以 `declare` 里补一句 `isChannelEnabled` 过滤即可，**不用改循环**。

如果你要求 pick 完全不在这条链路上，只有两条路：改掉循环那几十行（不再是 2 行），或在运行时包装 `routing.pick` 让它直接返回 resolver 的结果（0 行源码改动，但属于隐式 hook，审计性和「跟着作者更新」都不如显式两行）。

**F2 · 冷却是两层，你说的那层已经成立**。

| 层 | 触发 | 影响范围 | 代码 |
| --- | --- | --- | --- |
| **账号级** | 凭证失效、配额耗尽、401/403/429、5xx 熔断 | **该号对所有模型都不可用** | `cool_until` / `status`，`accountPlan` 对每个 model 都排除它 |
| **账号×模型级** | 仅「模型本身的问题」，如上游 6004/11102（该账号对此模型无权限/无额度） | 只罚这个组合，号对其他模型仍可用 | `coolAccountModel`（`pool.cjs` L180），键 `accId∥model` |

你说的「号都不能用了，换模型没意义」正是**第一层**，AgentHub 本来就是这么做的。第二层只在「号是好的、只是这个模型不能用」时生效——那种情况下换模型确实有意义，所以上游只罚组合、不罚账号。

我们的 resolver 调 `accountPlan(channel, …, realModel)`，两层门禁都吃到：账号级失败的号**不会**被阶梯选中去跑别的模型，与你的预期一致。

剩下的只是个小事实：`pick` 传的是别名 `abc`，它查第二层时用了个上游从未出现过的键，所以那层对它等于空判。它只让 `pick` 的预筛偏松，不影响我们——`declared` 里只有 resolver 认可的候选。这条纯解释，不用改代码。

**F3 · 规则命中即权威，这是设计，不是问题**。

按你的口径：命中规则就完全替换系统配置。原来「全候选不可用回退 native」的建议**撤回**，`strictRules` 默认 `true`——规则写坏就该 503，让你立刻发现，而不是悄悄走原生、让你误以为规则生效。

只保留一条只读 warn：「规则 `abc` 命中但 0 个候选可用（原因：渠道禁用 / 无 eligible 号 / 服务未就绪）」，纯排错用。

**F4 · 同渠道多模型候选会共享账号排重键**。普通模式 `accountScope = channel`（L434），`triedAccounts` 以它为键。同一渠道挂两个模型（`abc → mota/A`、`def → mota/B`）时，`abc` 用过的号会被 `def` 避开——哪怕那个号对 `def` 完全可用。上游正是为此才有 `groupMemberKey`（`channel\0realModel`，`routing.cjs` L217-220）。修它要多动 L434 这第 4 行，**建议先不动**，改为 rules 设计上避开「同渠道给同一对外名挂多个模型」，`lint` 提示。

**F5 · `declare` 要尊重 `proxy.disabledModels`**。原生 `models.bindings` 在 L144-145 对 `modelId / realModel / display / aliases` 都做了停用判定，我们的行绕过了它。结果：你在网关界面停用 `abc`，规则照样 200 出去。`declare` 应对外名做同口径判定（大小写不敏感），命中就返回 `[]` → 404。

**F6 · `model` 字段不做二次解析**。rules 里的 `model` 直接当 `realModel` 发上游，不会再走别名/覆盖/目录校验。写错只会拿到上游的 400/404，看起来像「模型不存在」而不是「规则写错」。`lint` 拿 `channels[].models[]` 比对能提前拦住大部分；名字带前缀（`openai/abc`）也不做解析，规则里要写全名。

### G. 观测与运维的小项

- **G1**：`channels --refresh` 逐渠道串行 33 次、每次可能几秒。并发限 4，失败单独重试一次。
- **G2**：`sticky` 与 `triedAccounts` 的优先级必须是「本轮已试 > sticky」，否则钉号会把你送回刚失败的那个号。
- **G3**：总时限（`requestTimeoutMs` / 流式总时限）与候选数耦合——慢渠道会吃掉时间预算，可能一个都没试完就超时。只警告候选数，不承诺兜底一定成功。
- **G4**：`/v1/models` 里出现 `abc` 只代表**至少一个候选渠道就绪**，不代表当时有可用号（号可能正被并发占满或冷却）。列表与实时可用性本来就有偏差，上游原生模型也一样。

### H. 一句话总结

改动仍是 3 行。第三轮真正需要写进代码的只有三件小事，都不改变骨架：**F1**（`declare` 补 `isChannelEnabled` 过滤，保证 `routing.pick` 不返回 null）、**F5**（尊重 `disabledModels`）、**F6**（`model` 不做二次解析）。F2 是解释不是缺陷，F3 已按「规则即权威」定案。A1 仍是写代码前必须定死的约束，A3/A4 是「看起来没生效」的隐性坑，B1/B2 决定好不好用，D1 修正了你对「缓存」的预期。

---

## 13. 待你拍板的项

1. `exclusive` 默认 `false`（列表只显 json 名，但原生模型名仍可用）—— 是否符合预期？
2. 同档 tie-break 的默认顺序（§7.1）是否照此实现？特别是「快过期的先榨干」还是「余额多的先用」。
3. `sticky` / `penalize` 两个可选项：**第一版就实现**，还是先只做阶梯、跑稳了再加？
4. 第④行（Anthropic `/v1/models`）打不打？你用不用 Claude Code 类客户端？
5. `rules.json` 放 `${AGENTHUB_DATA_DIR}`（推荐，换仓库不丢）还是模块同目录（推荐配合 `.git/info/exclude`）？
6. `channels.json` 里的 `accounts` 统计口径：只要 `{total, eligible}`（更简单），还是保留 §6.4 的四档 `{free, expiring, permanent}`（更好挑 `free_channels`，但要求 resolver 和字典共用同一套分档函数）？我倾向保留四档。
7. 渠道字典的生成时机？**已定案**：只在网关启动时生成一次，请求路径不再触发（也没有 60s 定时）。
8. `sticky` 是否改为**默认开启**（§12-B2，键 `apiKeyId + 模型`，TTL 10 分钟）？
9. 候选渠道数超过重试预算时（§12-A4）：由 `declare` 自动截断，还是只做 `lint` 警告、由你去网关设置里调大 `maxRetriesPerRequest`？我倾向「截断 + 警告」双做。
10. 决策日志（§12-C4）要不要进第一版？默认关闭、可开，只写本地 JSONL 并在超过 2MB 时滚动。
11. ~~规划 F3 兜底~~ **已定**：规则即权威，`strictRules: true`，全候选不可用就 503，只留 warn 日志。
12. **F4 默认接受**（不动 L434）：同渠道多模型候选会共享账号排重键，`lint` 提示避开这种写法即可。

> 确认后可以开工。开工产出：`agent_auto/` 四个文件（`index.cjs` / `resolver.cjs` / `rules.json` / 自动生成的 `channels.json`）+ `install-bridge.cjs` + `server.cjs` 3 行补丁 + §10 全套脚本化验收。

---

## 14. 落地状态（已实现，与代码一致）

拍板结果全部落进代码，实际是 **6 处补丁**（第④行也打了，对应 §13-4；第⑤行 Token 映射、第⑥行启动生成字典为后续追加）。

### 14.1 实际改动的 AgentHub 源码（只有 6 行）

| # | 位置 | 改动 |
|---|------|------|
| ① | `localgw/server.cjs` L350 | `models.bindings(...)` 外包一层 `require("./agent_auto/index.cjs").declare(...)` |
| ② | 同文件 L432 | 循环内 `routing.pick` 之后插入 `binding = ...apply(...) \|\| binding;` |
| ③ | 同文件 L541 | `models.list(snapshot)` → `require("./agent_auto/index.cjs").list(snapshot)` |
| ④ | 同文件 L556 | 同上（Anthropic `/v1/models`） |
| ⑤ | 同文件 L65 | `authenticate()` 取到 header token 后先过 `translateKey()` 再验权 |
| ⑥ | 同文件 `doStart()` | 启动时 `ensureDict(null)` 落一份渠道字典（不加载模块就永远没有 channels.json） |

全部为**内联 `require`**，没有新增顶层 require 行；`routing.pick`、循环、`accountScope`、并发/队列一行未动。

### 14.1.1 Token 映射（第⑤行）

`rules.json` 的 `api_keys` 是「外部旧 Token → 本机真 Token」的字典，例如：

```json
"api_keys": { "sk_old123": "sk_new456" }
```

外部客户端继续用 `sk_old123`，网关在 `keysStore.authenticate()` 之前换成 `sk_new456`；密钥库里只需要存在 `sk_new456`。命中不到就原样传下去，等价于没配。该字段落在 rules.json 里是明文，文件本身已在数据目录（不进仓库）。`install-bridge lint` 会用本机密钥库校验映射目标是否真的可用，避免配错后必然 401。


### 14.2 新增文件

- `AgentHub/electron/backend/localgw/agent_auto/resolver.cjs`：规则热加载（mtime+size 缓存、BOM 兼容、解析失败沿用上一份有效规则）、跨渠道阶梯排序、粘性、本地惩罚。
- `AgentHub/electron/backend/localgw/agent_auto/index.cjs`：`declare` / `apply` / `list` 三个注入函数 + `ensureDict` + `lint` / `status` / `reload` + 决策日志。
- `AgentHub/electron/backend/localgw/agent_auto/rules.json`：模板（`models: {}` = 不接管）。
- `install-bridge.cjs`：`check` / `apply` / `revert` / `lint` / `init` / `channels [--refresh]`。
- 运行时生成：`${AGENTHUB_DATA_DIR}/agent_auto/channels.json`、`decisions.jsonl`（`debug:true` 时）。

### 14.3 拍板项落点

| 拍板 | 实现位置 |
|------|----------|
| 原生模型不可用才行（`exclusive:false`） | `declare` 未命中规则即 `return nativeRows` |
| 快过期的先榨 | `resolver.planChannel` 排序键 `soonest` 升序 |
| sticky / penalize 第一版 | `resolver.sticky` / `resolver.penalty`，`sticky.enabled` 默认 `true`、TTL 600s |
| `/v1/models` 只返回 json 名 | `list()` 的 `expose:"only"` |
| rules.json 放 `${AGENTHUB_DATA_DIR}` | `resolver.rulesPath()` 优先数据目录，回退模块目录 |
| 字典 accounts 保留四档 | `ensureDict` 的 `{total,eligible,free,expiring,permanent,unknown}` |
| 字典只在启动生成 | `server.cjs` 的 `doStart` 调 `ensureDictLater(null)`，`setImmediate` 执行一次 |
| 超预算「截断 + 警告」 | `declare` 按 `retryBudget()` 截断 + `warn`，`lint` 同步告警 |
| 决策日志进第一版 | `decisionLog`，默认关闭，2MB 轮转 |

### 14.4 使用顺序

```bash
node install-bridge.cjs check                 # 4 个锚点是否完好
node install-bridge.cjs init                  # 在数据目录生成 rules.json（已存在不覆盖）
# 启动 AgentHub 网关后，让字典带上每个渠道的真实模型：
node install-bridge.cjs channels --refresh --token <只读令牌>
# 按 channels.json 里的 key 填 rules.json，然后：
node install-bridge.cjs lint
```

### 14.5 已知未验证 / 限制

- 本机缺 `express` / `js-yaml`（未装 `node_modules`），**真实 gateway 端到端未跑**；`node --check`、`install-bridge check`、`tools\gateway-closure-check.cjs`（251 文件）均通过。
- 钉号（`triedAccounts`）是 best-effort：执行器只有 `excludeAccounts` 一个杠杆，若某渠道所有号都已在 `triedAccounts` 里，钉号会失效并回落到执行器自己的选择。
- `channels.json` 的 `models` 依赖模型目录快照；冷启动首份字典只有渠道 key / 中文名 / 账号档位，模型清单需一次请求或 `channels --refresh` 后补齐。
