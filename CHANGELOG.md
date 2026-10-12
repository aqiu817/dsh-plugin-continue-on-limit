# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-13

首个公开版本。

### Added

- 宿主侧 `session/event` 监听，只认 `turn/end` 的 `reason.kind === 'max-tokens'`
- 通过 `agent.followup()` 发送下一个 turn 的续写提示词，`source.kind` 为
  `cordis-host-runner`，不冒充人类输入
- 三道闸：`maxConsecutive`（默认 `3`）、`minIntervalMs`（默认 `1500`）、`enabled`
- 四个配置字段全部 `.volatile()`，Plugins 页面实时生效，不重载 fiber
- inbox 里已有排队的人类消息时，让给人类先跑
- 同一个 turn 去重；发送排队期间（`pending`）不重复调度
- `readSettings()` 对每个字段做类型检查与钳制，**负数回落到默认值而非 `0`**
- 61 个测试，分决策逻辑 / 接线 / 加载契约三层

### Notes

- 续写必须等 agent 真正 idle 之后才能发出：`turn/end` 是从 `Session.append` 内部
  广播的，广播期间 `append` 的重入闸门处于打开状态，而 `followup()` 自身需要
  append（写 inbox splice）。同步发送会被拒绝为
  `session append cannot reenter while another append is being published`。
  详见 README 的「发送时机」一节。
- 只推迟一个 microtask 是不够的：驱动循环在 `append("turn/end")` 之后立刻检查
  `inbox.hasPending`，而 `wakeDriver()` 只在 `phase.kind === 'idle'` 时才启动新
  驱动。因此必须 `await agent.whenIdle()`。

[Unreleased]: https://github.com/aqiu817/dsh-plugin-continue-on-limit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aqiu817/dsh-plugin-continue-on-limit/releases/tag/v0.1.0
