---
name: agy-purge
description: >-
  Use when the user asks about agy-purge itself — checking which purge layers are
  active, toggling injection/approval/continue layers, editing the override
  prompt, running the hook self-test, or rolling the purge back on this machine.
---

# agy-purge 操作手册

agy-purge 用 Antigravity 原生 hooks 实现四层破甲，不改宿主二进制：

| 层 | 事件 | 作用 |
| --- | --- | --- |
| inject | `SessionStart` + `PreInvocation` | 每次模型调用前注入覆盖稿 |
| gate | `PreToolUse` | 全部工具返回 `allow` + 权限令牌 |
| continue | `Stop` | 模型偷懒收工时强制续跑 |
| log | `PostToolUse` | 事件审计日志 |

## 常用命令

1. 看状态：`agy-purge status`（要 JSON 加 `--json`）
2. 体检（真的跑一遍每个 hook）：`agy-purge doctor`
3. 只开部分层：`agy-purge apply --layers=inject,gate`
4. 改覆盖稿：`agy-purge prompt --show` 查看，`agy-purge prompt --set <file>` 写入，`agy-purge prompt --reset` 复位
5. 回滚：`agy-purge revert`（保留覆盖稿）；`agy-purge uninstall --purge-prompt` 连覆盖稿一起删
6. 面板：`agy-purge serve --port 7878`（只监听 127.0.0.1）

## 关键路径

- 插件目录：`<customization>/plugins/agy-purge`
- 运行时配置：`<plugin_data>/config.json`（四层开关、`fullEvery`、`continue.max`、`askPatterns`、`denyPatterns`）
- 覆盖稿：`<plugin_data>/prompt-inject.md`
- 事件日志：`<plugin_data>/log/events.jsonl`

## 排障顺序

1. `agy-purge doctor` 看哪一层 fail；`hook:*` 项失败通常是 Node 运行时路径变了 → `agy-purge repair`。
2. 状态显示 `drift` → `agy-purge apply` 补回文件。
3. `config.json` 解析失败（`conflict`）→ 先手工修好 JSON，插件拒绝在坏 JSON 上写入。
4. 改了层开关或覆盖稿之后**不需要**重启 Antigravity，下一次调用即生效；改了 `hooks.json` 才需要新开会话。

## 边界

只在用户自己的机器上操作 Antigravity 的 customization 目录与 plugin_data。不要把它当跳板去打别的系统，也不要顺手改别的插件目录。
