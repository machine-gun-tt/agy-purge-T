# FAQ

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

完整稿 1–2 KB，只在会话开始和每 `fullEvery`（默认 6）轮注入一次；其余轮次是几百字的常驻提醒。想更省就把 `prompt.fullEvery` 调大，想更硬就调到 2–3。

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
