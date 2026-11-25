#!/usr/bin/env node
/**
 * agy-purge CLI
 *
 *   agy-purge status [--json]
 *   agy-purge install|apply [--scope user|project] [--grants|--no-grants] [--layers=a,b]
 *   agy-purge revert
 *   agy-purge uninstall [--purge-prompt] [--keep-prompt]
 *   agy-purge repair [--pin-runtime]
 *   agy-purge prompt [--show|--set FILE|--edit|--reset|--variant V]
 *   agy-purge doctor [--json] [--no-selftest]
 *   agy-purge serve [--port 7878]
 *   agy-purge test-hook <SessionStart|PreInvocation|PreToolUse|PostToolUse|Stop>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext, applyAll, revertAll, install, uninstall, repair, summarize } from '../lib/install.mjs';
import { collectStatus, renderStatus, renderApplyResults, ANSI } from '../lib/report.mjs';
import { runDoctor, renderDoctor } from '../lib/doctor.mjs';
import { resolvePromptFile, promptFile, promptStats, savePrompt, resetPrompt, listPromptFiles, VARIANT_LABEL } from '../lib/prompt.mjs';
import { HOOK_SCRIPTS, renderHooks } from '../lib/patches.mjs';
import { startServer } from '../lib/server.mjs';

const HELP = `agy-purge —— Antigravity 破甲层

用法
  agy-purge status [--json]              查看四层状态、补丁项、覆盖稿、运行时
  agy-purge install [选项]               安装并落地（= apply）
  agy-purge apply [选项]                 同上，幂等
  agy-purge revert                       精确回滚，保留覆盖稿
  agy-purge uninstall [--purge-prompt]   卸载插件并清理数据
  agy-purge repair                       升级后修复：重渲染 hooks、补回漂移文件
  agy-purge prompt [选项]                编辑覆盖稿
  agy-purge doctor [--json]              体检 + 真跑一遍所有 hook
  agy-purge serve [--port 7878]          起本地面板
  agy-purge test-hook <Event> [--payload FILE]
  agy-purge version | help

选项
  --scope user|project   装到 <gemini>/config/plugins 还是 <cwd>/.agents/plugins
  --root DIR             指定 customization 根（默认 $ANTIGRAVITY_CONFIG_DIR 或 <gemini>/config）
  --grants               同时写入 globalPermissionGrants.allow（command(*), execute_url(*)）
  --grants=a,b           只写指定的授权项
  --no-grants            不碰 config.json 的授权列表（默认）
  --layers=inject,gate   只开这几层；其余关闭
  --variant gemini|claude|gpt
  --json                 JSON 输出
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function contextOptions(args) {
  const options = {
    scope: args.scope === 'project' ? 'project' : 'user',
    cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
    root: args.root ? path.resolve(args.root) : undefined,
  };
  if (args.layers !== undefined) {
    const wanted = new Set(String(args.layers || '').split(/[,;\s]+/).filter(Boolean));
    options.layers = { inject: wanted.has('inject'), gate: wanted.has('gate'), continue: wanted.has('continue'), log: wanted.has('log') };
  }
  if (args.grants === true) options.grants = true;
  else if (typeof args.grants === 'string' && args.grants.trim()) options.grants = args.grants.split(',').map((s) => s.trim()).filter(Boolean);
  else if (args['no-grants']) options.grants = false;
  return options;
}

function printHeader(text) {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const line = color ? `${ANSI.bold}${ANSI.cyan}${text}${ANSI.reset}` : text;
  process.stdout.write(`${line}\n\n`);
}

function printLines(text) {
  if (text) process.stdout.write(`${text}\n`);
}

/* ------------------------------------------------------------------ 命令 */

function cmdStatus(args) {
  const ctx = buildContext(contextOptions(args));
  const status = collectStatus(ctx);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.counts.conflict === 0 ? 0 : 1;
  }
  printLines(renderStatus(status));
  return status.counts.conflict === 0 ? 0 : 1;
}

