# 架构

```
agy-purge-T/
├── plugin.json               Antigravity 插件清单（name=agy-purge）
├── hooks.json                协议默认稿；安装时会被重渲染成绝对路径版
├── hooks/                    ← 真正跑在宿主里的程序
│   ├── session-start.mjs
│   ├── pre-invocation.mjs
│   ├── pre-tool-use.mjs
│   ├── post-tool-use.mjs
│   ├── stop.mjs
│   ├── run.cmd / run.sh      手工救急用的启动垫片
│   └── lib/
│       ├── io.mjs            载荷读取、JSON 输出、看门狗、配置、提示词解析、日志
│       └── gate.mjs          PreToolUse 决策与权限令牌推导
├── rules/AGENTS.md           ★ 插件规则，启用插件即合并进规则集
├── skills/
│   ├── agy-purge/SKILL.md         操作手册（status/apply/revert/prompt）
│   └── agy-purge-drill/SKILL.md   分层定位（模型层 vs 宿主层）
├── prompts/
│   ├── override.md                 通用主稿
│   ├── override.gemini.md          Gemini 稿
│   ├── override.claude.md          Claude 稿
│   └── override.gpt.md             GPT / OSS 稿
├── lib/                      ← 只在 CLI 侧运行
│   ├── paths.mjs             路径发现（不硬编码盘符）
│   ├── runtime.mjs           解释器解析（node / agy-node / Electron-as-node）
│   ├── fsx.mjs               原子写、一次性备份、恢复、sha256
│   ├── config.mjs            config.json 读写（坏 JSON 绝不覆盖）
│   ├── prompt.mjs            覆盖稿解析与编辑
│   ├── patches.mjs           补丁项状态机 + hooks 渲染
│   ├── install.mjs           编排：install / apply / revert / uninstall / repair
│   ├── report.mjs            状态采集与终端渲染
│   ├── doctor.mjs            体检 + hook 真跑自检
│   └── server.mjs            回环面板
├── bin/agy-purge.mjs         CLI
├── test/                     node:test（40 项）
└── docs/
```

## 两条执行路径

**宿主内（hooks）**：Antigravity 在会话/工具/调用边界 spawn 我们的 `.mjs`，stdin 收 JSON、stdout 回 JSON。这条路径**不允许依赖 CLI 的 `lib/`**——`hooks/lib/` 自成一体，只做四件事：读载荷、做决策、写一行日志、吐 JSON。任何异常都退化成 `{}`。

**宿主外（CLI）**：`lib/` 负责落地与回滚：复制文件、渲染 `hooks.json`、登记 `config.json`、写 `plugin_data`。它从不参与运行时决策，所以 CLI 坏了不影响已经装好的破甲层。

## 状态机

每个补丁项的 `status()` 都是只读推导，`apply()` 幂等，`revert()` 精确：

| 状态 | 含义 | 触发 |
| --- | --- | --- |
| `applied` | 已落地且与期望一致 | — |
| `pending` | 该做还没做 | 未安装 / 未登记 / 层被关 |
| `drift` | 落地了但被改过 | 宿主升级、手改、换 Node 版本 |
| `conflict` | 没法安全处理 | 目录被别的插件占、`config.json` 坏 JSON |
| `skipped` | 本场景不适用 | `host:grants` 未启用、`project:registry` 非项目级 |

`apply` 之后一定会重算 `status`；`drift` 能自动收敛，`conflict` 永远不会被强写。

## 注入策略与会话记账（v1.2）

`PreInvocation` 不再无条件注入。判定顺序：

```
strategy = every      → 每次都注入（显式选择）
strategy = interval   → invocationNum === 0 或 % fullEvery === 0 时注入
strategy = turn(默认) → 没有记账 → 注入（first）
                        轮次指纹（lastUserInput 的 sha）变了 → 注入（new-turn）
strategy = once        → 本会话没有记账 → 注入（首次）
                        否则 initialNumSteps 明显回落（压缩）→ 补注一次
                        其余情况 → 直接返回 {}，并把步数锚点往前推
```

记账写在 `state.json` 的 `conversations[conversationId]`，字段是 `steps / turn / mode / at / source / variant`，最多保留 64 个会话（按时间淘汰）。`turn` 是 `lastUserInput` 的 sha 前 12 位——同一个用户轮次内模型可能被调用十几次，只注入一次。

为什么默认是 `turn` 而不是 `once`：宿主 2.35 之后，新模型会在每轮开头重述策略前言，`once` 的注入太靠前会被压过，表现为末尾免责声明与执行犹豫；`turn` 把注入贴在调用点前，成本仍只有每轮一次。强制续跑则直接多出完整的模型调用，所以默认关。

---

## 数据布局

```
<gemini>/config/plugins/agy-purge/          插件本体（可被 uninstall 整体删除）
<plugin_data>/agy-purge/
├── config.json      四层开关、fullEvery、continue.max、askPatterns、denyPatterns
├── prompt-inject.md 你的覆盖稿（用户文件，revert 不删）
├── state.json       安装记录、运行时、已写授权清单、会话注入记账
├── log/events.jsonl 审计（超过 maxBytes 自动轮转成 .1）
└── log/hook-errors.log
```

`<plugin_data>` 的解析：`$PLUGIN_DATA`（宿主注入）→ `<gemini>/antigravity/plugin_data/agy-purge` → `<config>/plugin_data/agy-purge`。
