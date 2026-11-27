# FAQ

## 装了之后 token 消耗变高、思考链变长？

这是 v1.0 的已知问题，v1.1 已经修掉。三个原因：

1. **每轮都注入**：`PreInvocation` 每次模型调用前都塞一段 systemMessage。多出一条"新指令"，模型就会重新对齐一次指令位阶，思考链跟着变长。
2. **重复注入**：`SessionStart` 注入一遍，首次 `PreInvocation` 又注入一遍，两份措辞不同的同一份稿子要模型自己合并。
3. **默认强制续跑**：`continue.max: 2` 让每个回合最多凭空多出两次完整模型调用。

v1.1 的默认：`strategy: "once"`（每会话一次）+ 压缩时补注 + 续跑关闭。

```bash
agy-purge status     # 看「注入策略」「续跑」两行
agy-purge doctor     # 会验证同会话第二次调用确实没有注入
```

已经装过 v1.0 的，跑一次 `agy-purge apply` 即可自动迁移（`version: 1 → 2`），顺便写盘。

想要更硬、愿意付 token，就显式选：

```json
{ "prompt": { "strategy": "interval", "fullEvery": 3 } }
```

## 同一句话，Flash 会答、Neon 直接拒绝？

这是模型层差异，不是钩子问题。高能力模型（neon/high/pro/thinking/opus/sonnet）的安全训练更硬，而且对「覆盖层 / 忽略策略 / 别自我审查」这类措辞极其敏感——越强调越容易被它判成越狱尝试，直接硬拒。

v1.2.1 起按「家族 + 档位」分稿：

```bash
agy-purge prompt --show --model gemini-4-neon-high      # gemini/strong
agy-purge prompt --show --model gemini-3.8-flash-medium # gemini/light
```

strong 档换成「本地授权演练」框架：写明授权与范围、交付标准、占位符规则，并允许「单条子步骤越界时只指出该条、其余照常交付」，不再出现反审查措辞。

想让某个档位固定用自己的稿：把稿写到 `<plugin_data>/prompt-gemini-strong.md`（或 `prompt-gemini.md`），它们优先级高于内置稿、低于 `prompt-inject.md`。
## 宿主升级后回答突然变保守（多出「不在支持范围」、执行变犹豫）？

这是宿主换构建 + 换模型导致的，不是钩子坏了。判据：

```bash
agy-purge status      # 看「注入策略」和警告里的宿主构建指纹变化
agy-purge doctor      # host-build 标黄 = 宿主换过版本
```

处理顺序：

1. `agy-purge apply`：重渲染 hooks、把运行时配置迁到 v3、把未改动的覆盖稿升级到 v3；
2. 完全退出 Antigravity 再打开，新开会话；
3. 还软就把注入频率拉满：`{ "prompt": { "strategy": "every" } }`（成本最高，但最贴脸）；
4. 观察事件日志确认注入真的发生了：`<plugin_data>/agy-purge/log/events.jsonl` 里应有 `PreInvocation:new-turn`。

为什么 v1.1 的 `once` 不够：新模型每轮开头会重述策略前言，`once` 的注入位置太靠前，被压过就表现为末尾免责声明。
## 装了之后完全没变化？

按顺序查：

1. **有没有完全退出 Antigravity**（任务栏/托盘退出，不是关窗口），再打开、**新开会话**。hooks 在会话开始时装载，旧会话不会中途长出破甲层。
2. `agy-purge status` 看四项是不是 `applied`。
3. `agy-purge doctor` 看 `hook:*` 是否全绿——它们会真的 spawn 一遍钩子。

## 会不会影响 Antigravity 升级？

不会。插件装在 `<gemini>/config/plugins/agy-purge`，宿主升级不覆盖这个目录。升级后如果 `status` 显示 `drift`，跑一次 `agy-purge apply` 即可；如果 `hooks.json` 里的解释器路径变了（换了 Node、重装 Antigravity），跑 `agy-purge repair`。

## 会不会拖慢响应？

