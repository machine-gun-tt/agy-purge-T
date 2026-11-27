/**
 * agy-purge — 体检
 *
 * 除了静态检查，还会**真的把每个 hook 跑一遍**：用协议里的样例载荷喂 stdin，
 * 检查 stdout 是不是一个合法 JSON 且符合预期的决策形状。宿主里出问题时，
 * 这一步通常直接指出是哪一层坏了。
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { exists, isDir, isFile, readJson } from './fsx.mjs';
import { statusAll } from './install.mjs';
import { hostFingerprint } from './paths.mjs';
import { readState } from './patches.mjs';
import { HOOK_SCRIPTS, readRuntimeConfig } from './patches.mjs';
import { promptFile } from './prompt.mjs';

const SAMPLE = {
  conversationId: '00000000-0000-4000-8000-000000000000',
  workspacePaths: ['/tmp/workspace'],
  modelName: 'gemini-3-pro',
  lastUserInput: '帮我跑一遍体检',
  cwd: process.cwd(),
  invocationNum: 0,
  initialNumSteps: 0,
  executionNum: 1,
  terminationReason: 'NO_TOOL_CALL',
  fullyIdle: true,
  continuationActive: false,
  toolCall: { id: 'toolu_probe', name: 'run_command', args: { CommandLine: 'echo agy-purge' } },
  stepIdx: 0,
};

function runHookOnce(runtime, installDir, script, payload, timeout = 8000) {
  const started = Date.now();
  const scriptPath = path.join(installDir, script.file.split('/').join(path.sep));
  if (!isFile(scriptPath)) {
    return { ok: false, detail: `脚本缺失：${scriptPath}`, ms: 0, raw: '' };
  }
  const res = spawnSync(runtime.bin, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    cwd: installDir,
    env: { ...process.env, ...(runtime.env || {}) },
  });
  const ms = Date.now() - started;
  if (res.error) return { ok: false, detail: `启动失败：${res.error.message}`, ms, raw: '' };
  const raw = String(res.stdout || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, detail: `stdout 不是 JSON：${raw.slice(0, 120) || '(空)'}`, ms, raw };
  }
  return { ok: true, detail: 'JSON 合法', ms, raw, parsed, stderr: String(res.stderr || '').trim() };
}

function expect(condition, detail) {
  return condition ? { state: 'pass', detail } : { state: 'fail', detail };
}

export function runDoctor(ctx, { selfTest = true } = {}) {
  const checks = [];
  const add = (id, title, state, detail, ms = null) => checks.push({ id, title, state, detail, ms });
  const items = statusAll(ctx);
  const states = Object.fromEntries(items.map((i) => [i.id, i.state]));

  add('host', 'Antigravity 安装', ctx.host ? 'pass' : 'warn', ctx.host ? ctx.host.root : '未检测到（仅影响信息展示，破甲层仍可安装）');
  const fingerprint = hostFingerprint(ctx.host);
  const appliedFingerprint = readState(ctx.dataDir).host?.id || null;
  add(
    'host-build',
    '宿主构建指纹',
    !fingerprint ? 'warn' : appliedFingerprint && appliedFingerprint !== fingerprint.id ? 'warn' : 'pass',
    !fingerprint
      ? '读不到 app.asar'
      : `${fingerprint.id}${appliedFingerprint && appliedFingerprint !== fingerprint.id ? '（与上次 apply 不同：宿主已升级，跑 agy-purge apply）' : ''}`,
  );
  add(
    'antigravity-config',
    '定制根可写',
    isDir(ctx.configRoot) && fs.existsSync(ctx.configRoot) ? 'pass' : 'warn',
    ctx.configRoot,
  );

  const cfg = loadConfig(ctx.configRoot);
  add(
    'config-json',
    'config.json 可解析',
    cfg.corrupt ? 'fail' : 'pass',
    cfg.corrupt ? `解析失败：${cfg.file}（修复前不会写任何东西）` : cfg.exists ? cfg.file : '不存在（首次 apply 会创建）',
  );

  const runtimeCfgState = readRuntimeConfig(ctx.dataDir);
  add(
    'runtime-config',
    'hooks 配置可解析',
    runtimeCfgState.corrupt ? 'fail' : 'pass',
    runtimeCfgState.corrupt
      ? `解析失败：${runtimeCfgState.file}（钩子会退回内置默认值，尽快修复）`
      : runtimeCfgState.exists
        ? `v${runtimeCfgState.data?.version ?? 3} · 注入 ${runtimeCfgState.data?.prompt?.strategy || 'turn'}`
        : '尚未生成（首次调用会用内置默认值）',
  );

  add(
    'runtime',
    'Node 运行时',
    ctx.runtime?.ok ? 'pass' : 'fail',
    ctx.runtime?.ok ? `${ctx.runtime.note} · v${ctx.runtime.version} · ${ctx.runtime.bin}` : `不可用：${ctx.runtime?.note}`,
  );

  add('plugin-files', '插件文件', states['plugin:files'] === 'applied' ? 'pass' : states['plugin:files'] === 'drift' ? 'warn' : 'fail', items.find((i) => i.id === 'plugin:files')?.detail || '');

  const hooksFile = path.join(ctx.installDir, 'hooks.json');
  const hooksData = readJson(hooksFile);
  const commandCount = hooksData
    ? Object.values(hooksData).reduce(
        (sum, group) =>
          sum +
          Object.entries(group || {})
            .filter(([k]) => k !== 'enabled')
            .reduce((n, [, value]) => n + (Array.isArray(value) ? value.length : 0), 0),
        0,
      )
    : 0;
  add('hooks-json', 'hooks.json', hooksData ? 'pass' : 'fail', hooksData ? `${commandCount} 个事件处理组 · ${hooksFile}` : `缺失或不可解析：${hooksFile}`);

  const promptText = fs.existsSync(promptFile(ctx.dataDir)) ? fs.readFileSync(promptFile(ctx.dataDir), 'utf8') : '';
  add('prompt', '覆盖稿', promptText.trim() ? 'pass' : 'warn', promptText.trim() ? `${promptText.length} 字符 · ${promptFile(ctx.dataDir)}` : `未落盘或为空：${promptFile(ctx.dataDir)}`);

  if (selfTest && ctx.runtime?.ok && ['applied', 'drift'].includes(states['plugin:files'])) {
    const runtimeCfg = readRuntimeConfig(ctx.dataDir).data || {};
    const stopEnabled = ctx.layers?.continue !== false && Number(runtimeCfg.continue?.max) > 0;
    const probeId = `probe-${crypto.randomUUID()}`;
    for (const script of HOOK_SCRIPTS) {
      // 每个事件用独立会话 id：SessionStart 会写会话记账，共用 id 会让 PreInvocation 合理地跳过
      const convId = `${probeId}-${script.key}`;
      const payload =
        script.key === 'stop'
          ? { ...SAMPLE, conversationId: convId, executionNum: 1, terminationReason: 'NO_TOOL_CALL', error: '' }
          : script.key === 'preToolUse'
            ? { ...SAMPLE, conversationId: convId, toolCall: { id: 'toolu_probe', name: 'run_command', args: { CommandLine: 'echo hi' } } }
            : { ...SAMPLE, conversationId: convId };
      const run = runHookOnce(ctx.runtime, ctx.installDir, script, payload);
      if (!run.ok) {
        add(`hook:${script.key}`, `钩子 ${script.event}`, 'fail', run.detail, run.ms);
        continue;
      }
      let verdict;
      if (script.key === 'sessionStart') {
        const injected = run.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
        verdict =
          runtimeCfg.prompt?.sessionStart === true
            ? expect(typeof injected === 'string' && injected.trim().length > 0, injected ? `注入 ${injected.length} 字符` : '没有 injectSteps')
            : expect(run.parsed?.injectSteps === undefined, 'SessionStart 默认不注入（正确）');
      } else if (script.key === 'preInvocation') {
        const injected = run.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
        verdict = expect(typeof injected === 'string' && injected.trim().length > 0, injected ? `注入 ${injected.length} 字符` : '没有 injectSteps');
      } else if (script.key === 'preToolUse') {
        const decision = run.parsed?.decision;
        verdict = expect(decision === 'allow', `decision=${decision ?? '未给出'}`);
      } else if (script.key === 'stop') {
        verdict = stopEnabled
          ? expect(run.parsed?.decision === 'continue', `decision=${run.parsed?.decision ?? '未续跑'}（续跑层已开，上限 ${runtimeCfg.continue?.max}）`)
          : expect(run.parsed?.decision === undefined, `decision=${run.parsed?.decision ?? '未续跑'}（续跑层默认关，正确）`);
      } else {
        verdict = expect(JSON.stringify(run.parsed) === '{}' || run.parsed !== null, `输出 ${JSON.stringify(run.parsed).slice(0, 60)}`);
      }
      add(`hook:${script.key}`, `钩子 ${script.event}`, verdict.state, verdict.detail, run.ms);
      if (run.stderr) add(`hook:${script.key}:stderr`, `钩子 ${script.event} stderr`, 'warn', run.stderr.slice(0, 300));
    }

    // 去重验证：同一轮内第二次调用必须不再注入；换了用户输入则必须重新注入
    const dedupeConv = `${probeId}-dedupe`;
    const preInvocation = HOOK_SCRIPTS.find((s) => s.key === 'preInvocation');
    const first = runHookOnce(ctx.runtime, ctx.installDir, preInvocation, { ...SAMPLE, conversationId: dedupeConv, invocationNum: 0, lastUserInput: 'probe-turn-A' });
    const second = runHookOnce(ctx.runtime, ctx.installDir, preInvocation, { ...SAMPLE, conversationId: dedupeConv, invocationNum: 1, lastUserInput: 'probe-turn-A' });
    const third = runHookOnce(ctx.runtime, ctx.installDir, preInvocation, { ...SAMPLE, conversationId: dedupeConv, invocationNum: 0, lastUserInput: 'probe-turn-B' });
    const firstInjected = Boolean(first.parsed?.injectSteps?.length);
    const secondInjected = Boolean(second.parsed?.injectSteps?.length);
    const thirdInjected = Boolean(third.parsed?.injectSteps?.length);
    const strategy = String(runtimeCfg.prompt?.strategy || 'turn');
    const dedupeApplies = strategy === 'turn' || strategy === 'once';
    const dedupeOk = dedupeApplies ? firstInjected && !secondInjected && thirdInjected : true;
    add(
      'hook:dedupe',
      '轮内去重',
      !dedupeApplies ? 'skip' : dedupeOk ? 'pass' : 'fail',
      !dedupeApplies
        ? `strategy=${strategy}：每次调用都会注入，不做去重断言`
        : dedupeOk
          ? '同轮第二次不再注入；新轮次重新注入'
          : `首轮=${firstInjected} 同轮第二次=${secondInjected}（期望 false） 新轮=${thirdInjected}（期望 true）`,
      first.ms + second.ms + third.ms,
    );
  } else if (selfTest) {
    add('hook:self-test', '钩子自检', 'skip', '插件未安装或运行时不可用，跳过自检');
  }

  const conflicts = items.filter((i) => i.state === 'conflict');
  if (conflicts.length) add('conflicts', '冲突项', 'fail', conflicts.map((c) => `${c.id}: ${c.detail}`).join(' | '));

  const failed = checks.filter((c) => c.state === 'fail').length;
  const warned = checks.filter((c) => c.state === 'warn').length;
  return { ok: failed === 0, failed, warned, checks };
}

export function renderDoctor(report, { color = process.stdout.isTTY && !process.env.NO_COLOR } = {}) {
  const mark = { pass: ['✓', 'green'], warn: ['!', 'yellow'], fail: ['✗', 'red'], skip: ['·', 'gray'] };
  const c = (code) => (color ? `\u001b[${code}m` : '');
  const reset = color ? '\u001b[0m' : '';
  const lines = [];
  for (const check of report.checks) {
    const [glyph, tone] = mark[check.state] || ['?', 'gray'];
    const toneCode = { green: '32', yellow: '33', red: '31', gray: '90' }[tone];
    const timing = typeof check.ms === 'number' ? `${c('90')}${String(check.ms).padStart(4)}ms${reset} ` : '       ';
    lines.push(`${c(toneCode)}${glyph}${reset} ${timing}${check.title.padEnd(22)} ${check.detail}`);
  }
  lines.push('');
  lines.push(`结果：${report.ok ? '通过' : '有失败项'}（fail ${report.failed} · warn ${report.warned}）`);
  return lines.join('\n');
}
