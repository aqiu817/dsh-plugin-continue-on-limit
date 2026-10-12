# dsh-plugin-continue-on-limit

**模型写到输出上限被截断时，插件替你按「继续」。**

**简体中文** | [English](./README.en.md)

DeepSeek Harness 宿主侧插件：监听 `turn/end` 的 `max-tokens` 结束原因，通过
`agent.followup()` 发一条普通的下一个 turn 提示词，并受每会话 burst 上限、
最小间隔和总开关约束。没有客户端半部，不碰 React slot，不依赖任何 UI 快照字段。

> **English.** A host-side DeepSeek Harness plugin that presses "continue" for you
> when the model stops because it exhausted its output-token budget. It watches
> `turn/end` for `reason.kind === 'max-tokens'` and issues an ordinary next-turn
> follow-up through `agent.followup()`, gated by a per-session burst cap, a
> minimum interval, and an opt-out. No client half, no UI snapshot dependency,
> 61 tests on bare `node`.

![license](https://img.shields.io/badge/license-MIT-blue)
![tests](https://img.shields.io/badge/tests-61%20passing-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D22-informational)

---

## 目录

- [它解决什么](#它解决什么)
- [安装](#安装)
- [配置](#配置)
- [工作原理](#工作原理)
  - [1. 检测：只听宿主侧事件](#1-检测只听宿主侧事件)
  - [2. 发送时机：为什么不能直接在回调里发](#2-发送时机为什么不能直接在回调里发)
  - [3. 消息身份：为什么不用 user](#3-消息身份为什么不用-user)
- [安全设计](#安全设计)
- [测试](#测试)
- [已知限制](#已知限制)
- [与 harness 原生的关系](#与-harness-原生的关系)
- [故障排查](#故障排查)
- [开发](#开发)
- [License](#license)

## 它解决什么

dsh 原生**不会**自动续写。一个 turn 以 `max-tokens` 结束时，harness 把会话停住，
UI 显示「回答被截断…发送"继续"可让模型接着输出」。这是有意设计——等人来决定要不要
接着写。

如果你嫌每次截断都要手打两个字，这个插件就是把那两个字自动化。

自动续写**不冒充人类输入**：它以插件身份进入对话，在聊天界面渲染成一条
「插件状态更新」，写明是哪条通知触发了这一轮。一条链完整可审计。

## 安装

本插件是一个标准的 dsh bundle，通过 profile 的 `package.json` 挂载。

**1. 装依赖**

```bash
cd dsh-plugin-continue-on-limit
npm install --ignore-scripts
```

用 npm 而非 pnpm：pnpm 在部分沙箱环境下建不出 junction，会把顶层 `node_modules`
落成实体目录，导致 `@deepseek-ai/cosmokit` 不可达。

**2. 在 profile 的 `package.json` 里登记**

```jsonc
{
  "dependencies": {
    "dsh-plugin-continue-on-limit": "link:/absolute/path/to/dsh-plugin-continue-on-limit"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-continue-on-limit"
      ]
    }
  }
}
```

`cordis.patch.yml` 会通过 `dsh.bundle.patch` 自动挂进 patch 列表，不需要手写那条
`- insert:`。

**3. `pnpm install`，重启 dsh。**

卸载就是把上面两步反向做掉，没有残留状态。

> 本插件**不是** `required` bundle：组合失败不会写启动日志。装完请确认 Plugins
> 页面能看到 `continue-on-limit` 这一项。

## 配置

三个字段全部是 `.volatile()`：在 Plugins 页面改了**不重载 fiber**，
`enabled: false` 中途就能掐断一条正在跑的链。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `continueText` | string (1–200) | `继续` | 发什么文字 |
| `maxConsecutive` | integer (0–16) | `3` | 单会话一条截断链最多自动续写几次；`0` = 无上限 |
| `minIntervalMs` | integer (0–600000) | `1500` | 两次续写的最小间隔，防死循环 |

`cordis.patch.yml` 里的默认值：

```yaml
- insert:
    - id: continue-on-limit
      name: 'dsh-plugin-continue-on-limit'
      config:
        enabled: true
        continueText: '继续'
        maxConsecutive: 3
        minIntervalMs: 1500
```

## 工作原理

### 1. 检测：只听宿主侧事件

宿主侧单一数据源，和 `@deepseek-ai/dsh-goal-round-driver` 用的是同一条路：

```js
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return;
  const agent = ctx.agents.get(session.id);
  if (agent === void 0 || agent.session !== session) return;
  if (event.data.reason.kind !== 'max-tokens') return;
  // ...
});
```

`turn/end` 的 payload 就是 `{ turn, reason }`，`reason` 是 `TurnEndReason`，
截断标记直接可读。

**刻意没有用的两条路：**

- `agent/turn-stopping`——payload 是 `{ agent, turn, signal }`，**没有 reason**，
  拿不到截断信息，只能盲发。
- 客户端 `SessionSnapshot`——字段是固定的 14 个，其中**没有** `queue`、`pending`、
  `nodes`（真实字段叫 `pendingSubmissions`）。按名字猜字段会在每次快照更新时抛
  `TypeError`；即便加了 `?.`，候选集也永远是空集，检测分支永远进不去——
  表现为「装得上、起得来、功能不触发」。

### 2. 发送时机：为什么不能直接在回调里发

`turn/end` 是从 `Session.append` **内部**广播出来的，而 `append` 在广播期间把重入
闸门打开：

```js
if (entry?.appending) throw new Error("session append cannot reenter while another append is being published");
// ...callbacks 同步运行...
finally { entry.appending = false; }   // 回调返回后才复位
```

`Agent.followup()` 本身就要 append（它得写一条 inbox splice 记录），所以从回调里
**同步**调用必然抛错：

```text
Error: session append cannot reenter while another append is being published
    at Session.append        (dsh-session)
    at ReactLoopInbox.mutate (dsh-agent-loop)
    at ReactLoopInbox.splice
```

所以发送推迟到 agent 真正 idle 之后：

```js
state.pending = true;
void sendContinuation(...);   // 内部 await agent.whenIdle() 之后才 followup
```

**为什么必须等 idle，而不是随便推迟一个 microtask？** 因为 `wakeDriver()` 只在
`phase.kind === 'idle'` 时才启动新驱动：

```js
wakeDriver(wakeAfterAbort = false) {
  if (this.phase.kind !== "idle") { /* 只有 maintenance / abort 才记 wakeRequested */ return; }
  this.setPhase({ kind: "running", ... });   // 真正开下一轮
}
```

而驱动循环在 `append("turn/end")` 之后立刻检查
`if (!this.inbox.hasPending) return false`。消息若晚于这个检查才进 inbox，驱动已经
收工，此时 `wakeDriver` 在 `running` 状态下**不会**记 `wakeRequested`，消息就躺在
inbox 里没人处理。`await agent.whenIdle()` 之后 phase 必为 `idle`，`followup()`
才会真正开出下一轮。

`state.pending` 补的就是这段窗口：发送被推迟期间 `lastTurn` 还没写，第二个
`turn/end` 会重复调度，`pending` 是那道预留，发送落定后清除。

### 3. 消息身份：为什么不用 user

`Agent.followup()` 在调用方不传 `source` 时会自己盖一个 `{ kind: 'user' }`，
而 harness 把 `user` 当作**人的授权**。自动续写冒充人，approval / ask-user
这类流程会误以为真有人在场。

所以插件发的消息 `source.kind` 是 `cordis-host-runner`——harness 在
`MessageSourceMap` 里给宿主侧自动行为预留的 source 类型：

```ts
'cordis-host-runner': { kind: 'cordis-host-runner'; };
```

聊天界面会以「插件触发」的样式渲染。一条链完整可审计。

消息本体是本地构造的，没有 import `@deepseek-ai/dsh-llm`：
`createUserMessage()` 就是 `createMessage({ ...input, role: 'user' })`，而
`brandString()` 在运行时是恒等函数（文档明确写了 branded id 无 tag、无 prototype、
无 registry），所以本地铸造的 id 完全等价。这样插件的依赖表里只剩 schema 一个，
整包可以用裸 `node --test` 跑，不需要启动 harness、不需要 mock 快照。

## 安全设计

### 三道闸

`maxConsecutive` 是主闸。`3` 是刻意的默认值：够写完一个长回答，又不至于让一个反复
溢出的模型一路烧到上下文塞满。`0` 是显式的「无上限」，属于危险选项。

`minIntervalMs` 是死循环兜底，不是节奏控制——真实模型回复本来就比它慢得多。

### 隐式保护

- inbox 里已有用户排队消息时，**让用户的先跑**（`nextTurn` / `nextStep` 非空即跳过）
- 同一个 turn 不重复续写；发送排队期间（`pending`）也不重复调度
- 非 `max-tokens` 的 turn end 一律不动，且会重置 burst 计数
- `followup()` 抛错只写日志，不往 `session/event` 回调里冒泡；发送本身推迟到
  agent idle 之后（见上文）

### 配置值不会被敲错一个数就失控

`.volatile()` 字段是从 Plugins 页面**直接写进 reference cell** 的，不走加载器的
`Config` 校验。也就是说 schema 只守住了初始组合那一次，运行期改值无人把关。

如果不加防护，在设置页把 `maxConsecutive` 敲成 `-1` 就能让它失效：
`decide()` 里 `if (maxConsecutive > 0 && ...)` 直接短路，**上限静默变成无限制**。
`minIntervalMs: -1` 同理让冷却失效。

所以 `readSettings()` 对每个字段做了类型检查 + 钳制（`LIMITS` 和 schema 共用同一份
边界常量）：

| 输入 | 结果 |
|---|---|
| `maxConsecutive: -1` / `99` / `2.5` / `'lots'` | 回落到默认 `3` |
| `maxConsecutive: 0` | 保留 `0`（显式的"无上限"是刻意选项） |
| `minIntervalMs: -50` / `7000000` | 回落到默认 `1500` |
| `continueText: 42` / `'   '` | 回落到默认 `'继续'` |
| `continueText: 'x'.repeat(400)` | 截到 200 |
| `continueText: '  trim me  '` | 去空白 → `'trim me'` |
| `enabled: 'nope'` | 回落到默认 `true` |

关键点是**负数回落到默认值，而不是回落到 `0`**。`0` 是"关掉这道闸"，一个误输的
负数不该有这个权力。

## 测试

```bash
npm test
# tests 61, pass 61, fail 0
```

61 个用例分三层：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `test/policy.test.mjs` | 17 | 纯决策逻辑，直接喂普通对象，**不 import 任何 Cordis**。burst 上限、冷却、同 turn 去重、非截断 reason、disabled 不改状态…… |
| `test/index.test.mjs` | 28 | 用 mock ctx 驱动真实的 `apply()`，断言 `agent.followup()` 收到的消息形状、冻结性、日志路径、异常边界、session 回收，以及**重入约束**（mock 在 dispatch 窗口内让 `followup` 抛错，断言窗口内零发送、idle 后恰好一次） |
| `test/contract.test.mjs` | 16 | **加载契约**，不测行为，只测"装上会不会炸"。复刻加载器 `jc()` 的逐字逻辑 |

`contract.test.mjs` 断言的具体内容：module graph 能解析、`name` / `inject` /
`Config` / `apply` 都在且类型对、`validate(undefined)` 与 `validate({})` 都不报
`issues`、返回值不是 promise、`Config["~standard"]` 存在、`package.json` 的
`main` / `dsh.bundle.patch` / `files` 全指向真实文件、依赖目录真实可读，以及
import + compose 循环 25 次都稳定。

> `test` 脚本带 `--test-isolation=none`，因为 DSH 的文件沙箱禁止
> `child_process.spawn`，而 `node --test` 默认要给每个测试文件起子进程。
> 在普通环境里用 `node --test` 也能跑。

## 已知限制

- **只认 `max-tokens`。** `aborted` / `error` / `blocked` / `interrupted` /
  `forked` 一律不动。它们要么是模型自己停的，要么是被人停的，发「继续」救不回来。
- **计数器是内存态。** 进程重启会清零，一条跨重启的链会被当成新链。
- **429 / 配额耗尽不在范围内。** 那是另一个问题域。
- **不判断模型是否真的写完了。** 它只是替你按键。如果模型陷入循环复读，
  `maxConsecutive` 会兜住轮数，但代价还是要你自己看日志确认。
- **不感知子代理。** `ctx.agents.get()` 对子代理会话同样返回 agent，所以子代理的
  截断也会被续写，共享同一套 burst 上限。如果只想管主会话，把 `maxConsecutive`
  调小或直接 `enabled: false`。

## 与 harness 原生的关系

`@deepseek-ai/dsh-goal-round-driver` 在 `turn/end` 为 `max-tokens` 时会 disarm
（取消授权）：goal 语义下，被截断意味着这轮没交付完成，不该自动进下一轮。

本插件不改变任何既有行为，只是补一条 follow-up。两者关注的层次不同：
goal driver 决定「要不要开下一轮」，本插件只处理「这一轮没写完」。可以共存。

## 故障排查

**装完没反应。** 本插件不是 `required` bundle，组合失败不会写启动日志。先在
Plugins 页面确认 `continue-on-limit` 出现，再看 `ctx.logger` 有没有
`continue-on-limit:` 开头的行。

**截断了但没续写。** 依次检查：`enabled` 是否为 `true`；`maxConsecutive` 是否已到顶
（到顶会写一条 warn）；inbox 里是否有排队的人类消息（会让给人类）。

**装完 dsh 启动就崩，`import` 阶段报错。** 有一个真实踩过的坑：**npm 的
`node_modules` 内容和 npm 缓存之间存在引用关系，删掉缓存会把装好的包打成坏的
重解析点**——目录还在，`stat` 报 `size=0`，`readdir` 直接 `ENOENT`。插件本身完全
没坏，但 dsh 一启动 `import` 就崩。

所以：装好之后**不要删 npm 缓存**。要清理就删掉 `node_modules` 重新
`npm install`。装完先跑一次 `npm test`，`contract.test.mjs` 会逐个检查每个依赖
目录及其 `package.json` 是否真实可读，并重复 import 25 次确认稳定。

**想要零依赖版本。** 删掉 `Config` 导出即可：加载器对没有 `Config` 的插件是
`if (!e.Config) return n` 直接放行。代价是失去设置页和实时切换。

## 开发

```bash
npm install --ignore-scripts
npm test
```

代码结构：

```text
lib/policy.js   纯决策逻辑，零框架依赖 —— 什么时候该发
lib/index.js    接线 —— 读事件、找 agent、发消息
cordis.patch.yml 组合声明
```

把决策逻辑剥到无框架依赖的 `policy.js` 里，是为了让「什么时候该发」这条主链路能被
裸 node 直接验证，不需要启动 harness、不需要 mock 快照。这是整个包最容易出错、
也最难在集成环境里观察的一层。

## License

[MIT](./LICENSE) © 2026 Rina