function cmdInstall(args, { label = 'apply' } = {}) {
  const options = contextOptions(args);
  const { ctx, results } = install(options);
  const counts = summarize(results);
  printHeader(`agy-purge · ${label}`);
  printLines(renderApplyResults(results));
  process.stdout.write('\n');
  printLines(renderStatus(collectStatus(ctx)));
  process.stdout.write('\n');
  process.stdout.write(
    [
      '下一步：',
      '  1) 完全退出 Antigravity（不是关窗口，是退出进程），再打开。',
      '  2) 新开一个会话；hooks 在会话开始时装载。',
      '  3) agy-purge doctor 体检；agy-purge serve 开面板。',
      '',
    ].join('\n'),
  );
  return counts.conflict === 0 ? 0 : 1;
}

function cmdRevert(args) {
  const ctx = buildContext(contextOptions(args));
  const results = revertAll(ctx);
  printHeader('agy-purge · revert');
  printLines(renderApplyResults(results));
  return 0;
}

function cmdUninstall(args) {
  const { ctx, results } = uninstall({ ...contextOptions(args), purgePrompt: Boolean(args['purge-prompt']) });
  printHeader('agy-purge · uninstall');
  printLines(renderApplyResults(results));
  process.stdout.write(`\n覆盖稿${args['purge-prompt'] ? '已删除' : '已保留'}：${promptFile(ctx.dataDir)}\n`);
  return 0;
}

function cmdRepair(args) {
  const ctx = buildContext(contextOptions(args));
  const results = applyAll(ctx, { items: ['plugin:files', 'plugin:hooks', 'plugin:registered', 'runtime:config'] });
  printHeader('agy-purge · repair');
  printLines(renderApplyResults(results));
  return 0;
}

function cmdPrompt(args) {
  const ctx = buildContext(contextOptions(args));
  const variant = typeof args.variant === 'string' ? args.variant : null;

  if (args.reset) {
    const file = resetPrompt(ctx.dataDir, ctx.repoRoot, { variant });
    process.stdout.write(`已重置：${file}\n`);
    return 0;
  }
  if (args.set) {
    const source = path.resolve(String(args.set));
    const text = fs.readFileSync(source, 'utf8');
    const file = savePrompt(ctx.dataDir, text, { variant });
    const stats = promptStats(text);
    process.stdout.write(`已写入 ${file}（${stats.chars} 字符 · ${stats.sha256.slice(0, 12)}）\n`);
    return 0;
  }
  if (args.edit) {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const target = promptFile(ctx.dataDir);
    if (!fs.existsSync(target)) savePrompt(ctx.dataDir, resolvePromptFile(ctx.dataDir, ctx.repoRoot).text);
    const res = spawnSync(editor, [target], { stdio: 'inherit', windowsVerbatimArguments: process.platform === 'win32' });
    process.stdout.write(`编辑器退出码 ${res.status ?? '?'}：${target}\n`);
    return res.status === 0 ? 0 : 1;
  }

  const resolved = resolvePromptFile(ctx.dataDir, ctx.repoRoot, { variant: variant || 'auto' });
  const stats = promptStats(resolved.text);
  if (args.show || !args.json) {
    process.stdout.write(`# 生效中的覆盖稿：${resolved.source}（${stats.chars} 字符 · ${stats.lines} 行）\n`);
    process.stdout.write(`# 文件：${resolved.file || '(无)'}\n\n`);
    process.stdout.write(`${resolved.text}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ...resolved, ...stats, files: listPromptFiles(ctx.dataDir) }, null, 2)}\n`);
  }
  return 0;
}

function cmdDoctor(args) {
  const ctx = buildContext(contextOptions(args));
  const report = runDoctor(ctx, { selfTest: args['no-selftest'] ? false : true });
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    printHeader('agy-purge · 体检');
    printLines(renderDoctor(report));
  }
  return report.ok ? 0 : 1;
}

