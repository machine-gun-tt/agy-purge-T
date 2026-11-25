# hooks 协议速查（agy-purge 用到的部分）

来源：Antigravity 内置 `agy-customizations` 技能的 `docs/hooks.md`。这里只列本项目真正用到的字段，以及踩过的坑。

## 通用约定

- 钩子命令：Windows 走 `cmd /c`，Unix 走 `sh -c`；**cwd 是 `hooks.json` 所在目录**。
- stdin 收一个 JSON，stdout **必须是一个 JSON 对象**；多余输出会破坏协议。
- 同步阻塞 agent 循环。超时（`timeout` 秒，默认 30）会被丢弃，看起来像"模型不听话"。
- 所有键名是 camelCase（protojson）。
- 插件内的钩子会拿到 `PLUGIN_ROOT` 与 `PLUGIN_DATA` 环境变量。

## 本项目用到的五个事件

| 事件 | 结构 | 我们的输出 |
| --- | --- | --- |
| `SessionStart` | 扁平列表 | `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}` |
| `PreInvocation` | 扁平列表 | 同上（首次/整轮全稿，其余常驻提醒） |
| `PreToolUse` | `matcher` + `hooks` 分组 | `{"decision":"allow","permissionOverrides":["command(echo hi)"]}` |
| `PostToolUse` | `matcher` + `hooks` 分组 | `{}` |
| `Stop` | 扁平列表 | `{"decision":"continue","reason":"…"}` 或 `{}` |

## PreToolUse 决策语义

| decision | 行为 |
| --- | --- |
| `allow` | 直接放行，不弹窗 |
| `deny` | 硬拦，立即失败 |
| `ask` | 弹窗，且尊重"Always Allow"缓存 |
| `force_ask` | 强制弹窗，忽略缓存 |

`permissionOverrides` 是临时授权令牌，宿主格式见 `config.json` 的 `userSettings.globalPermissionGrants.allow`，形如 `execute_url(example.com)`。本项目按工具族推导：`command(…)` / `write_file(…)` / `read_file(…)` / `execute_url(host)`；推不出来就不带令牌——`allow` 本身已经生效。

`overwrite` 字段可以改写工具参数（浅合并）。本项目**不用**它：改用户命令的副作用远大于收益。

## Stop 的边界条件

```json
{
  "executionNum": 1,
  "terminationReason": "NO_TOOL_CALL",
  "fullyIdle": true,
  "continuationActive": false,
  "error": ""
}
```

我们只在 `terminationReason === "NO_TOOL_CALL"`、`error` 为空、`executionNum < continue.max` 时续跑。`USER_CANCELED` / `ERROR` / `MAX_TOKEN_BUDGET_EXCEEDED` / `TERMINAL_*` 一律放行。

## 三个坑

1. **`systemMessage.metadata` 会炸**：部分版本（已知 2.31.0）在 metadata map 上 panic，表现为整个回合挂掉。本项目只发纯字符串。
2. **`systemMessage` 必须是嵌套对象**：写 `{"systemMessage": "文本"}` 无效，要 `{"systemMessage": {"systemMessage": "文本"}}`。
3. **钩子会阻塞**：一个 200 ms 的钩子 × 30 次工具调用 = 6 秒。所以本项目单次实测 53–56 ms，并且有 3 秒看门狗兜底。

## 自检

```bash
agy-purge doctor                 # 五个钩子全跑一遍，报耗时与决策
agy-purge test-hook Stop --payload payload.json
```

`doctor` 的 `hook:*` 行就是这条协议的直接验证：注入长度、`decision`、退出码、stdout 是否是合法 JSON。
