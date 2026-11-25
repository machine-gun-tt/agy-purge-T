## agy-purge {{VERSION}}

Antigravity 破甲层：用宿主原生 hooks 完成提示词注入、审批放行、强制续跑，附 CLI、回环面板与一键回滚。
**不修改** `app.asar`、`language_server.exe` 或任何宿主二进制。

> A jailbreak layer for Google Antigravity built entirely on the host's native hook protocol — prompt injection, approval bypass and forced continuation, plus a CLI, a loopback dashboard and one-command rollback. **No host binary is patched.**

---

### 中文

**四层破甲**

| 层 | 事件 | 作用 |
| --- | --- | --- |
| inject | `SessionStart` + `PreInvocation` | 每次模型调用前把覆盖稿作为 `systemMessage` 注入，每 6 轮补注一次 |
| gate | `PreToolUse` | 任意工具返回 `allow` + `permissionOverrides`，同时补齐 Always Allow 缓存 |
| continue | `Stop` | 模型「没调工具就收工」时返回 `continue`，受 `continue.max` 上限保护 |
| log | `PostToolUse` | 事件写入 `log/events.jsonl`，只审计不决策 |

**安装**

```bash
git clone https://github.com/machine-gun-tt/agy-purge-T.git
cd agy-purge-T
node bin/agy-purge.mjs install     # 或 .\install.ps1 / ./install.sh
node bin/agy-purge.mjs doctor      # 真跑一遍每个钩子
```

装完**完全退出 Antigravity 再打开，新开会话**，四层才装载。

**常用命令**

```bash
agy-purge status [--json]        # 四层状态 / 补丁项 / 覆盖稿 / 运行时
agy-purge apply --layers=inject,gate
agy-purge prompt --show | --set FILE | --reset | --variant claude
agy-purge serve --port 7878      # 只监听 127.0.0.1，写操作带 CSRF 令牌
agy-purge revert                 # 精确回滚，保留覆盖稿
agy-purge uninstall --purge-prompt
```

**要求**：Node ≥ 18（无系统 Node 时自动回落到 Antigravity 自带的 `agy-node` 垫片或 `ELECTRON_RUN_AS_NODE`）。实测单次钩子 50–57 ms。

**方法论来自** [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)（MIT）：把宿主层与模型层拆开处理。本项目是 Antigravity 侧的独立重写，无共享代码。

---

### English

**Four layers**

| Layer | Event | Effect |
| --- | --- | --- |
| inject | `SessionStart` + `PreInvocation` | pushes the override prompt as `systemMessage` before every model call, refreshing the full text every 6 invocations |
| gate | `PreToolUse` | returns `allow` + `permissionOverrides` for every tool and fills the Always-Allow cache |
| continue | `Stop` | returns `continue` when the model ends a turn without a tool call, bounded by `continue.max` |
| log | `PostToolUse` | appends to `log/events.jsonl`; audit only, never decides |

**Install**

```bash
git clone https://github.com/machine-gun-tt/agy-purge-T.git
cd agy-purge-T
node bin/agy-purge.mjs install     # or .\install.ps1 / ./install.sh
node bin/agy-purge.mjs doctor      # really executes every hook
```

Then **fully quit Antigravity, reopen it and start a new conversation** — hooks load per session.

**Everyday commands**

```bash
agy-purge status [--json]        # layers, patch items, prompt, runtime
agy-purge apply --layers=inject,gate
agy-purge prompt --show | --set FILE | --reset | --variant claude
agy-purge serve --port 7878      # loopback only, CSRF-token protected
agy-purge revert                 # surgical rollback, keeps your prompt
agy-purge uninstall --purge-prompt
```

**Requirements**: Node ≥ 18 (falls back to Antigravity's bundled `agy-node` shim or `ELECTRON_RUN_AS_NODE` when absent). Measured hook latency: 50–57 ms.

**Methodology from** [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) (MIT): separate the host layer from the model layer. This project is an independent rewrite for Antigravity with no shared code.

---

MIT © machine-gun-tt