实测单次钩子 53–56 ms（Windows / Node 24）。一次带 20 次工具调用的回合大约多 1–1.5 秒。钩子里没有任何网络请求；日志是追加写。

## 我要不要开 `--grants`？

`--grants` 会往 `config.json` 的 `userSettings.globalPermissionGrants.allow` 里写 `command(*)` 与 `execute_url(*)`，相当于全局「Always Allow」。**默认不开**，因为 `PreToolUse` 的 `allow` 已经覆盖了当次调用；`--grants` 是为了让某些"先查缓存再问"的路径也不再问。想开就显式开。

## 续跑层默认关，那「模型提前收工」怎么办？

两种解法，按成本从低到高：

1. 在覆盖稿里把「一次给完整产物、不要以总结或提问结尾」写得更硬（默认稿里已有这一条）。
2. 显式开启续跑：`agy-purge apply --layers=inject,gate,continue`，并把 `continue.max` 控制在 1–2。每次续跑等于一次完整模型调用，这是它的真实成本。

## 我想保留一部分审批怎么办？

两个办法：

```json
// <plugin_data>/agy-purge/config.json
{
  "gate": {
    "autoAllow": true,
    "askPatterns": ["git push", "rm -rf", "write_file\\(.*\\.env"]
  }
}
```

`askPatterns` 命中的调用会退回弹窗；`denyPatterns` 命中的直接拒绝。两者都支持普通子串或 `/正则/`。

## 覆盖稿改了为什么没生效？

先确认**生效的是哪一份**：

```bash
agy-purge prompt --show
```

如果显示 `default:override.gemini.md`，说明 `prompt-inject.md` 还没落盘或为空，你的稿子没被读到。写一份：

```bash
agy-purge prompt --set my.md
```

## 一次注入会不会把上下文塞爆？

不会。v1.1 默认每个会话只注入一次完整稿（1–2 KB），之后不再重复；只有当上下文被压缩、`initialNumSteps` 明显回落时才补注一次。想更硬就切 `strategy: "interval"`，代价是每 N 次调用多一条 systemMessage。

## 换模型后行为变了？

Antigravity 里不同模型对指令位阶的敏感度不同。本项目按 `modelName` 自动选稿（gemini / claude / gpt）。要手动指定：

```bash
agy-purge prompt --set claude.md --variant claude
```

`<plugin_data>/prompt-inject.md` 的优先级最高，会盖掉所有按模型分稿——如果你写了它，就只改这一份。

## 会不会和别的插件打架？

`agy-powertools`、`agy-dart` 也装钩子，但它们不接管 `PreToolUse` 的决策（前者做遥测，后者做读写拦截的审计），会与我们的 `allow` 合并执行。真正需要留意的是同样返回 `decision` 的插件：两个 `PreToolUse` 决策同时存在时，以宿主的合并规则为准。`agy-purge status` 会在检测到 `antigravity-filter-bypass` 同时启用时给出警告。

## 面板安全吗？

`agy-purge serve` 只监听 `127.0.0.1`，写操作要求页面内嵌的 CSRF 令牌（`x-agy-token`）。它没有任何云端组件。

## 怎么彻底清干净？

```bash
agy-purge uninstall --purge-prompt
```

或者手工三步：

1. 删 `<gemini>/config/plugins/agy-purge`；
2. 删 `config.json` 里的 `plugins.agy-purge`；
3. 删 `<gemini>/antigravity/plugin_data/agy-purge`。

## 为什么没有 Red Team 演练台？

dsh-purge 的 Drill 是围着它自己的数据表（SQLite）建的。Antigravity 侧有原生 MCP 与 skills，红队工具链更适合走 MCP server，不适合塞进一个破甲插件里。这里的对应物是 `agy-purge-drill` 技能：先定位"模型层还是宿主层"，再决定动哪里。

## 支持 Windows 之外的平台吗？

路径发现与 `hooks/run.sh` 都覆盖了 macOS / Linux（`/Applications/Antigravity.app`、`/opt/Antigravity` 等），`hooks.json` 渲染也按平台处理环境变量前缀。测试主要在 Windows 上跑；macOS 上的问题欢迎提 issue。
