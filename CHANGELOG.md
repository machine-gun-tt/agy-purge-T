# 更新日志

## v1.1.0（2026-11-25）

**主题：把 token 成本压下来，同时不牺牲破甲效果。**

### 修复

- **每轮注入导致思考链变长**：`PreInvocation` 之前每次模型调用都注入一段"常驻提醒"。现在默认 `prompt.strategy: "once"`，每个会话只注入一次；检测到上下文被压缩（`initialNumSteps` 回落）时才补注。
- **重复注入**：`SessionStart` 与首次 `PreInvocation` 会各注入一遍同一份稿。现在注入后写会话记账，后者直接跳过。
- **默认强制续跑**：`continue.max: 2` 会让每个回合最多凭空多出两次完整模型调用。续跑层改为默认**关**，需要时用 `--layers=inject,gate,continue` 显式开。
- **配置迁移**：v1 的 `config.json` 在 `apply` 时自动迁移到 v2（注入改 once、续跑改关），并在 `runtime:config` 补丁项里提示待迁移状态。
- **漂移检测漏根文件**：改过 `plugin.json` / `README` / `LICENSE` 后状态仍显示 applied。现在 `plugin:files` 覆盖根文件。

### 新增

- 项目 logo（`assets/logo.png`），已接进 `plugin.json` 的 `logo` 字段与 README。
- `agy-purge status` 新增「注入策略」「续跑」两行；`state.json` 新增按会话的注入记账。
- `agy-purge doctor` 新增 `hook:dedupe` 检查：验证同一会话第二次调用确实不再注入。
- 注入策略可切换：`once`（默认）/ `interval`（每 `fullEvery` 次）/ `every`（每次，最贵）。

### 变更

- `stop.mjs` 的续跑判定不变，但默认层关闭；`executionNum < continue.max` 上限仍在。
- 运行时配置版本号 `1 → 2`，新增 `migratedFrom` / `migratedAt`。

### 测试

48 项（v1.0 为 40 项），新增：同会话去重、SessionStart 去重、压缩补注、interval / every 策略、v1 配置迁移、续跑默认关、漂移覆盖根文件。

---

## v1.0.0（2026-11-25）

首个版本。

- 四层破甲：`SessionStart`/`PreInvocation` 注入、`PreToolUse` 放行、`Stop` 续跑、`PostToolUse` 审计。
- CLI：`status / install / apply / revert / uninstall / repair / prompt / doctor / serve / test-hook`。
- 零依赖；无系统 Node 时回落到 `agy-node` 垫片或 `ELECTRON_RUN_AS_NODE`。
- 补丁项状态机（applied / pending / drift / conflict / skipped）+ `*.agypurge.bak` 一次性备份。
- 方法论来自 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)（MIT），Antigravity 侧独立重写。