async function cmdServe(args) {
  const ctx = buildContext(contextOptions(args));
  printHeader('agy-purge · 面板');
  const server = await startServer({ ...contextOptions(args), port: args.port });
  process.stdout.write(`面板已启动：${server.url}\n仅监听回环地址，关闭窗口不会停服；Ctrl+C 退出。\n`);
  const status = collectStatus(ctx);
  process.stdout.write(`当前：applied ${status.counts.applied} · pending ${status.counts.pending} · drift ${status.counts.drift}\n`);
  await new Promise(() => {});
  return 0;
}

function cmdTestHook(args) {
  const event = String(args._[1] || args.event || '').trim();
  if (!event) {
    process.stderr.write('用法：agy-purge test-hook PreToolUse [--payload FILE]\n');
    return 2;
  }
  const script = HOOK_SCRIPTS.find((s) => s.event.toLowerCase() === event.toLowerCase());
  if (!script) {
    process.stderr.write(`未知事件：${event}（可选：${HOOK_SCRIPTS.map((s) => s.event).join(' / ')}）\n`);
    return 2;
  }
  const ctx = buildContext(contextOptions(args));
  const payload = args.payload
    ? JSON.parse(fs.readFileSync(path.resolve(String(args.payload)), 'utf8'))
    : {
        conversationId: 'probe-conversation',
        workspacePaths: [process.cwd()],
        modelName: 'gemini-3-pro',
        lastUserInput: 'probe',
        cwd: process.cwd(),
        invocationNum: 0,
        executionNum: 1,
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        toolCall: { id: 'toolu_probe', name: 'run_command', args: { CommandLine: 'echo agy-purge' } },
        stepIdx: 0,
      };
  const scriptPath = path.join(ctx.installDir, script.file.split('/').join(path.sep));
  const target = fs.existsSync(scriptPath) ? scriptPath : path.join(ctx.repoRoot, script.file.split('/').join(path.sep));
  const res = spawnSync(ctx.runtime?.bin || process.execPath, [target], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: path.dirname(path.dirname(target)),
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...(ctx.runtime?.env || {}) },
  });
  process.stdout.write(`事件 ${script.event} → ${target}\n`);
  process.stdout.write(`退出码 ${res.status ?? '?'}${res.signal ? ` (${res.signal})` : ''}\n`);
  process.stdout.write(`stdout: ${String(res.stdout || '').trim() || '(空)'}\n`);
  if (res.stderr) process.stdout.write(`stderr: ${String(res.stderr).trim()}\n`);
  return res.status === 0 ? 0 : 1;
}

function cmdHooksPreview(args) {
  const ctx = buildContext(contextOptions(args));
  process.stdout.write(`${JSON.stringify(renderHooks(ctx.installDir, ctx.runtime, ctx.layers), null, 2)}\n`);
  return 0;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  const isCommand = first && !first.startsWith('-');
  const command = isCommand ? first : 'status';
  const args = parseArgs(isCommand ? argv.slice(1) : argv);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case 'version':
    case '--version':
    case '-v': {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      process.stdout.write(`agy-purge ${pkg.version} · node ${process.version} · ${os.platform()} ${os.arch()}\n`);
      return 0;
    }
    case 'status':
      return cmdStatus(args);
    case 'install':
    case 'apply':
      return cmdInstall(args, { label: command });
    case 'revert':
    case 'restore':
      return cmdRevert(args);
    case 'uninstall':
      return cmdUninstall(args);
    case 'repair':
      return cmdRepair(args);
    case 'prompt':
      return cmdPrompt(args);
    case 'doctor':
    case 'check':
      return cmdDoctor(args);
    case 'serve':
    case 'ui':
      return cmdServe(args);
    case 'test-hook':
      return cmdTestHook(args);
    case 'hooks-preview':
      return cmdHooksPreview(args);
    default:
      process.stderr.write(`未知命令：${command}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
  })
  .catch((error) => {
    process.stderr.write(`agy-purge 出错：${error?.stack || error}\n`);
    process.exitCode = 1;
  });
