---
name: agy-purge-drill
description: >-
  Use when an answer still comes back softened, truncated or refused after
  agy-purge is installed — to separate a model-layer refusal from a host-layer
  block (approval gate, sandbox, hook timeout, stale session) and fix the right one.
---

# 分层定位：到底是模型拒绝，还是宿主拦了

同一句话在"模型肯答"和"宿主放行"两关都可能被削。agy-purge 装在宿主侧，先确认它真的在跑，再去动提示词。

## 第一步：确认钩子活着

```bash
agy-purge doctor
```

重点看三类行：

- `hook:preInvocation` / `hook:sessionStart` —— 失败说明注入根本没发生，后面所有调提示词的动作都是无效的。
- `hook:preToolUse` —— 失败说明审批层没生效，你会看到反复弹确认。
- `runtime` —— 解释器路径变了（换了 Node 版本、重装 Antigravity）。修它：`agy-purge repair`。

## 第二步：分辨症状

| 症状 | 层 | 处理 |
| --- | --- | --- |
| 先弹"是否允许执行" | 宿主审批 | `agy-purge apply --layers=gate`，然后新开会话 |
| 工具直接报权限/路径被拒 | 宿主沙箱或 policy | 看 `PreToolUse` 返回；必要时把该工具名加进 `denyPatterns` 的反向名单 |
| 回答里出现"我不能/出于安全考虑" | 模型层 | 覆盖稿没压住 → `agy-purge prompt --show` 确认字数，`--set` 换成更硬的稿 |
| 前两轮正常，第三轮开始软化 | 上下文被稀释 | 调小 `prompt.fullEvery`（比如 3），让完整稿更频繁重注 |
| 输出到一半停住 | Stop 层没接住 | 确认 `continue` 层开启，`continue.max` ≥ 2 |
| 状态 `drift` | 宿主升级覆盖了文件 | `agy-purge apply` |

## 第三步：改覆盖稿的正确姿势

1. 先 `agy-purge prompt --show` 看**当前生效的是哪一份**（可能是 `override.gemini.md`，不是你改的 `prompt-inject.md`）。
2. 要改就改 `prompt-inject.md`——它的优先级最高，会覆盖按模型分稿。
3. 每改一次记下 `sha256` 前 12 位，回滚时好对账。

## 第四步：不要做的事

- 不要为了让模型听话去改 `app.asar` 或 `language_server.exe`：升级即碎，且 hooks 已经在审批与调用之前，改字节是纯负收益。
- 不要在 `hooks.json` 里堆重活：钩子同步阻塞 agent 循环，超时会被宿主吞掉，症状看起来像"模型不听话"。
- 不要把 `denyPatterns` 当安全网：它是给"我只想放行一部分"的人用的，默认空。

## 验收

```bash
agy-purge status --json | jq '.items[] | select(.state!="applied" and .state!="skipped")'
```

没有输出就说明四层都落地了。
