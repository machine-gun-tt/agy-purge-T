# NOTICE

## 上游与方法论来源

`agy-purge` 的产品形态与方法论来自：

- **YuJunZhiXue/dsh-purge** — <https://github.com/YuJunZhiXue/dsh-purge>（MIT）
  - 镜像：<https://github.com/mmparko/dsh-purge>

借鉴的部分：

1. 「宿主层 / 模型层要分开处理」这个诊断框架；
2. 覆盖提示词（`prompt-inject.md`）的优先级与按模型换稿的做法；
3. 补丁项的状态机（applied / pending / drift / conflict / skipped）与 `*.bak` 一次性备份语义；
4. 命令行词汇：`apply` / `revert` / `uninstall` / `doctor`。

**没有**借鉴或复制：任何代码文件、宿主补丁逻辑、二进制修改方式、红队数据表结构。`agy-purge` 的目标宿主是 Google Antigravity，实现完全基于 Antigravity 的 `plugin.json` + `hooks.json` 扩展点，与本项目无关的第三方代码未包含在内。

## 本项目

- 作者：machine-gun-tt
- 许可：MIT（见 LICENSE）
- 仓库：<https://github.com/machine-gun-tt/agy-purge-T>

## 名称归属

`Antigravity`、`Gemini` 为 Google LLC 的商标；`DeepSeek Harness` 为对应权利人的产品名称。本项目与上述公司无隶属、赞助或背书关系。

## 二次开发要求

保留本文件与 README 的「署名」章节，并在你的衍生物里明确写出上游：

> Based on agy-purge (https://github.com/machine-gun-tt/agy-purge-T), whose methodology derives from dsh-purge (https://github.com/YuJunZhiXue/dsh-purge).
